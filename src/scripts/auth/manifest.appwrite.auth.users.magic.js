/* Auth magic links */

// Add magic link methods to auth store
function initializeMagicLinks() {
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
        if (store && !store.createMagicLink) {
            // Add magic link methods to store
            store.createMagicLink = async function (email, redirectUrl = window.location.href) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                // Don't allow magic link request if already signed in (non-anonymous)
                if (this.isAuthenticated && !this.isAnonymous) {
                    return { success: false, error: 'Already signed in. Please logout first.' };
                }

                // Check if magic links are enabled
                const appwriteConfig = await config.getAppwriteConfig();
                if (appwriteConfig && !appwriteConfig.magic) {
                    return { success: false, error: 'Magic link authentication is not enabled' };
                }

                // Use origin + pathname for redirect URL to avoid query params
                // This prevents Appwrite from adding parameters to URLs that already have query strings
                const currentUrl = new URL(window.location.href);
                const cleanRedirectUrl = redirectUrl === window.location.href
                    ? `${currentUrl.origin}${currentUrl.pathname}`
                    : redirectUrl;

                this.inProgress = true;
                this.error = null;
                // Clear expired flag when requesting new link
                this.magicLinkExpired = false;

                try {
                    // Check if account method exists
                    if (!this._appwrite || !this._appwrite.account) {
                        return { success: false, error: 'Account instance not available' };
                    }

                    const account = this._appwrite.account;

                    // Try createMagicURLSession first (standard method)
                    if (typeof account.createMagicURLSession === 'function') {
                        const token = await account.createMagicURLSession('unique()', email, cleanRedirectUrl);
                        this.magicLinkSent = true;
                        this.magicLinkExpired = false;
                        this.error = null;
                        window.dispatchEvent(new CustomEvent('manifest:auth:magic-link-sent', {
                            detail: { email }
                        }));
                        return { success: true, message: 'Magic link sent to email', token };
                    }

                    // Fallback: try createMagicURLToken (alternative method name)
                    if (typeof account.createMagicURLToken === 'function') {
                        const token = await account.createMagicURLToken('unique()', email, redirectUrl);
                        this.magicLinkSent = true;
                        this.magicLinkExpired = false;
                        this.error = null;
                        window.dispatchEvent(new CustomEvent('manifest:auth:magic-link-sent', {
                            detail: { email }
                        }));
                        return { success: true, message: 'Magic link sent to email', token };
                    }

                    // If neither method exists, return helpful error
                    return {
                        success: false,
                        error: 'Magic link method not available. Please ensure you are using the latest Appwrite SDK.'
                    };
                } catch (error) {
                    this.error = error.message;
                    this.magicLinkSent = false;
                    this.magicLinkExpired = false;
                    return { success: false, error: error.message };
                } finally {
                    this.inProgress = false;
                }
            };

            // Convenience method: send magic link and automatically clear email on success
            // Accepts: email input element, selector string, Alpine reactive object {email}, email string, or nothing (auto-find)
            store.sendMagicLink = async function (emailInputOrRef, redirectUrl = window.location.href) {
                let email = null;
                let emailInputElement = null;
                let emailDataObj = null;

                // If no argument provided, try to auto-find the email input
                if (emailInputOrRef === undefined || emailInputOrRef === null) {
                    // Try to find the email input in the current context
                    // First, try to find the closest email input relative to the event target
                    let eventTarget = null;
                    if (typeof window !== 'undefined' && window.event) {
                        eventTarget = window.event.target;
                    }

                    // If we have an event target, look for email input in the same form/parent
                    if (eventTarget) {
                        const form = eventTarget.closest('form');
                        if (form) {
                            emailInputElement = form.querySelector('input[type="email"]');
                            if (emailInputElement) {
                                email = emailInputElement.value;
                            }
                        } else {
                            // Look for email input in the same parent container
                            const parent = eventTarget.parentElement;
                            if (parent) {
                                emailInputElement = parent.querySelector('input[type="email"]');
                                if (emailInputElement) {
                                    email = emailInputElement.value;
                                }
                            }
                        }
                    }

                    // Fallback: find first email input in document
                    if (!emailInputElement) {
                        emailInputElement = document.querySelector('input[type="email"]');
                        if (emailInputElement) {
                            email = emailInputElement.value;
                        }
                    }
                }
                // Handle different input types
                else if (typeof emailInputOrRef === 'string') {
                    // Could be a selector or direct email string
                    // Try as selector first (most common case)
                    try {
                        const element = document.querySelector(emailInputOrRef);
                        if (element && (element.tagName === 'INPUT' && element.type === 'email')) {
                            emailInputElement = element;
                            email = element.value;
                        } else {
                            // Treat as direct email string
                            email = emailInputOrRef;
                        }
                    } catch (e) {
                        // Invalid selector, treat as email string
                        email = emailInputOrRef;
                    }
                } else if (emailInputOrRef && typeof emailInputOrRef === 'object') {
                    // Could be DOM element or Alpine reactive object
                    if (emailInputOrRef.tagName === 'INPUT' || emailInputOrRef.matches?.('input[type="email"]')) {
                        // DOM input element
                        emailInputElement = emailInputOrRef;
                        email = emailInputElement.value;
                    } else if ('email' in emailInputOrRef) {
                        // Alpine reactive object { email }
                        email = emailInputOrRef.email;
                        emailDataObj = emailInputOrRef;
                    } else {
                        return { success: false, error: 'Invalid email input. Provide an input element, selector, {email} object, email string, or nothing (auto-find).' };
                    }
                }

                if (!email || !email.trim()) {
                    return { success: false, error: 'Email is required' };
                }

                const result = await this.createMagicLink(email.trim(), redirectUrl);

                // Clear email on success
                if (result.success) {
                    // Use a microtask to ensure Alpine processes the update smoothly
                    Promise.resolve().then(() => {
                        if (emailInputElement) {
                            // Clear DOM input element
                            emailInputElement.value = '';
                            // Trigger input event for Alpine reactivity (if x-model is bound, it will update)
                            emailInputElement.dispatchEvent(new Event('input', { bubbles: true }));
                        } else if (emailDataObj) {
                            // Clear Alpine reactive object
                            emailDataObj.email = '';
                        }
                        // If we auto-found the input and it has x-model, the input event will update Alpine
                        // This handles the case where x-model="email" is bound to the input
                    });
                }

                return result;
            };

            // Handle magic link callback
            store.handleMagicLinkCallback = async function (userId, secret) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                this.inProgress = true;
                this.error = null;
                this.magicLinkExpired = false;
                this.magicLinkSent = false;

                try {
                    // Delete any existing anonymous sessions first
                    if (this.session && this.isAnonymous) {
                        try {
                            await this._appwrite.account.deleteSession(this.session.$id);
                        } catch (deleteError) {
                            // Could not delete anonymous session
                        }
                    }

                    // Create session from magic link credentials
                    const session = await this._appwrite.account.createSession(userId, secret);
                    this.session = session;
                    this.user = await this._appwrite.account.get();
                    this.isAuthenticated = true;
                    this.isAnonymous = false;
                    this.magicLinkSent = false;
                    this.magicLinkExpired = false;
                    this.error = null;

                    // Clear stored callback on success
                    try {
                        sessionStorage.removeItem('manifest:magic-link:callback');
                    } catch (e) {
                        // Ignore
                    }

                    // Sync state
                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    // Load teams if enabled
                    const appwriteConfig = await config.getAppwriteConfig();
                    if (appwriteConfig?.teams && this.listTeams) {
                        try {
                            await this.listTeams();
                            // Auto-create default teams if enabled
                            if ((appwriteConfig.permanentTeams || appwriteConfig.templateTeams) && window.ManifestAppwriteAuthTeamsDefaults?.ensureDefaultTeams) {
                                await window.ManifestAppwriteAuthTeamsDefaults.ensureDefaultTeams(this);
                            }
                        } catch (teamsError) {
                            console.warn('[Manifest Appwrite Auth] Failed to load teams after magic link login:', teamsError);
                            // Don't fail login if teams fail to load
                        }
                    }

                    window.dispatchEvent(new CustomEvent('manifest:auth:login', {
                        detail: { user: this.user }
                    }));

                    return { success: true, user: this.user };
                } catch (error) {
                    // Categorize errors
                    const errorMessage = error.message || '';
                    const errorCode = error.code || error.statusCode || '';
                    const isRateLimit = errorCode === 429 || errorMessage.includes('Rate limit') || errorMessage.includes('429');
                    const isExpiredOrInvalid = !isRateLimit && errorMessage && (
                        errorMessage.includes('expired') ||
                        errorMessage.includes('Invalid token') ||
                        errorMessage.includes('invalid') ||
                        errorMessage.includes('not found') ||
                        errorMessage.includes('404') ||
                        errorMessage.includes('prohibited') ||
                        errorCode === 404
                    );

                    if (isRateLimit) {
                        // Don't persist {userId, secret} for retry — the secret is a
                        // bearer credential that any same-origin XSS could lift. On
                        // rate limit the user must re-request the magic link from
                        // their email (cleanupUrl has already stripped URL params).
                        this.error = 'Rate limit exceeded. Please wait a moment and request a new magic link.';
                        this.isAuthenticated = false;
                        this.isAnonymous = false;
                        this.magicLinkExpired = false;
                    } else if (isExpiredOrInvalid) {
                        try {
                            sessionStorage.removeItem('manifest:magic-link:callback');
                        } catch (e) {
                            // Ignore
                        }
                        this.magicLinkExpired = true;
                        this.magicLinkSent = false;
                        this.error = null;
                    } else {
                        try {
                            sessionStorage.removeItem('manifest:magic-link:callback');
                        } catch (e) {
                            // Ignore
                        }
                        this.error = error.message;
                        this.magicLinkExpired = false;
                        this.magicLinkSent = false;
                    }

                    this.isAuthenticated = false;
                    this.isAnonymous = false;

                    // Sync state
                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    return { success: false, error: error.message };
                } finally {
                    this.inProgress = false;
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

// Handle magic link callbacks via events
function handleMagicLinkCallbacks() {
    // Handle expired magic link
    window.addEventListener('manifest:auth:callback:expired', async (event) => {
        const store = Alpine.store('auth');
        if (!store) return;

        const callbackInfo = event.detail;

        // Check if user is already authenticated - preserve session
        let hasExistingSession = false;
        if (store.isAuthenticated && store.user) {
            hasExistingSession = true;
        } else if (store._appwrite) {
            // Only check if we don't have existing state (prevents rate limits)
            try {
                const user = await store._appwrite.account.get();
                if (user) {
                    hasExistingSession = true;
                    store.user = user;
                    store.isAuthenticated = true;
                    // Try to get session info
                    try {
                        const sessionsResponse = await store._appwrite.account.listSessions();
                        const allSessions = sessionsResponse.sessions || [];
                        const currentSession = allSessions.find(s => s.current === true) || allSessions[0];
                        if (currentSession) {
                            store.session = currentSession;
                            store.isAnonymous = currentSession.provider === 'anonymous';
                        }
                    } catch (sessionError) {
                        // Session fetch failed, but user exists
                        console.warn('[Manifest Appwrite Auth] Could not get session info:', sessionError);
                    }
                }
            } catch (userError) {
                // No existing session
                hasExistingSession = false;
            }
        }

        // Set expired flag (always true for expired links)
        store.magicLinkExpired = true;
        store.magicLinkSent = false;
        store.error = null;

        // Only clear state if no existing session
        if (!hasExistingSession) {
            store.isAuthenticated = false;
            store.isAnonymous = false;
            store.user = null;
            store.session = null;
        }

        store.inProgress = false;

        // Sync state
        if (store._syncStateToStorage) {
            store._syncStateToStorage(store);
        }

        // Force Alpine reactivity
        requestAnimationFrame(() => {
            const authStore = Alpine.store('auth');
            if (authStore) {
                void authStore.isAuthenticated;
                void authStore.magicLinkExpired;
                void authStore.user;
            }
        });
    });

    // Handle valid magic link callback
    window.addEventListener('manifest:auth:callback:magic', async (event) => {
        const store = Alpine.store('auth');
        if (!store) return;

        const callbackInfo = event.detail;

        // Note: we deliberately do NOT persist {userId, secret} to sessionStorage
        // as a retry safety net. The secret is a single-use bearer credential
        // that any same-origin XSS could read; UX of "refresh to retry on rate
        // limit" isn't worth the credential-exfil risk.

        // Handle the callback
        await store.handleMagicLinkCallback(callbackInfo.userId, callbackInfo.secret);
    });
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeMagicLinks();
        handleMagicLinkCallbacks();
    } catch (error) {
        // Failed to initialize magic links
    }
});

// Export magic links interface
window.ManifestAppwriteAuthMagicLinks = {
    initialize: initializeMagicLinks,
    handleCallbacks: handleMagicLinkCallbacks
};