/* Auth magic links */

// Links requested in this browser sign in at once; any other link asks first
const MAGIC_REQUESTED_KEY = 'manifest:magic-link:requested';
const MAGIC_REQUESTED_TTL = 60 * 60 * 1000;
let pendingMagicSignIn = null;

function magicRequested() {
    try {
        const list = JSON.parse(localStorage.getItem(MAGIC_REQUESTED_KEY) || '[]');
        const now = Date.now();
        return Array.isArray(list) ? list.filter(e => e && typeof e.u === 'string' && now - e.t < MAGIC_REQUESTED_TTL) : [];
    } catch (e) {
        return [];
    }
}

function writeMagicRequested(list) {
    try {
        if (list.length) localStorage.setItem(MAGIC_REQUESTED_KEY, JSON.stringify(list.slice(-5)));
        else localStorage.removeItem(MAGIC_REQUESTED_KEY);
    } catch (e) {}
}

function rememberMagicRequest(userId) {
    if (!userId || typeof userId !== 'string') return;
    writeMagicRequested([...magicRequested().filter(e => e.u !== userId), { u: userId, t: Date.now() }]);
}

function forgetMagicRequest(userId) {
    writeMagicRequested(magicRequested().filter(e => e.u !== userId));
}

// Default confirmation; a page with its own UI calls preventDefault() on manifest:auth:signin-confirm
function showSignInConfirm(store) {
    if (typeof document.createElement !== 'function' || !document.body) return;
    const dialog = document.createElement('dialog');
    if (typeof dialog.showModal !== 'function') return;
    dialog.setAttribute('data-auth-signin-confirm', '');
    const title = document.createElement('h2');
    title.textContent = 'Continue signing in?';
    const text = document.createElement('p');
    text.textContent = 'This sign-in link was requested from another browser or device. Only continue if you asked for it.';
    const actions = document.createElement('footer');
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const proceed = document.createElement('button');
    proceed.type = 'button';
    proceed.textContent = 'Continue';
    actions.append(cancel, proceed);
    dialog.append(title, text, actions);
    cancel.addEventListener('click', () => dialog.close());
    proceed.addEventListener('click', () => { store.confirmSignIn(); dialog.close(); });
    dialog.addEventListener('close', () => { store.cancelSignIn(); dialog.remove(); });
    document.body.appendChild(dialog);
    dialog.showModal();
}

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

                    // Guest upgrade: when enabled and we're currently a guest, pass the
                    // anonymous user's own id so Appwrite links the email to that same
                    // account (preserving its teams) rather than minting a fresh user.
                    // Otherwise generate a unique id for a brand-new account.
                    const magicUserId = (appwriteConfig?.guestUpgrade && this.isAnonymous && this.user?.$id)
                        ? this.user.$id
                        : ((window.Appwrite?.ID?.unique) ? window.Appwrite.ID.unique() : 'unique()');

                    // Try createMagicURLSession first (standard method)
                    if (typeof account.createMagicURLSession === 'function') {
                        const token = await account.createMagicURLSession(magicUserId, email, cleanRedirectUrl);
                        rememberMagicRequest(token?.userId);
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
                        const token = await account.createMagicURLToken(magicUserId, email, redirectUrl);
                        rememberMagicRequest(token?.userId);
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

            // Answer a pending confirmation (link opened outside the browser that requested it)
            store.confirmSignIn = async function () {
                const pending = pendingMagicSignIn;
                pendingMagicSignIn = null;
                this.signInPending = false;
                if (!pending) return { success: false, error: 'No sign-in is waiting for confirmation' };
                const result = await this.handleMagicLinkCallback(pending.userId, pending.secret);
                if (!result.success) this._guestAfterSignInAnswer();
                return result;
            };

            // Guest creation waited on the answer
            store._guestAfterSignInAnswer = function () {
                if (!this.isAuthenticated && !this._sessionUnverified && this._guestAuto && this._createAnonymousSession) {
                    this._createAnonymousSession();
                }
            };

            store.cancelSignIn = function () {
                const wasPending = !!pendingMagicSignIn;
                pendingMagicSignIn = null;
                this.signInPending = false;
                if (wasPending) this._guestAfterSignInAnswer();
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
                let keepIdentity = false;

                try {
                    const appwriteConfig = await config.getAppwriteConfig();
                    // An upgrade link is made for the guest's own id; any other account replaces the guest
                    const upgradingGuest = !!(appwriteConfig?.guestUpgrade && this.isAnonymous && this.user?.$id === userId);
                    // A guest being replaced (not upgraded) by a different account — its
                    // team state must be cleared before loading the new user's teams.
                    const replacingGuest = this.isAnonymous && !upgradingGuest;
                    // A session this callback does not end keeps its identity if sign-in fails
                    keepIdentity = this.isAuthenticated && !replacingGuest;

                    // Delete the existing anonymous session first — UNLESS we're upgrading
                    // the guest in place. For an upgrade the magic token was created against
                    // the anonymous user's own id, so createSession converts that same
                    // account (keeping its teams); deleting it first would orphan the teams
                    // and force a brand-new user.
                    if (this.session && this.isAnonymous && !upgradingGuest) {
                        try {
                            await this._beforeSessionEnd?.();
                            await this._appwrite.account.deleteSession(this.session.$id);
                        } catch (deleteError) {
                            // Could not delete anonymous session
                        }
                    }

                    // Create session from magic link credentials. When upgrading a guest the
                    // anonymous session may still be active; Appwrite can reject the duplicate
                    // with a "prohibited" error, in which case the account is already upgraded
                    // and we just reuse the current session.
                    let session;
                    try {
                        session = await this._appwrite.account.createSession(userId, secret);
                    } catch (createError) {
                        if (upgradingGuest && createError.message?.includes('prohibited')) {
                            session = await this._appwrite.account.getSession('current');
                            // Still the guest's session: not upgraded
                            if (!session || session.provider === 'anonymous') throw createError;
                        } else {
                            throw createError;
                        }
                    }
                    this.session = session;
                    this.user = await this._appwrite.account.get();
                    this.isAuthenticated = true;
                    this.isAnonymous = false;
                    this.magicLinkSent = false;
                    this.magicLinkExpired = false;
                    this.error = null;
                    forgetMagicRequest(userId);

                    // Clear stored callback on success
                    try {
                        sessionStorage.removeItem('manifest:magic-link:callback');
                    } catch (e) {
                        // Ignore
                    }

                    // Replacing a guest with a different account: drop the guest's stale
                    // team state so listTeams doesn't query teams the new user can't access.
                    if (replacingGuest && this._resetTeamsState) {
                        this._resetTeamsState();
                    }

                    // Sync state
                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    // Load teams if enabled (and seed any configured default teams)
                    if (appwriteConfig?.teams && this.listTeams) {
                        try {
                            await this._loadTeamsAndSeed(appwriteConfig);
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
                    const sessionExists = keepIdentity && (error.type === 'user_session_already_exists' || errorMessage.includes('prohibited'));
                    const isExpiredOrInvalid = !isRateLimit && !sessionExists && errorMessage && (
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
                        if (!keepIdentity) {
                            this.isAuthenticated = false;
                            this.isAnonymous = false;
                        }
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

                    if (!keepIdentity) {
                        this.isAuthenticated = false;
                        this.isAnonymous = false;
                    }

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

        if (magicRequested().some(e => e.u === callbackInfo.userId)) {
            await store.handleMagicLinkCallback(callbackInfo.userId, callbackInfo.secret);
            return;
        }

        // Not requested here: nothing is consumed and no session ends until the visitor confirms
        pendingMagicSignIn = { userId: callbackInfo.userId, secret: callbackInfo.secret };
        store.signInPending = true;
        const ask = new CustomEvent('manifest:auth:signin-confirm', { cancelable: true });
        if (window.dispatchEvent(ask)) showSignInConfirm(store);
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