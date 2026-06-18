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
            // Add OAuth method to store
            // Note: Appwrite accepts any provider string (google, github, etc.) and validates on their side
            // No need to maintain a registry of supported providers
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

                // Delete any existing anonymous sessions before OAuth
                // This prevents conflicts where anonymous sessions might interfere with OAuth
                // Appwrite will create a new account for OAuth if needed.
                // EXCEPTION: when guest upgrade is enabled we keep the anonymous session
                // active so Appwrite can link the OAuth identity to it (preserving teams).
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
                    // Use createOAuth2Token (like the working implementation)
                    // This returns a token/redirect URL that we manually navigate to
                    // After OAuth, Appwrite redirects back with userId and secret in URL params
                    const token = await this._appwrite.account.createOAuth2Token(
                        provider,
                        cleanSuccessUrl,
                        cleanFailureUrl,
                        ['email'] // Scopes
                    );

                    // Check for redirectUrl - Appwrite may return it in various formats
                    // Try multiple property names and formats
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

                    // Clear error state before redirect (whether we found URL or not)
                    // This prevents any error flash before redirect
                    this.error = null;

                    if (redirectUrl) {
                        // Use requestAnimationFrame to ensure Alpine processes the error clearing
                        // before redirect happens, preventing error flash
                        requestAnimationFrame(() => {
                            window.location.href = redirectUrl;
                        });
                        // Return immediately - redirect will happen asynchronously
                        return { success: true, redirectUrl: redirectUrl };
                    } else {
                        // If we can't find redirect URL, log it but don't show error to user
                        // The redirect might still work via Appwrite's internal handling
                        console.warn('[Manifest Appwrite Auth] Could not extract redirect URL from token:', token);
                        // Don't set error - just return failure silently
                        // This prevents error flash when redirect might still succeed
                        this.inProgress = false;
                        return { success: false, error: 'Could not extract redirect URL' };
                    }
                } catch (error) {
                    // Don't show "No redirect URL" errors - they're usually false positives
                    // Only show other meaningful errors
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
            // Keep it in localStorage (cleared on logout)
            // This allows us to show the correct provider name even after page refresh
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