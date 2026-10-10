/* Auth store */

// Initialize auth store
function initializeAuthStore() {
    if (typeof Alpine === 'undefined') {
        return;
    }

    const config = window.ManifestAppwriteAuthConfig;
    if (!config) {
        return;
    }

    // Cross-tab synchronization using localStorage events
    const STORAGE_KEY = 'manifest:auth:state';
    // Cap on holding scoped data for a guest/callback sign-in that may fail
    const SIGN_IN_PENDING_MS = 5000;
    ['manifest:auth:login', 'manifest:auth:anonymous', 'manifest:auth:logout', 'manifest:auth:session-cleared'].forEach(type =>
        window.addEventListener(type, () => { const store = Alpine.store('auth'); if (store) { store._signInPendingUntil = 0; store._authEpoch++; markVerified(store); } }));

    // Unverified session: recheck on reconnect, on return to the tab, and on a bounded backoff
    const RECHECK_DELAYS_MS = [2000, 5000, 15000, 60000];
    const recheck = () => { Alpine.store('auth')?._recheckSession?.(); };
    window.addEventListener('online', recheck);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheck(); });

    function markVerified(store) {
        store._sessionUnverified = false;
        store._recheckAttempt = 0;
        if (store._recheckTimer) { clearTimeout(store._recheckTimer); store._recheckTimer = null; }
    }

    function scheduleRecheck(store) {
        if (!store._sessionUnverified || store._recheckTimer) return;
        const delay = RECHECK_DELAYS_MS[Math.min(store._recheckAttempt++, RECHECK_DELAYS_MS.length - 1)];
        store._recheckTimer = setTimeout(() => { store._recheckTimer = null; store._recheckSession(); }, delay);
    }

    // Appwrite's "no session" answer; anything else (offline, 5xx) leaves the session unknown
    const NO_SESSION_TYPES = ['general_unauthorized_scope', 'user_unauthorized', 'user_session_not_found', 'user_jwt_invalid', 'user_not_found', 'user_blocked'];
    const isNoSession = error => error?.code === 401 || NO_SESSION_TYPES.includes(error?.type);

    // Session fields safe to mirror across tabs. Excludes `secret` and provider
    // tokens — this copy is only for UI cross-tab sync, not the auth of record.
    const SAFE_SESSION_FIELDS = [
        '$id', 'userId', 'provider', 'expire', 'current',
        'clientName', 'osName', 'osCode', 'deviceName',
        'deviceBrand', 'deviceModel', 'countryCode', 'countryName'
    ];

    // User id in a mirrored state ('' / null when signed out)
    function mirroredUserId(raw) {
        try { const saved = JSON.parse(raw || 'null'); return saved?.isAuthenticated ? (saved.user?.$id || null) : null; } catch { return null; }
    }

    // Identity this tab is showing data for: while unverified, the last one mirrored
    function shownUserId(store, mirrored) {
        if (store.user?.$id) return store.user.$id;
        if (!store._sessionUnverified) return null;
        if (mirrored === undefined) { try { mirrored = localStorage.getItem(STORAGE_KEY); } catch { mirrored = null; } }
        return mirroredUserId(mirrored);
    }

    function sanitizeSessionForStorage(session) {
        if (!session || typeof session !== 'object') return session;
        const safe = {};
        for (const f of SAFE_SESSION_FIELDS) {
            if (f in session) safe[f] = session[f];
        }
        return safe;
    }

    // Listen for storage events from other tabs
    window.addEventListener('storage', (e) => {
        if (e.key === STORAGE_KEY && e.newValue) {
            try {
                const state = JSON.parse(e.newValue);
                const store = Alpine.store('auth');
                if (store) {
                    const prevId = shownUserId(store, e.oldValue);
                    const wasAuthenticated = store.isAuthenticated === true;
                    // Update store state from other tab
                    store._authEpoch++;
                    if (state.isAuthenticated) markVerified(store);
                    store.isAuthenticated = state.isAuthenticated;
                    store.isAnonymous = state.isAnonymous;
                    store.user = state.user;
                    store.session = state.session;
                    store.magicLinkSent = state.magicLinkSent || false;
                    store.magicLinkExpired = state.magicLinkExpired || false;
                    store.otpSent = state.otpSent || false;
                    store.otpExpired = state.otpExpired || false;
                    // A code row shown here must be verifiable here
                    if (state.otpSent && state.otpUserId) store._otpUserId = state.otpUserId;
                    store.error = state.error;
                    // Identity ended or changed in another tab: scoped data must drop this tab's rows
                    const nextId = state.isAuthenticated ? (state.user?.$id || null) : null;
                    if (prevId && nextId !== prevId) {
                        if (!nextId) {
                            store.teams = [];
                            store.currentTeam = null;
                        }
                        window.dispatchEvent(new CustomEvent('manifest:auth:session-cleared'));
                    } else if (nextId && !wasAuthenticated) {
                        // Signed in from another tab: this tab's identity-bound data reloads
                        window.dispatchEvent(new CustomEvent(state.isAnonymous ? 'manifest:auth:anonymous' : 'manifest:auth:login', { detail: { user: state.user, crossTab: true } }));
                    }
                }
            } catch (error) {
                // Failed to sync state from other tab
            }
        }
    });

    // Helper to sync state to localStorage (for cross-tab communication)
    function syncStateToStorage(store) {
        // An unverified signed-out state must not sign other tabs out
        if (store._sessionUnverified && !store.isAuthenticated) return;
        try {
            const state = {
                isAuthenticated: store.isAuthenticated,
                isAnonymous: store.isAnonymous,
                user: store.user,
                session: sanitizeSessionForStorage(store.session),
                magicLinkSent: store.magicLinkSent,
                magicLinkExpired: store.magicLinkExpired,
                otpSent: store.otpSent,
                otpExpired: store.otpExpired,
                otpUserId: store.otpSent ? store._otpUserId : null,
                error: store.error
            };
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        } catch (error) {
            // Failed to sync state to storage
        }
    }

    const authStore = {
        user: null,
        session: null,
        isAuthenticated: false,
        isAnonymous: false,
        inProgress: false,
        error: null,
        magicLinkSent: false,
        magicLinkExpired: false,
        otpSent: false, // OTP (email/phone): a code has been sent and is awaiting entry
        otpExpired: false, // OTP (email/phone): the entered code was wrong/expired
        otpPhrase: null, // Email OTP: security phrase to display (when enabled; phone has none)
        _otpUserId: null, // OTP: userId returned by createEmailToken/createPhoneToken, used by verifyOTP
        _otpMigrationTicket: null, // OTP: { ticket, userId } guest-migration ticket, kept across failed verify attempts
        teams: [], // List of user's teams
        currentTeam: null, // Currently selected/active team
        _teamsPollInterval: null, // Interval ID for teams polling (deprecated, use realtime instead)
        _teamsRealtimeUnsubscribe: null, // Realtime subscription cleanup function (may be array of unsubscribes)
        _teamsRealtimeSubscribing: false, // Flag to prevent recursive subscription during refresh
        // Operation-specific loading states for better UI reactivity
        _updatingTeam: null, // Team ID being updated (null when not updating)
        _deletingTeam: null, // Team ID being deleted (null when not deleting)
        _creatingTeam: false, // Boolean flag for team creation
        // Stub team convenience methods (replaced by teams.convenience.js; prevent "is not a function" before init)
        isCreatingTeam() { return this._creatingTeam === true; },
        isUpdatingTeam() { return false; },
        isDeletingTeam() { return false; },
        isInvitingMember() { return false; },
        isUpdatingMember() { return false; },
        isDeletingMember() { return false; },
        isUpdatingRole() { return false; },
        isDeletingRole() { return false; },
        isCreatingRole() { return false; },
        // Member operation-specific loading states
        _updatingMember: null, // Membership ID being updated (null when not updating)
        _deletingMember: null, // Membership ID being deleted (null when not deleting)
        _invitingMember: false, // Boolean flag for member invitation
        // Role operation-specific loading states
        _updatingRole: null, // Object { teamId, roleName } being updated (null when not updating)
        _deletingRole: null, // Object { teamId, roleName } being deleted (null when not deleting)
        _creatingRole: false, // Boolean flag for role creation
        // Team management properties (reactive, no x-data needed)
        newTeamName: '',
        updateTeamNameInput: '',
        inviteEmail: '',
        inviteRoles: [], // Array of selected roles for checkboxes
        currentTeamMemberships: [],
        deletedTemplateTeams: [],
        deletedTemplateRoles: [], // Deleted template roles (can be reapplied)
        _teamImmutableCache: {},
        // User-generated roles properties
        newRoleName: '',
        newRolePermissions: [], // Array of selected permissions for checkboxes
        allAvailablePermissions: [], // Cached list of all available permissions for autocomplete
        editingRole: null, // Current role being edited: { teamId, oldRoleName, newRoleName, permissions }
        editingMember: null, // Current member being edited: { teamId, membershipId, roles }
        _initialized: false,
        _initializing: false,
        _appwrite: null,
        _guestAuto: false,
        _guestManual: false,
        _signInPendingUntil: 0, // signed-out init with guest-auto or an auth callback still to sign in
        _sessionUnverified: false, // init could not reach Appwrite: signed out locally, never broadcast
        _authEpoch: 0, // bumped by every identity change; an in-flight recheck from an older epoch is dropped
        _recheckTimer: null,
        _recheckAttempt: 0,
        guestManualEnabled: false,
        _oauthProvider: null, // Store OAuth provider name (google, github, etc.) when login is initiated
        _syncStateToStorage: syncStateToStorage,

        // Permission cache properties (initialized early for Alpine reactivity)
        _permissionCache: {},
        _userRoleCache: null,
        _allRolesCache: null,
        _allRolesCacheByTeam: {}, // Cache roles per team ID
        _rolePermanentCache: {}, // Cache permanent role status per team: { teamId: { roleName: true/false } }
        _userGeneratedRolesCache: {},

        // Permission cache methods (always available, return safe defaults)
        canInviteMembers() {
            return (this._permissionCache && this._permissionCache.inviteMembers) || false;
        },
        canRemoveMembers() {
            return (this._permissionCache && this._permissionCache.removeMembers) || false;
        },
        canRenameTeam() {
            return (this._permissionCache && this._permissionCache.renameTeam) || false;
        },
        // Check if user can authenticate (not already authenticated as non-anonymous or in progress)
        canAuthenticate() {
            return !((this.isAuthenticated && !this.isAnonymous) || this.inProgress);
        },
        canDeleteTeam() {
            return (this._permissionCache && this._permissionCache.deleteTeam) || false;
        },
        currentUserRole() {
            return this._userRoleCache || null;
        },
        allTeamRoles(team) {
            // If team is provided, get roles for that specific team
            if (team && team.$id) {
                // Return cached roles for this specific team
                return this._allRolesCacheByTeam[team.$id] || {};
            }
            // Fallback: return roles for current team
            if (this.currentTeam && this.currentTeam.$id) {
                return this._allRolesCacheByTeam[this.currentTeam.$id] || this._allRolesCache || {};
            }
            return this._allRolesCache || {};
        },
        isUserGeneratedRoleCached(roleName) {
            return (this._userGeneratedRolesCache && this._userGeneratedRolesCache[roleName]) || false;
        },
        // Fallback for canManageRoles (will be overridden by roles module if available)
        async canManageRoles() {
            // If no custom roles defined, owner has manageRoles permission
            const config = window.ManifestAppwriteAuthConfig;
            if (config) {
                try {
                    const appwriteConfig = await config.getAppwriteConfig();
                    const memberRoles = appwriteConfig?.memberRoles;
                    if (!memberRoles || Object.keys(memberRoles).length === 0) {
                        // No custom roles - owner has all permissions including manageRoles
                        if (this.isCurrentTeamOwner) {
                            return await this.isCurrentTeamOwner();
                        }
                        return false;
                    }
                    // Custom roles defined - check if user has manageRoles permission
                    if (this.hasTeamPermission) {
                        return await this.hasTeamPermission('manageRoles');
                    }
                } catch (error) {
                    return false;
                }
            }
            return false;
        },

        // Alias for backwards compatibility
        async canCreateRoles() {
            return await this.canManageRoles();
        },

        // Get personal team (convenience getter - returns first default team)
        get personalTeam() {
            // Lookup is async; use getPersonalTeam()/getDefaultTeams() instead
            return null;
        },

        // Get authentication method (anonymous, magic, otp, phone, oauth)
        getMethod() {
            if (!this.session) return null;
            // Appwrite session.provider: anonymous | magic-url | email (OTP) |
            // token (OTP, some versions) | phone | oauth2 (or a specific provider).
            switch (this.session.provider) {
                case 'anonymous': return 'anonymous';
                case 'magic-url': return 'magic';
                case 'email':     return 'otp';   // this plugin uses email tokens for OTP
                case 'token':     return 'otp';
                case 'phone':     return 'phone';
                case 'oauth2':    return 'oauth';
                default:          return this.session.provider ? 'oauth' : null;
            }
        },

        // OAuth provider name (google, github, …), or null for non-OAuth methods.
        // Reads stored provider, else falls back to session.provider / identities fetch.
        getProvider() {
            if (!this.session) {
                return null;
            }
            const sessionProvider = this.session.provider;

            // session.provider is generically "oauth2", so use _oauthProvider. Gate on
            // getMethod() so non-OAuth sessions skip the pointless identities lookup.
            if (this.getMethod() === 'oauth') {
                // Try to get from store first, then localStorage, then sessionStorage
                let provider = this._oauthProvider;
                if (!provider) {
                    try {
                        // Try localStorage first (persists across redirects)
                        provider = localStorage.getItem('manifest:oauth:provider');
                        if (!provider) {
                            // Fallback to sessionStorage
                            provider = sessionStorage.getItem('manifest:oauth:provider');
                        }
                        if (provider) {
                            this._oauthProvider = provider; // Cache it in store
                        }
                    } catch (e) {
                        // Storage error
                    }
                }

                // If still no provider, trigger async fetch from Appwrite identities (for existing sessions)
                // This runs in background and updates _oauthProvider when complete
                if (!provider && this._appwrite && this._appwrite.account && !this._fetchingProvider) {
                    this._fetchingProvider = true; // Prevent multiple simultaneous fetches
                    this._appwrite.account.listIdentities().then(identities => {
                        if (identities && identities.identities && identities.identities.length > 0) {
                            // Find OAuth identity (provider will be google, github, etc.)
                            const oauthIdentity = identities.identities.find(id =>
                                id.provider &&
                                id.provider !== 'anonymous' &&
                                id.provider !== 'magic-url' &&
                                id.provider !== 'oauth2'
                            );
                            if (oauthIdentity && oauthIdentity.provider) {
                                this._oauthProvider = oauthIdentity.provider; // Cache it
                                // Store in localStorage for future use
                                try {
                                    localStorage.setItem('manifest:oauth:provider', oauthIdentity.provider);
                                    // Trigger Alpine reactivity by accessing store
                                    const store = Alpine.store('auth');
                                    if (store) {
                                        void store._oauthProvider;
                                    }
                                } catch (e) {
                                    // Ignore storage errors
                                }
                            }
                        }
                        this._fetchingProvider = false;
                    }).catch(error => {
                        this._fetchingProvider = false;
                    });
                }

                const finalProvider = provider || sessionProvider;
                return finalProvider;
            }
            return null;
        },

        // Initialize auth state - simple session restoration
        async init() {
            if (this._initializing) {
                return;
            }

            if (this._initialized) {
                return;
            }

            this._initializing = true;
            this.inProgress = true;
            this.error = null;

            // Hoisted so the post-init background team load (below) can read it.
            let appwriteConfig = null;

            try {
                const appwrite = await config.getAppwriteClient();
                if (!appwrite) {
                    this._initialized = true;
                    this._initializing = false;
                    this.inProgress = false;
                    return;
                }

                this._appwrite = appwrite;

                // Get auth methods config from manifest
                appwriteConfig = await config.getAppwriteConfig();
                this._guestAuto = appwriteConfig?.guestAuto === true;
                this._guestManual = appwriteConfig?.guestManual === true;
                this.guestManualEnabled = appwriteConfig?.guestManual === true;

                // Try to restore existing session
                try {
                    await this._restoreSession(appwrite);

                    // Team loading is deferred (not awaited) — runs in the background after
                    // manifest:auth:initialized so a session gate isn't held up by it.
                } catch (error) {
                    this._clearIdentity();
                    // Signed out for now; other tabs keep their session
                    if (!isNoSession(error)) {
                        this._sessionUnverified = true;
                        scheduleRecheck(this);
                        console.warn('[Manifest Appwrite Auth] Session check failed (signed out until reachable):', error?.message || error);
                    }
                }

                // Sync state to localStorage
                syncStateToStorage(this);
            } catch (error) {
                // Passive lifecycle step: resolve to signed-out and log. Don't set
                // $auth.error — that's reserved for user-actionable sign-in failures.
                console.warn('[Manifest Appwrite Auth] Session restore failed (treating as signed out):', error?.message || error);
                this.isAuthenticated = false;
                this.isAnonymous = false;
            } finally {
                this.inProgress = false;
                this._initialized = true;
                this._initializing = false;

                // Guest-auto / callback sign-in follows: scoped data holds instead of flashing signed-out.
                // Not while unverified: nothing signs in until Appwrite is reachable (the recheck handles it)
                if (!this.isAuthenticated && !this._sessionUnverified) {
                    let callback = false;
                    try {
                        // Team invites need an existing session (acceptInvite refuses signed-out), so they don't sign in
                        const info = window.ManifestAppwriteAuthCallbacks?.detect?.();
                        callback = !!(info?.hasCallback && !info.isTeamInvite);
                    } catch (e) { /* no-op */ }
                    if (this._guestAuto || callback) this._signInPendingUntil = Date.now() + SIGN_IN_PENDING_MS;
                }

                // Fire as soon as identity is known, before teams load, so a session
                // gate / splash clears in a few hundred ms.
                window.dispatchEvent(new CustomEvent('manifest:auth:initialized', {
                    detail: {
                        isAuthenticated: this.isAuthenticated,
                        isAnonymous: this.isAnonymous
                    }
                }));
            }

            // Background load + seed teams after init. Populates reactively; fires
            // manifest:auth:teams-loaded for anything needing the full set.
            if (appwriteConfig && this.isAuthenticated && appwriteConfig.teams
                && (!this.isAnonymous || appwriteConfig.guestTeams)) {
                this._loadTeamsAndSeed(appwriteConfig)
                    .then(() => window.dispatchEvent(new CustomEvent('manifest:auth:teams-loaded', {
                        detail: { teams: this.teams, currentTeam: this.currentTeam }
                    })))
                    .catch(e => console.warn('[Manifest Appwrite Auth] Background team load failed:', e?.message || e));
            }
        },

        // Adopt the session Appwrite reports (throws when there is none or it is unreachable)
        async _restoreSession(appwrite, isCurrent = () => true) {
            const user = await appwrite.account.get();
            const sessionsResponse = await appwrite.account.listSessions();
            if (!isCurrent()) return false;
            this.user = user;
            const allSessions = sessionsResponse.sessions || [];
            const currentSession = allSessions.find(s => s.current === true) || allSessions[0];

            if (currentSession) {
                this.session = currentSession;
                this.isAuthenticated = true;
                this.isAnonymous = currentSession.provider === 'anonymous';

                // Restore OAuth provider from storage (persists across redirects/refresh)
                if (!this.isAnonymous && currentSession.provider !== 'magic-url') {
                    try {
                        // Try localStorage first (persists across redirects), fallback to sessionStorage
                        let storedProvider = localStorage.getItem('manifest:oauth:provider');
                        if (!storedProvider) {
                            storedProvider = sessionStorage.getItem('manifest:oauth:provider');
                        }
                        if (storedProvider) {
                            this._oauthProvider = storedProvider;
                        }
                    } catch (e) {
                        // Storage error
                    }
                }

                // If guest is disabled but we have anonymous session, clear it
                if (this.isAnonymous && !this._guestAuto && !this._guestManual) {
                    try {
                        await appwrite.account.deleteSession(this.session.$id);
                        this.isAuthenticated = false;
                        this.isAnonymous = false;
                        this.user = null;
                        this.session = null;
                    } catch (deleteError) {
                        // Failed to delete guest session
                    }
                }
            } else {
                this.isAuthenticated = true; // User exists, session might be managed by cookies
                this.isAnonymous = false;
            }
            return true;
        },

        // Offline-booted tab: re-run the session check once Appwrite is reachable
        async _recheckSession() {
            if (!this._sessionUnverified || this._rechecking || !this._appwrite) return;
            if (this._recheckTimer) { clearTimeout(this._recheckTimer); this._recheckTimer = null; }
            this._rechecking = true;
            const epoch = this._authEpoch;
            const current = () => this._authEpoch === epoch && this._sessionUnverified && !this.isAuthenticated;
            try {
                if (!await this._restoreSession(this._appwrite, current)) return;
            } catch (error) {
                if (!current()) return;
                if (!isNoSession(error)) { scheduleRecheck(this); return; }
                const prevId = shownUserId(this);
                this._clearIdentity();
                markVerified(this);
                syncStateToStorage(this);
                // Rows shown for the last-known user drop
                if (prevId) window.dispatchEvent(new CustomEvent('manifest:auth:session-cleared'));
                if (this._guestAuto && this._createAnonymousSession) await this._createAnonymousSession();
                return;
            } finally {
                this._rechecking = false;
            }
            markVerified(this);
            const cfg = await config.getAppwriteConfig();
            if (this._authEpoch !== epoch) return;
            if (this.isAuthenticated && cfg?.teams && (!this.isAnonymous || cfg.guestTeams)) {
                try { await this._loadTeamsAndSeed(cfg); } catch (e) { console.warn('[Manifest Appwrite Auth] Team load failed:', e?.message || e); }
                if (this._authEpoch !== epoch) return;
            }
            syncStateToStorage(this);
            if (this.isAuthenticated) {
                window.dispatchEvent(new CustomEvent(this.isAnonymous ? 'manifest:auth:anonymous' : 'manifest:auth:login', { detail: { user: this.user } }));
            }
        },

        _clearIdentity() {
            this.isAuthenticated = false;
            this.isAnonymous = false;
            this.user = null;
            this.session = null;
        },

        // Clear team state when the identity changes to a different user (e.g. guest
        // replaced on OTP sign-in). Otherwise stale currentTeam/teams cause 404s.
        _resetTeamsState() {
            this.teams = [];
            this.currentTeam = null;
            this.currentTeamMemberships = [];
            this.deletedTemplateTeams = [];
            this.deletedTemplateRoles = [];
            this._teamImmutableCache = {};
            if (this.stopTeamsRealtime) {
                try { this.stopTeamsRealtime(); } catch (e) { /* ignore */ }
            }
        },

        // Call the deployed guest-migration function; the current session authenticates it.
        // Returns parsed JSON, or null on failure (best-effort — never blocks sign-in).
        async _callGuestMigration(path, body) {
            const appwriteConfig = await config.getAppwriteConfig();
            const fnId = appwriteConfig?.guestMigrationFunctionId;
            if (!fnId || !this._appwrite?.functions) {
                return null;
            }
            try {
                const exec = await this._appwrite.functions.createExecution(
                    fnId, JSON.stringify(body || {}), false, path, 'POST'
                );
                const raw = exec?.responseBody ?? exec?.response ?? '';
                try { return JSON.parse(raw); } catch (e) { return null; }
            } catch (e) {
                console.warn(`[Manifest Appwrite Auth] Guest migration ${path} failed:`, e.message);
                return null;
            }
        },

        // Load the user's teams and seed configured defaults. Shared by the guest,
        // magic-link, OAuth, and init/restore paths.
        async _loadTeamsAndSeed(appwriteConfig) {
            const cfg = appwriteConfig || await config.getAppwriteConfig();
            if (!cfg?.teams) {
                return;
            }
            // Startup race: we can arrive before teams.core/defaults wire listTeams +
            // ensureDefaultTeams onto the store. Wait briefly rather than skip.
            const needsSeed = !!(cfg.permanentTeams || cfg.templateTeams);
            const ready = () => typeof this.listTeams === 'function'
                && (!needsSeed || typeof window.ManifestAppwriteAuthTeamsDefaults?.ensureDefaultTeams === 'function');
            for (let i = 0; i < 40 && !ready(); i++) {
                await new Promise(r => setTimeout(r, 50));
            }
            if (typeof this.listTeams !== 'function') {
                console.warn('[Manifest Appwrite Auth] Teams module never became ready; skipping team load/seed.');
                return;
            }
            // Always load the user's real teams. Capture the result — never seed defaults
            // off an unconfirmed team list: a failed/incomplete load must not read as
            // "teamless" and mint a duplicate tenant (the settle-window mis-provision).
            const loadResult = await this.listTeams();
            if (!needsSeed) {
                return;
            }
            if (loadResult && loadResult.success === false) {
                console.warn('[Manifest Appwrite Auth] Team list did not load; skipping seed to avoid mis-provisioning.');
                return;
            }
            // Audience gate: seed defaults only for the configured session type. Guests
            // need teams.guests; authenticated (non-anonymous) sessions need
            // teams.authenticated (default true). Keeps a per-guest sandbox from being
            // minted for a signed-in user who already holds their real workspace.
            const audienceAllows = this.isAnonymous ? !!cfg.guestTeams : (cfg.authenticatedTeams !== false);
            if (!audienceAllows) {
                return;
            }
            if (window.ManifestAppwriteAuthTeamsDefaults?.ensureDefaultTeams) {
                await window.ManifestAppwriteAuthTeamsDefaults.ensureDefaultTeams(this);
            }
        },

        // Manually create guest session (only works if guest-manual is enabled)
        async createGuest() {
            if (!this._guestManual) {
                return { success: false, error: 'Manual guest creation is not enabled' };
            }

            if (this.isAuthenticated && !this.isAnonymous) {
                return { success: false, error: 'Already signed in. Please logout first.' };
            }

            if (this.isAnonymous) {
                return { success: true, user: this.user, message: 'Already a guest' };
            }

            // Use the internal method if available, otherwise create it inline
            if (this._createAnonymousSession) {
                return await this._createAnonymousSession();
            }

            // Fallback: create anonymous session directly
            if (!this._appwrite) {
                this._appwrite = await config.getAppwriteClient();
            }
            if (!this._appwrite) {
                return { success: false, error: 'Appwrite not configured' };
            }

            this.inProgress = true;

            try {
                const session = await this._appwrite.account.createAnonymousSession();
                this.session = session;
                this.user = await this._appwrite.account.get();
                this.isAuthenticated = true;
                this.isAnonymous = true;
                this._oauthProvider = null;
                try {
                    localStorage.removeItem('manifest:oauth:provider');
                    sessionStorage.removeItem('manifest:oauth:provider');
                } catch (e) {
                    // Ignore
                }

                // Guests are full sessions and can own teams: seed defaults when
                // guestTeams is enabled, otherwise none.
                const cfg = await config.getAppwriteConfig();
                if (cfg?.guestTeams) {
                    await this._loadTeamsAndSeed(cfg);
                } else {
                    this.teams = [];
                    this.currentTeam = null;
                }

                syncStateToStorage(this);
                window.dispatchEvent(new CustomEvent('manifest:auth:anonymous', {
                    detail: { user: this.user }
                }));

                return { success: true, user: this.user };
            } catch (error) {
                this.error = error.message;
                this.isAuthenticated = false;
                this.isAnonymous = false;
                return { success: false, error: error.message };
            } finally {
                this.inProgress = false;
            }
        },

        // Convenience method: request guest session with automatic error handling
        async requestGuest() {
            const result = await this.createGuest();

            // Automatically handle errors
            if (!result.success) {
                this.error = result.error;
            } else {
                this.error = null;
            }

            return result;
        },

        // Logout from current session (works for both guest and authenticated sessions)
        async logout() {
            if (!this._appwrite) {
                return { success: false, error: 'Appwrite not configured' };
            }

            // A ticket kept from a failed guest OTP must not outlive an explicit logout
            this._otpMigrationTicket = null;

            // If not authenticated, nothing to logout from
            if (!this.isAuthenticated) {
                return { success: true };
            }

            this._authEpoch++;
            markVerified(this);
            this.inProgress = true;

            try {
                // Delete current session (works for guest, magic link, and OAuth sessions)
                if (this.session) {
                    await this._appwrite.account.deleteSession(this.session.$id);
                }

                // Clear OAuth provider on logout
                this._oauthProvider = null;
                try {
                    localStorage.removeItem('manifest:oauth:provider');
                    sessionStorage.removeItem('manifest:oauth:provider');
                } catch (e) {
                    // Ignore
                }

                // Clear magic link flags
                this.magicLinkSent = false;
                this.magicLinkExpired = false;

                // Clear OTP flags (email/phone)
                this.otpSent = false;
                this.otpExpired = false;
                this.otpPhrase = null;
                this._otpUserId = null;

                // Stop teams realtime subscription if active
                if (this.stopTeamsRealtime) {
                    this.stopTeamsRealtime();
                }

                // Stop teams polling if active (fallback)
                if (this.stopTeamsPolling) {
                    this.stopTeamsPolling();
                }

                // Clear teams on logout
                this.teams = [];
                this.currentTeam = null;

                // Restore to guest state after logout (guest-auto only, and not when
                // already a guest — don't mint a new guest on top).
                let restored = false;
                if (!this.isAnonymous && this._guestAuto && this._createAnonymousSession) {
                    await this._createAnonymousSession();
                    restored = this.isAuthenticated && this.isAnonymous;
                }
                if (!restored) this._clearIdentity();

                syncStateToStorage(this);
                window.dispatchEvent(new CustomEvent('manifest:auth:logout'));
                return { success: true };
            } catch (error) {
                this.error = error.message;
                // If guest-auto is enabled and we were logged out from a non-guest session, try to restore guest
                if (!this.isAnonymous && this._guestAuto && this._createAnonymousSession) {
                    try {
                        await this._createAnonymousSession();
                    } catch (guestError) {
                        // Fall through to clear state
                        this.isAuthenticated = false;
                        this.isAnonymous = false;
                        this.user = null;
                        this.session = null;
                    }
                } else {
                    // Clear auth state completely
                    this.isAuthenticated = false;
                    this.isAnonymous = false;
                    this.user = null;
                    this.session = null;
                }
                // Stop teams realtime subscription if active
                if (this.stopTeamsRealtime) {
                    this.stopTeamsRealtime();
                }

                // Stop teams polling if active (fallback)
                if (this.stopTeamsPolling) {
                    this.stopTeamsPolling();
                }

                // Clear teams on logout error too
                this.teams = [];
                this.currentTeam = null;
                if (!this.isAuthenticated) this._clearIdentity();
                // Expired session (401) is still a logout: scoped data must drop the old rows
                syncStateToStorage(this);
                window.dispatchEvent(new CustomEvent('manifest:auth:logout'));
                return { success: false, error: error.message };
            } finally {
                this.inProgress = false;
            }
        },

        // Clear current session
        async clearSession() {
            if (!this._appwrite) {
                return { success: false, error: 'Appwrite not configured' };
            }

            this._authEpoch++;
            markVerified(this);
            this.inProgress = true;

            try {
                if (this.session) {
                    await this._appwrite.account.deleteSession(this.session.$id);
                }

                this.isAuthenticated = false;
                this.isAnonymous = false;
                this.user = null;
                this.session = null;
                this.magicLinkSent = false;
                this.magicLinkExpired = false;
                this.error = null;
                this._oauthProvider = null;

                // Clear teams
                this.teams = [];
                this.currentTeam = null;

                // Clear OAuth provider from storage
                try {
                    localStorage.removeItem('manifest:oauth:provider');
                    sessionStorage.removeItem('manifest:oauth:provider');
                } catch (e) {
                    // Ignore
                }

                syncStateToStorage(this);
                window.dispatchEvent(new CustomEvent('manifest:auth:session-cleared'));
                return { success: true };
            } catch (error) {
                this.error = error.message;
                this.isAuthenticated = false;
                this.isAnonymous = false;
                this.user = null;
                this.session = null;
                this.magicLinkSent = false;
                this.magicLinkExpired = false;
                this.teams = [];
                this.currentTeam = null;
                syncStateToStorage(this);
                window.dispatchEvent(new CustomEvent('manifest:auth:session-cleared'));
                return { success: false, error: error.message };
            } finally {
                this.inProgress = false;
            }
        },

        // Refresh user data
        async refresh() {
            if (!this._appwrite) {
                throw new Error('Appwrite not configured');
            }

            try {
                this.user = await this._appwrite.account.get();
                if (this.isAuthenticated) markVerified(this);
                syncStateToStorage(this);
                return this.user;
            } catch (error) {
                if (!isNoSession(error)) throw error;
                const prevId = shownUserId(this);
                markVerified(this);
                this.isAuthenticated = false;
                this.isAnonymous = false;
                this.user = null;
                this.session = null;
                syncStateToStorage(this);
                if (prevId) {
                    this.teams = [];
                    this.currentTeam = null;
                    window.dispatchEvent(new CustomEvent('manifest:auth:session-cleared'));
                }
                throw error;
            }
        }
    };

    Alpine.store('auth', authStore);
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeAuthStore();
    } catch (error) {
        // Failed to initialize store
    }
});

// Export store interface
window.ManifestAppwriteAuthStore = {
    initialize: initializeAuthStore
};