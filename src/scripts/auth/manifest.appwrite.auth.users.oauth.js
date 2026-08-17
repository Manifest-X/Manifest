/* Auth OAuth */

// Add OAuth methods to auth store
function initializeOAuth() {
    if (typeof Alpine === 'undefined') {
        return;
    }

    const config = window.ManifestAppwriteAuthConfig;
    if (!config) {
        return;
    }

    // Wait for store to be initialized
    const waitForStore = () => {
        const store = Alpine.store('auth');
        if (store && !store.loginOAuth) {
            // Appwrite validates provider strings server-side; no registry needed here
            store.loginOAuth = async function (provider, successUrl = window.location.href, failureUrl = window.location.href) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                // Check if OAuth is enabled
                const appwriteConfig = await config.getAppwriteConfig();
                if (appwriteConfig && !appwriteConfig.oauth) {
                    return { success: false, error: 'OAuth authentication is not enabled' };
                }

                // Use origin + pathname for success/failure URLs to avoid query params
                const currentUrl = new URL(window.location.href);
                const cleanSuccessUrl = `${currentUrl.origin}${currentUrl.pathname}`;
                const cleanFailureUrl = `${currentUrl.origin}${currentUrl.pathname}`;

                // Drop anonymous sessions before OAuth — except with guestUpgrade, where the
                // session stays so Appwrite links the OAuth identity to it (preserving teams)
                if (this.isAnonymous && this.session && !appwriteConfig?.guestUpgrade) {
                    try {
                        await this._appwrite.account.deleteSession(this.session.$id);
                        this.session = null;
                        this.user = null;
                        this.isAuthenticated = false;
                        this.isAnonymous = false;
                    } catch (error) {
                        console.warn('[Manifest Appwrite Auth] Failed to delete anonymous session before OAuth:', error);
                        // Continue anyway - OAuth should still work
                    }
                }

                // Set flag in sessionStorage to detect OAuth callback (cleared after callback)
                sessionStorage.setItem('manifest:oauth:redirect', 'true');

                // Store the provider name so we can retrieve it after callback
                // session.provider returns "oauth2" generically, but we know the specific provider
                this._oauthProvider = provider;
                // Use localStorage for provider (persists across redirects, cleared on logout)
                // sessionStorage can be cleared by some browsers during OAuth redirects
                try {
                    localStorage.setItem('manifest:oauth:provider', provider);
                } catch (e) {
                    // Fallback to sessionStorage if localStorage fails
                    sessionStorage.setItem('manifest:oauth:provider', provider);
                }

                this.inProgress = true;
                this.error = null;

                try {
                    // createOAuth2Token returns a URL we navigate to; Appwrite redirects
                    // back with userId + secret in URL params
                    const token = await this._appwrite.account.createOAuth2Token(
                        provider,
                        cleanSuccessUrl,
                        cleanFailureUrl,
                        ['email'] // Scopes
                    );

                    // Appwrite may return the redirect URL in several formats
                    let redirectUrl = null;

                    if (typeof token === 'string') {
                        redirectUrl = token;
                    } else if (token?.redirectUrl) {
                        redirectUrl = token.redirectUrl;
                    } else if (token?.url) {
                        redirectUrl = token.url;
                    } else if (token && typeof token === 'object') {
                        // Try to find any URL-like property in the object
                        const possibleUrl = Object.values(token).find(v => typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://')));
                        if (possibleUrl) {
                            redirectUrl = possibleUrl;
                        }
                    }

                    // Clear error before redirect to avoid an error flash
                    this.error = null;

                    if (redirectUrl) {
                        // rAF lets Alpine process the error clear before navigating
                        requestAnimationFrame(() => {
                            window.location.href = redirectUrl;
                        });
                        return { success: true, redirectUrl: redirectUrl };
                    } else {
                        // No extractable URL: warn but stay silent — Appwrite's own redirect may still fire
                        console.warn('[Manifest Appwrite Auth] Could not extract redirect URL from token:', token);
                        this.inProgress = false;
                        return { success: false, error: 'Could not extract redirect URL' };
                    }
                } catch (error) {
                    // "No redirect URL" errors are usually false positives; surface the rest
                    if (!error.message.includes('No redirect URL') && !error.message.includes('redirect')) {
                        this.error = error.message;
                        this.inProgress = false;
                    } else {
                        // For redirect-related errors, just log and don't show to user
                        console.warn('[Manifest Appwrite Auth] OAuth redirect error (suppressed from UI):', error.message);
                        this.error = null;
                        this.inProgress = false;
                    }
                    return { success: false, error: error.message };
                }
            };
        } else if (!store) {
            // Wait a bit more for store to initialize
            setTimeout(waitForStore, 50);
        }
    };

    // Start waiting after a short delay to ensure store is ready
    setTimeout(waitForStore, 100);
}

