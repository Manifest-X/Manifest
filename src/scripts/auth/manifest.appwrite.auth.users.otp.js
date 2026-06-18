/* Auth email OTP (one-time passcode) */

// Email OTP is a two-step, in-page flow (no redirect, unlike magic links):
//   1. createEmailOTP(email)  -> Appwrite emails a 6-digit code, returns a userId
//   2. verifyOTP(code)        -> createSession(userId, code) completes login
// Because there is no URL round-trip, this module never touches users.callbacks.js.
//
// NOTE: Appwrite does NOT support converting an anonymous (guest) session via email
// OTP — only magic links, phone, email/password, and OAuth can do that. So when a
// guest verifies an OTP we mint a fresh account (the anonymous session is deleted),
// which discards any guest-created teams. Use magic links if you need guest upgrade.

function initializeEmailOTP() {
    if (typeof Alpine === 'undefined') {
        return;
    }

    const config = window.ManifestAppwriteAuthConfig;
    if (!config) {
        return;
    }

    // Resolve an email string from the same range of inputs sendMagicLink accepts:
    // an input element, a selector, an Alpine { email } object, a bare string, or
    // nothing (auto-find the nearest email input). Returns { email, inputEl, dataObj }.
    function resolveEmailInput(emailInputOrRef) {
        let email = null;
        let inputEl = null;
        let dataObj = null;

        if (emailInputOrRef === undefined || emailInputOrRef === null) {
            let eventTarget = (typeof window !== 'undefined' && window.event) ? window.event.target : null;
            if (eventTarget) {
                const form = eventTarget.closest('form');
                const scope = form || eventTarget.parentElement;
                if (scope) {
                    inputEl = scope.querySelector('input[type="email"]');
                    if (inputEl) email = inputEl.value;
                }
            }
            if (!inputEl) {
                inputEl = document.querySelector('input[type="email"]');
                if (inputEl) email = inputEl.value;
            }
        } else if (typeof emailInputOrRef === 'string') {
            try {
                const element = document.querySelector(emailInputOrRef);
                if (element && element.tagName === 'INPUT' && element.type === 'email') {
                    inputEl = element;
                    email = element.value;
                } else {
                    email = emailInputOrRef; // Treat as a direct email string
                }
            } catch (e) {
                email = emailInputOrRef; // Invalid selector -> treat as email string
            }
        } else if (emailInputOrRef && typeof emailInputOrRef === 'object') {
            if (emailInputOrRef.tagName === 'INPUT' || emailInputOrRef.matches?.('input[type="email"]')) {
                inputEl = emailInputOrRef;
                email = inputEl.value;
            } else if ('email' in emailInputOrRef) {
                email = emailInputOrRef.email;
                dataObj = emailInputOrRef;
            }
        }

        return { email, inputEl, dataObj };
    }

    const waitForStore = () => {
        const store = Alpine.store('auth');
        if (store && !store.createEmailOTP) {
            // Step 1: request a one-time passcode by email.
            // Pass { phrase: true } to enable Appwrite's security phrase (anti-phishing);
            // when enabled the phrase is stored on the store as `otpPhrase` for display.
            store.createEmailOTP = async function (email, options = {}) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                // Don't allow OTP request if already signed in (non-anonymous)
                if (this.isAuthenticated && !this.isAnonymous) {
                    return { success: false, error: 'Already signed in. Please logout first.' };
                }

                const appwriteConfig = await config.getAppwriteConfig();
                if (appwriteConfig && !appwriteConfig.otp) {
                    return { success: false, error: 'Email OTP authentication is not enabled' };
                }

                // Appwrite can't convert an anonymous account via OTP. Warn (once) so guest
                // teams aren't silently lost; the login still proceeds as a fresh account.
                if (this.isAnonymous && appwriteConfig?.guestUpgrade) {
                    console.warn('[Manifest Appwrite Auth] Email OTP cannot upgrade a guest account (Appwrite limitation); the guest session and any guest-created teams will be replaced. Use magic links for guest upgrade.');
                }

                const account = this._appwrite.account;
                if (typeof account.createEmailToken !== 'function') {
                    return {
                        success: false,
                        error: 'Email OTP method not available. Please ensure you are using a recent Appwrite SDK.'
                    };
                }

                this.inProgress = true;
                this.error = null;
                this.otpExpired = false;

                try {
                    const uniqueId = (window.Appwrite?.ID?.unique) ? window.Appwrite.ID.unique() : 'unique()';
                    // Third arg toggles Appwrite's security phrase feature.
                    const token = await account.createEmailToken(uniqueId, email, options.phrase === true);

                    // Stash the userId Appwrite assigned; verifyOTP needs it to complete login.
                    this._otpUserId = token.userId;
                    this.otpPhrase = token.phrase || null;
                    this.otpSent = true;
                    this.otpExpired = false;
                    this.error = null;

                    window.dispatchEvent(new CustomEvent('manifest:auth:otp-sent', {
                        detail: { email, phrase: this.otpPhrase }
                    }));

                    return { success: true, message: 'OTP sent to email', phrase: this.otpPhrase };
                } catch (error) {
                    // Appwrite returns 501 Not Implemented when Email OTP isn't enabled
                    // for the project. Surface an actionable message instead of the raw error.
                    const code = error.code || error.statusCode;
                    const notEnabled = code === 501 || /not implemented/i.test(error.message || '');
                    this.error = notEnabled
                        ? 'Email OTP is not enabled for this Appwrite project. Enable it under Auth → Settings.'
                        : error.message;
                    this.otpSent = false;
                    this.otpExpired = false;
                    return { success: false, error: this.error };
                } finally {
                    this.inProgress = false;
                }
            };

            // Convenience: resolve the email from an input/selector/object/string and send.
            // Clears the email input on success (mirrors sendMagicLink).
            store.sendEmailOTP = async function (emailInputOrRef, options = {}) {
                const { email, inputEl, dataObj } = resolveEmailInput(emailInputOrRef);

                if (!email || !email.trim()) {
                    return { success: false, error: 'Email is required' };
                }

                const result = await this.createEmailOTP(email.trim(), options);

                if (result.success) {
                    Promise.resolve().then(() => {
                        if (inputEl) {
                            inputEl.value = '';
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                        } else if (dataObj) {
                            dataObj.email = '';
                        }
                    });
                }

                return result;
            };

            // Step 2: verify the code and create the session.
            store.verifyOTP = async function (code) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }
                if (!this._otpUserId) {
                    return { success: false, error: 'Request a code first' };
                }
                if (!code || !String(code).trim()) {
                    return { success: false, error: 'Code is required' };
                }

                this.inProgress = true;
                this.error = null;

                try {
                    const appwriteConfig = await config.getAppwriteConfig();
                    const wasGuest = this.isAnonymous;

                    // Guest team carryover: OTP can't convert the anonymous account, so we
                    // migrate its teams to the new account instead. Issue the migration
                    // ticket NOW, while the guest session is still authenticated — it's
                    // redeemed after the new session exists. Best-effort; never blocks login.
                    let migrationTicket = null;
                    if (wasGuest && appwriteConfig?.guestMigrationFunctionId && this._callGuestMigration) {
                        const prep = await this._callGuestMigration('/prepare', {});
                        if (prep?.ok && prep.ticket) migrationTicket = prep.ticket;
                    }

                    // Appwrite can't convert anonymous accounts via OTP, so delete the
                    // guest session first to avoid a "session prohibited" conflict.
                    if (this.session && this.isAnonymous) {
                        try {
                            await this._appwrite.account.deleteSession(this.session.$id);
                        } catch (deleteError) {
                            // Could not delete anonymous session
                        }
                    }

                    const session = await this._appwrite.account.createSession(this._otpUserId, String(code).trim());
                    this.session = session;
                    this.user = await this._appwrite.account.get();
                    this.isAuthenticated = true;
                    this.isAnonymous = false;
                    this.otpSent = false;
                    this.otpExpired = false;
                    this.otpPhrase = null;
                    this._otpUserId = null;
                    this.error = null;

                    // OTP replaces any prior guest with a different account (no conversion),
                    // so clear the guest's team state before loading the new user's teams —
                    // otherwise the stale currentTeam triggers 404s in listTeams.
                    if (this._resetTeamsState) {
                        this._resetTeamsState();
                    }

                    // Redeem the migration ticket as the new account: carries the guest's
                    // teams over. Best-effort — a failure leaves the guest's teams for GC
                    // but never blocks the (already successful) sign-in.
                    if (migrationTicket && this._callGuestMigration) {
                        await this._callGuestMigration('/commit', { ticket: migrationTicket });
                    }

                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    // Load teams + seed any configured default teams for the new account
                    if (appwriteConfig?.teams && this.listTeams) {
                        try {
                            await this._loadTeamsAndSeed(appwriteConfig);
                        } catch (teamsError) {
                            console.warn('[Manifest Appwrite Auth] Failed to load teams after OTP login:', teamsError);
                        }
                    }

                    window.dispatchEvent(new CustomEvent('manifest:auth:login', {
                        detail: { user: this.user }
                    }));

                    return { success: true, user: this.user };
                } catch (error) {
                    const errorMessage = error.message || '';
                    const errorCode = error.code || error.statusCode || '';
                    const isExpiredOrInvalid = errorMessage && (
                        errorMessage.includes('expired') ||
                        errorMessage.includes('Invalid token') ||
                        errorMessage.includes('invalid') ||
                        errorMessage.includes('not found') ||
                        errorCode === 401 || errorCode === 404
                    );

                    this.otpExpired = !!isExpiredOrInvalid;
                    this.error = isExpiredOrInvalid ? null : error.message;
                    this.isAuthenticated = false;
                    this.isAnonymous = false;

                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    return { success: false, error: error.message };
                } finally {
                    this.inProgress = false;
                }
            };

            // Convenience: resolve the code from an input/selector/object/string and verify.
            store.submitOTP = async function (codeInputOrRef) {
                let code = null;
                if (codeInputOrRef === undefined || codeInputOrRef === null) {
                    const el = document.querySelector('input[name="otp"], input[autocomplete="one-time-code"], input[inputmode="numeric"]');
                    if (el) code = el.value;
                } else if (typeof codeInputOrRef === 'string') {
                    try {
                        const el = document.querySelector(codeInputOrRef);
                        code = (el && el.tagName === 'INPUT') ? el.value : codeInputOrRef;
                    } catch (e) {
                        code = codeInputOrRef;
                    }
                } else if (codeInputOrRef && typeof codeInputOrRef === 'object') {
                    if (codeInputOrRef.tagName === 'INPUT') {
                        code = codeInputOrRef.value;
                    } else if ('code' in codeInputOrRef) {
                        code = codeInputOrRef.code;
                    } else if ('otp' in codeInputOrRef) {
                        code = codeInputOrRef.otp;
                    }
                }

                return await this.verifyOTP(code);
            };
        } else if (!store) {
            setTimeout(waitForStore, 50);
        }
    };

    setTimeout(waitForStore, 100);
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeEmailOTP();
    } catch (error) {
        // Failed to initialize email OTP
    }
});

// Export email OTP interface
window.ManifestAppwriteAuthEmailOTP = {
    initialize: initializeEmailOTP
};
