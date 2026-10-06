/* Auth phone OTP (SMS one-time passcode) */

// Two-step in-page flow (no redirect): createPhoneOTP(phone) texts a code + returns
// a userId, then the shared verifyOTP(code)/submitOTP() (users.otp.js) creates the
// session. Phone numbers must be E.164 (+ country code).
// Gotcha: like email OTP, Appwrite can't convert an anonymous guest via phone OTP —
// a guest verifying a code gets a fresh account. Use magic links for guest upgrade.

function initializePhoneOTP() {
    if (typeof Alpine === 'undefined') {
        return;
    }

    const config = window.ManifestAppwriteAuthConfig;
    if (!config) {
        return;
    }

    // Resolve a phone from an input/selector/{ phone } object/string, or auto-find
    // the nearest tel input. Returns { phone, inputEl, dataObj }.
    function resolvePhoneInput(phoneInputOrRef) {
        let phone = null;
        let inputEl = null;
        let dataObj = null;

        if (phoneInputOrRef === undefined || phoneInputOrRef === null) {
            let eventTarget = (typeof window !== 'undefined' && window.event) ? window.event.target : null;
            if (eventTarget) {
                const form = eventTarget.closest('form');
                const scope = form || eventTarget.parentElement;
                if (scope) {
                    inputEl = scope.querySelector('input[type="tel"]');
                    if (inputEl) phone = inputEl.value;
                }
            }
            if (!inputEl) {
                inputEl = document.querySelector('input[type="tel"]');
                if (inputEl) phone = inputEl.value;
            }
        } else if (typeof phoneInputOrRef === 'string') {
            try {
                const element = document.querySelector(phoneInputOrRef);
                if (element && element.tagName === 'INPUT' && element.type === 'tel') {
                    inputEl = element;
                    phone = element.value;
                } else {
                    phone = phoneInputOrRef; // Treat as a direct phone string
                }
            } catch (e) {
                phone = phoneInputOrRef; // Invalid selector -> treat as phone string
            }
        } else if (phoneInputOrRef && typeof phoneInputOrRef === 'object') {
            if (phoneInputOrRef.tagName === 'INPUT' || phoneInputOrRef.matches?.('input[type="tel"]')) {
                inputEl = phoneInputOrRef;
                phone = inputEl.value;
            } else if ('phone' in phoneInputOrRef) {
                phone = phoneInputOrRef.phone;
                dataObj = phoneInputOrRef;
            }
        }

        return { phone, inputEl, dataObj };
    }

    const waitForStore = () => {
        const store = Alpine.store('auth');
        if (store && !store.createPhoneOTP) {
            // Step 1: text a passcode. Verification reuses verifyOTP/submitOTP.
            store.createPhoneOTP = async function (phone) {
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
                if (appwriteConfig && !appwriteConfig.phone) {
                    return { success: false, error: 'Phone OTP authentication is not enabled' };
                }

                // Normalize to E.164: strip separators, require the country code.
                const normalized = String(phone).replace(/[\s().-]/g, '');
                if (!/^\+\d{6,15}$/.test(normalized)) {
                    this.error = 'Phone number must be in international format, e.g. +14155550123';
                    return { success: false, error: this.error };
                }

                // Phone OTP can't convert a guest — warn so lost guest teams aren't a surprise.
                if (this.isAnonymous && appwriteConfig?.guestUpgrade) {
                    console.warn('[Manifest Appwrite Auth] Phone OTP cannot upgrade a guest account (Appwrite limitation); the guest session and any guest-created teams will be replaced. Use magic links for guest upgrade.');
                }

                const account = this._appwrite.account;
                if (typeof account.createPhoneToken !== 'function') {
                    return {
                        success: false,
                        error: 'Phone OTP method not available. Please ensure you are using a recent Appwrite SDK.'
                    };
                }

                this.inProgress = true;
                this.error = null;
                this.otpExpired = false;

                try {
                    const uniqueId = (window.Appwrite?.ID?.unique) ? window.Appwrite.ID.unique() : 'unique()';
                    const token = await account.createPhoneToken(uniqueId, normalized);

                    // Stash the userId Appwrite assigned; verifyOTP needs it to complete login.
                    this._otpUserId = token.userId;
                    this.otpPhrase = null; // phone tokens have no security phrase
                    this.otpSent = true;
                    this.otpExpired = false;
                    this.error = null;

                    window.dispatchEvent(new CustomEvent('manifest:auth:otp-sent', {
                        detail: { phone: normalized }
                    }));

                    return { success: true, message: 'OTP sent by SMS' };
                } catch (error) {
                    // Appwrite returns 501 when phone auth/SMS isn't set up — surface an
                    // actionable message rather than the raw error.
                    const code = error.code || error.statusCode;
                    const notEnabled = code === 501 || /not implemented/i.test(error.message || '');
                    this.error = notEnabled
                        ? 'Phone OTP is not enabled for this Appwrite project. Enable Phone under Auth → Settings and configure an SMS provider under Messaging.'
                        : error.message;
                    this.otpSent = false;
                    this.otpExpired = false;
                    return { success: false, error: this.error };
                } finally {
                    this.inProgress = false;
                }
            };

            // Convenience: resolve the phone from an input/selector/object/string and send.
            // Clears the phone input on success (mirrors sendEmailOTP).
            store.sendPhoneOTP = async function (phoneInputOrRef) {
                const { phone, inputEl, dataObj } = resolvePhoneInput(phoneInputOrRef);

                if (!phone || !String(phone).trim()) {
                    return { success: false, error: 'Phone number is required' };
                }

                const result = await this.createPhoneOTP(String(phone).trim());

                if (result.success) {
                    Promise.resolve().then(() => {
                        if (inputEl) {
                            inputEl.value = '';
                            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                        } else if (dataObj) {
                            dataObj.phone = '';
                        }
                    });
                }

                return result;
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
        initializePhoneOTP();
    } catch (error) {
        // Failed to initialize phone OTP
    }
});

// Export phone OTP interface
window.ManifestAppwriteAuthPhoneOTP = {
    initialize: initializePhoneOTP
};
