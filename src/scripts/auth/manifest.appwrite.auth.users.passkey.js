/* Auth passkeys (WebAuthn) */

function initializePasskeys() {
    if (typeof Alpine === 'undefined') {
        return;
    }

    const config = window.ManifestAppwriteAuthConfig;
    if (!config) {
        return;
    }

    const PKC = () => window.PublicKeyCredential;
    const webauthnSupported = () => typeof PKC() === 'function'
        && typeof window.navigator?.credentials?.get === 'function'
        && typeof window.navigator?.credentials?.create === 'function';

    // base64url <-> bytes, for browsers without the WebAuthn JSON helpers
    function decode(value) {
        const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
        const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes.buffer;
    }
    function encode(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    const decodeDescriptors = list => (list || []).map(item => ({ ...item, id: decode(item.id) }));

    function creationOptions(json) {
        if (typeof PKC().parseCreationOptionsFromJSON === 'function') {
            return PKC().parseCreationOptionsFromJSON(json);
        }
        return {
            ...json,
            challenge: decode(json.challenge),
            user: { ...json.user, id: decode(json.user.id) },
            excludeCredentials: decodeDescriptors(json.excludeCredentials)
        };
    }
    function requestOptions(json) {
        if (typeof PKC().parseRequestOptionsFromJSON === 'function') {
            return PKC().parseRequestOptionsFromJSON(json);
        }
        return {
            ...json,
            challenge: decode(json.challenge),
            allowCredentials: decodeDescriptors(json.allowCredentials)
        };
    }
    function credentialJSON(credential) {
        if (typeof credential.toJSON === 'function') {
            return credential.toJSON();
        }
        const source = credential.response;
        const response = {};
        for (const key of ['clientDataJSON', 'attestationObject', 'authenticatorData', 'signature', 'userHandle']) {
            if (source[key]) response[key] = encode(source[key]);
        }
        if (typeof source.getTransports === 'function') response.transports = source.getTransports();
        // Registration responses carry these behind getters
        if (typeof source.getAuthenticatorData === 'function') response.authenticatorData = encode(source.getAuthenticatorData());
        if (typeof source.getPublicKey === 'function') {
            const publicKey = source.getPublicKey();
            if (publicKey) response.publicKey = encode(publicKey);
            response.publicKeyAlgorithm = source.getPublicKeyAlgorithm();
        }
        const json = {
            id: credential.id,
            rawId: encode(credential.rawId),
            type: credential.type,
            clientExtensionResults: typeof credential.getClientExtensionResults === 'function' ? credential.getClientExtensionResults() : {},
            response
        };
        if (credential.authenticatorAttachment) json.authenticatorAttachment = credential.authenticatorAttachment;
        return json;
    }

    const APPWRITE_CODES = {
        user_auth_method_unsupported: 'not-enabled',
        user_reauthentication_required: 'reauth-required',
        user_passkey_limit_exceeded: 'limit',
        user_passkey_already_exists: 'exists',
        user_passkey_invalid: 'invalid',
        user_passkey_not_found: 'invalid',
        user_invalid_token: 'invalid',
        general_rate_limit_exceeded: 'rate-limited'
    };
    const MESSAGES = {
        'not-enabled': 'Passkeys are not enabled for this Appwrite project. Enable Passkey under Auth → Settings.',
        'reauth-required': 'Sign in again to manage passkeys.',
        'limit': 'This account already has the maximum number of passkeys.',
        'exists': 'This passkey is already registered.'
    };

    // { code, error } for a thrown WebAuthn or Appwrite error; error is null when the user dismissed the prompt
    function describe(error, ceremony) {
        const name = error?.name;
        if (name === 'NotAllowedError' || name === 'AbortError') {
            return { code: 'cancelled', error: null };
        }
        if (name === 'InvalidStateError' && ceremony === 'create') {
            return { code: 'exists', error: MESSAGES.exists };
        }
        const code = APPWRITE_CODES[error?.type] || 'failed';
        return { code, error: MESSAGES[code] || error?.message || 'Passkey request failed' };
    }

    function refuse(store, code, message) {
        store.error = message;
        return { success: false, error: message, code };
    }

    // Shared gates; returns { account } or { refusal }
    async function prepare(store, method) {
        if (!store._appwrite) {
            store._appwrite = await config.getAppwriteClient();
        }
        if (!store._appwrite) {
            return { refusal: refuse(store, 'failed', 'Appwrite not configured') };
        }
        const appwriteConfig = await config.getAppwriteConfig();
        if (appwriteConfig && !appwriteConfig.passkey) {
            return { refusal: refuse(store, 'not-enabled', 'Passkey authentication is not enabled') };
        }
        const account = store._appwrite.account;
        if (typeof account[method] !== 'function') {
            return { refusal: refuse(store, 'unsupported', 'Passkey methods not available. Please ensure you are using a recent Appwrite SDK.') };
        }
        return { account, appwriteConfig };
    }

    function signedInRefusal(store) {
        if (!store.isAuthenticated || !store.user) {
            return refuse(store, 'not-signed-in', 'Sign in first');
        }
        if (store.isAnonymous) {
            return refuse(store, 'guest', 'Guests cannot manage passkeys. Sign in first.');
        }
        return null;
    }

    const passkeyId = value => (value && typeof value === 'object' ? value.$id : value) || null;

    const waitForStore = () => {
        const store = Alpine.store('auth');
        if (store && !store.loginPasskey) {
            store.passkeySupported = webauthnSupported();

            // Bumped whenever the identity changes; in-flight lists for the old one are dropped
            let identityEpoch = 0;
            const clearPasskeys = () => {
                identityEpoch++;
                const current = Alpine.store('auth');
                if (current && current.passkeys?.length) current.passkeys = [];
            };
            for (const type of ['manifest:auth:login', 'manifest:auth:anonymous', 'manifest:auth:logout', 'manifest:auth:session-cleared']) {
                window.addEventListener(type, clearPasskeys);
            }
            // A ticket kept from a failed guest sign-in must not outlive an explicit logout
            window.addEventListener('manifest:auth:logout', () => {
                const current = Alpine.store('auth');
                if (current) current._passkeyMigrationTicket = null;
            });

            // One browser prompt at a time
            let busy = false;
            const busyRefusal = { success: false, error: null, code: 'busy' };

            store.loginPasskey = async function () {
                if (!webauthnSupported()) {
                    return refuse(this, 'unsupported', 'This browser does not support passkeys');
                }
                if (this.isAuthenticated && !this.isAnonymous) {
                    return refuse(this, 'signed-in', 'Already signed in. Please logout first.');
                }
                if (busy) return { ...busyRefusal };
                busy = true;
                let prepared;
                try {
                    prepared = await prepare(this, 'createPasskeyToken');
                } catch (error) {
                    busy = false;
                    throw error;
                }
                const { account, appwriteConfig, refusal } = prepared;
                if (refusal) {
                    busy = false;
                    return refusal;
                }

                this.inProgress = true;
                this.error = null;
                let guestEnded = false;

                try {
                    const challenge = await account.createPasskeyToken();
                    const credential = await window.navigator.credentials.get({ publicKey: requestOptions(challenge.publicKey) });
                    if (!credential) {
                        return { success: false, error: null, code: 'cancelled' };
                    }
                    const token = await account.updatePasskeyToken({ challengeId: challenge.$id, credential: credentialJSON(credential) });

                    // The guest session is only given up once the passkey is proven
                    if (this.session && this.isAnonymous) {
                        // Kept on the store, bound to this account, so a retry after a failed exchange redeems it
                        if (appwriteConfig?.guestMigrationFunctionId && this._callGuestMigration) {
                            const prep = await this._callGuestMigration('/prepare', {});
                            if (prep?.ok && prep.ticket) {
                                this._passkeyMigrationTicket = { ticket: prep.ticket, userId: token.userId };
                            }
                        }
                        // Appwrite refuses createSession while a session is active
                        try {
                            await this._beforeSessionEnd?.();
                            await account.deleteSession(this.session.$id);
                            guestEnded = true;
                        } catch (deleteError) {
                            const status = deleteError?.code || deleteError?.statusCode;
                            guestEnded = status === 401 || status === 404;
                        }
                    }

                    const kept = this._passkeyMigrationTicket;
                    const migrationTicket = kept?.userId === token.userId ? kept.ticket : null;

                    const session = await account.createSession(token.userId, token.secret);
                    this.session = session;
                    this.user = await account.get();
                    this.isAuthenticated = true;
                    this.isAnonymous = false;
                    this.error = null;

                    if (this._resetTeamsState) {
                        this._resetTeamsState();
                    }

                    this._passkeyMigrationTicket = null;
                    if (migrationTicket && this._callGuestMigration) {
                        await this._callGuestMigration('/commit', { ticket: migrationTicket });
                    }

                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    if (appwriteConfig?.teams && this.listTeams) {
                        try {
                            await this._loadTeamsAndSeed(appwriteConfig);
                        } catch (teamsError) {
                            console.warn('[Manifest Appwrite Auth] Failed to load teams after passkey login:', teamsError);
                        }
                    }

                    window.dispatchEvent(new CustomEvent('manifest:auth:login', {
                        detail: { user: this.user }
                    }));

                    return { success: true, user: this.user };
                } catch (error) {
                    const described = describe(error, 'get');
                    this.error = described.error;

                    // Guest session is gone though sign-in failed: drop its identity and teams
                    if (guestEnded) {
                        this.isAuthenticated = false;
                        this.isAnonymous = false;
                        this.user = null;
                        this.session = null;
                        if (this._resetTeamsState) {
                            this._resetTeamsState();
                        }
                        if (this._syncStateToStorage) {
                            this._syncStateToStorage(this);
                        }
                        window.dispatchEvent(new CustomEvent('manifest:auth:session-cleared', {
                            detail: { reason: 'passkey-failed' }
                        }));
                    }

                    return { success: false, ...described, guestEnded };
                } finally {
                    busy = false;
                    this.inProgress = false;
                }
            };

            store.addPasskey = async function (name) {
                if (!webauthnSupported()) {
                    return refuse(this, 'unsupported', 'This browser does not support passkeys');
                }
                const blocked = signedInRefusal(this);
                if (blocked) return blocked;
                if (busy) return { ...busyRefusal };
                busy = true;
                let prepared;
                try {
                    prepared = await prepare(this, 'createPasskey');
                } catch (error) {
                    busy = false;
                    throw error;
                }
                const { account, refusal } = prepared;
                if (refusal) {
                    busy = false;
                    return refusal;
                }

                // The id is always Appwrite's to choose
                const params = {};
                const label = typeof name === 'string' ? name.trim().slice(0, 128) : '';
                if (label) params.name = label;

                this.inProgress = true;
                this.error = null;
                const epoch = identityEpoch;

                try {
                    const challenge = await account.createPasskey(params);
                    const credential = await window.navigator.credentials.create({ publicKey: creationOptions(challenge.publicKey) });
                    if (!credential) {
                        return { success: false, error: null, code: 'cancelled' };
                    }
                    const passkey = await account.updatePasskeyVerification({
                        passkeyId: challenge.passkeyId,
                        credential: credentialJSON(credential)
                    });

                    // Registered for the account that asked; that account may no longer be the one shown
                    if (epoch === identityEpoch) {
                        this.passkeys = [...(this.passkeys || []).filter(p => p.$id !== passkey.$id), passkey];
                        window.dispatchEvent(new CustomEvent('manifest:auth:passkey-added', {
                            detail: { passkey }
                        }));
                    }

                    return { success: true, passkey };
                } catch (error) {
                    const described = describe(error, 'create');
                    this.error = described.error;
                    return { success: false, ...described };
                } finally {
                    busy = false;
                    this.inProgress = false;
                }
            };

            store.listPasskeys = async function () {
                const blocked = signedInRefusal(this);
                if (blocked) return blocked;
                const { account, refusal } = await prepare(this, 'listPasskeys');
                if (refusal) return refusal;

                const epoch = identityEpoch;
                try {
                    const response = await account.listPasskeys();
                    if (epoch !== identityEpoch) {
                        return { success: false, error: null, code: 'cancelled' };
                    }
                    this.passkeys = response?.passkeys || [];
                    this.error = null;
                    return { success: true, passkeys: this.passkeys };
                } catch (error) {
                    const described = describe(error);
                    this.error = described.error;
                    return { success: false, ...described };
                }
            };

            store.renamePasskey = async function (passkey, name) {
                const id = passkeyId(passkey);
                const label = typeof name === 'string' ? name.trim().slice(0, 128) : '';
                if (!id) return refuse(this, 'failed', 'Passkey is required');
                if (!label) return refuse(this, 'failed', 'Name is required');
                const blocked = signedInRefusal(this);
                if (blocked) return blocked;
                const { account, refusal } = await prepare(this, 'updatePasskey');
                if (refusal) return refusal;

                const epoch = identityEpoch;
                try {
                    const updated = await account.updatePasskey({ passkeyId: id, name: label });
                    if (epoch === identityEpoch) {
                        this.passkeys = (this.passkeys || []).map(p => (p.$id === id ? updated : p));
                    }
                    this.error = null;
                    return { success: true, passkey: updated };
                } catch (error) {
                    const described = describe(error);
                    this.error = described.error;
                    return { success: false, ...described };
                }
            };

            store.removePasskey = async function (passkey) {
                const id = passkeyId(passkey);
                if (!id) return refuse(this, 'failed', 'Passkey is required');
                const blocked = signedInRefusal(this);
                if (blocked) return blocked;
                const { account, refusal } = await prepare(this, 'deletePasskey');
                if (refusal) return refusal;

                const epoch = identityEpoch;
                try {
                    await account.deletePasskey({ passkeyId: id });
                    if (epoch === identityEpoch) {
                        this.passkeys = (this.passkeys || []).filter(p => p.$id !== id);
                    }
                    this.error = null;

                    window.dispatchEvent(new CustomEvent('manifest:auth:passkey-removed', {
                        detail: { passkeyId: id }
                    }));

                    return { success: true };
                } catch (error) {
                    const described = describe(error);
                    this.error = described.error;
                    return { success: false, ...described };
                }
            };
        } else if (!store) {
            setTimeout(waitForStore, 50);
        }
    };

    // The store exists by alpine:init; attach now so markup can call these as soon as it renders
    waitForStore();
}

document.addEventListener('alpine:init', () => {
    try {
        initializePasskeys();
    } catch (error) {
        // Failed to initialize passkeys
    }
});

window.ManifestAppwriteAuthPasskey = {
    initialize: initializePasskeys
};