// Handle OAuth callbacks via events
function handleOAuthCallbacks() {
    // Handle OAuth callback
    window.addEventListener('manifest:auth:callback:oauth', async (event) => {
        const store = Alpine.store('auth');
        if (!store) return;

        const callbackInfo = event.detail;

        // Clear OAuth redirect flag
        sessionStorage.removeItem('manifest:oauth:redirect');

        // Restore OAuth provider name from localStorage (set during loginOAuth)
        // Try localStorage first (persists across redirects), fallback to sessionStorage
        let storedProvider = null;
        try {
            storedProvider = localStorage.getItem('manifest:oauth:provider');
        } catch (e) {
            // If localStorage fails, try sessionStorage
            storedProvider = sessionStorage.getItem('manifest:oauth:provider');
        }
        if (storedProvider) {
            store._oauthProvider = storedProvider;
            // Stays in localStorage until logout so the provider name survives refresh
        } else {
            console.warn('[Manifest Appwrite Auth] No OAuth provider found in storage');
        }

        // OAuth uses userId/secret just like magic links - create session manually
        // The "prohibited" error means session already exists, so try to fetch user first
        if (!store._appwrite) {
            store._appwrite = await window.ManifestAppwriteAuthConfig.getAppwriteClient();
        }

        if (!store._appwrite) {
            store.error = 'Appwrite not configured';
            return;
        }

        store.inProgress = true;
        store.error = null;
        store.magicLinkExpired = false;
        store.magicLinkSent = false;

        try {
            const appwriteConfig = await window.ManifestAppwriteAuthConfig.getAppwriteConfig();
            const upgradingGuest = !!(appwriteConfig?.guestUpgrade && store.isAnonymous);
            // A guest being replaced (not upgraded) by a different account — its team
            // state must be cleared before loading the new user's teams.
            const replacingGuest = store.isAnonymous && !upgradingGuest;

            // Delete the existing anonymous session first — UNLESS we're upgrading the
            // guest in place, in which case Appwrite linked the OAuth identity to that
            // account and the "prohibited" branch below reuses the upgraded session.
            if (store.session && store.isAnonymous && !upgradingGuest) {
                try {
                    await store._appwrite.account.deleteSession(store.session.$id);
                } catch (deleteError) {
                    // Could not delete anonymous session
                }
            }

            // Try to create session from OAuth credentials
            try {
                const session = await store._appwrite.account.createSession(callbackInfo.userId, callbackInfo.secret);
                store.session = session;
                store.user = await store._appwrite.account.get();
                store.isAuthenticated = true;
                store.isAnonymous = false;
                store.magicLinkSent = false;
                store.magicLinkExpired = false;
                store.error = null;
            } catch (createError) {
                // If "prohibited" error, session already exists - just fetch user
                const isProhibited = createError.message?.includes('prohibited');
                if (isProhibited) {
                    store.user = await store._appwrite.account.get();
                    try {
                        const sessionsResponse = await store._appwrite.account.listSessions();
                        const allSessions = sessionsResponse.sessions || [];
                        const oauthSession = allSessions.find(s => s.provider !== 'anonymous' && s.provider !== 'magic-url') || allSessions.find(s => s.current === true);
                        if (oauthSession) {
                            store.session = oauthSession;
                        } else if (allSessions.length > 0) {
                            store.session = allSessions[0];
                        } else {
                            store.session = await store._appwrite.account.getSession('current');
                        }
                    } catch (sessionError) {
                        console.warn('[Manifest Appwrite Auth] Could not get session info:', sessionError);
                    }
                    store.isAuthenticated = true;
                    store.isAnonymous = false;
                    store.magicLinkSent = false;
                    store.magicLinkExpired = false;
                    store.error = null;
                } else {
                    throw createError;
                }
            }

            // Replacing a guest with a different account: drop the guest's stale team
            // state so listTeams doesn't query teams the new user can't access.
            if (replacingGuest && store._resetTeamsState) {
                store._resetTeamsState();
            }

            // Sync state
            if (store._syncStateToStorage) {
                store._syncStateToStorage(store);
            }

            // Load teams if enabled (and seed any configured default teams)
            if (appwriteConfig?.teams && store.listTeams) {
                try {
                    await store._loadTeamsAndSeed(appwriteConfig);
                } catch (teamsError) {
                    console.warn('[Manifest Appwrite Auth] Failed to load teams after OAuth login:', teamsError);
                    // Don't fail login if teams fail to load
                }
            }

            window.dispatchEvent(new CustomEvent('manifest:auth:login', {
                detail: { user: store.user }
            }));
        } catch (error) {
            store.error = error.message;
            store.isAuthenticated = false;
            store.isAnonymous = false;

            // Sync state
            if (store._syncStateToStorage) {
                store._syncStateToStorage(store);
            }
        } finally {
            store.inProgress = false;
        }
    });
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeOAuth();
        handleOAuthCallbacks();
    } catch (error) {
        // Failed to initialize OAuth
    }
});

// Export OAuth interface
window.ManifestAppwriteAuthOAuth = {
    initialize: initializeOAuth,
    handleCallbacks: handleOAuthCallbacks
};