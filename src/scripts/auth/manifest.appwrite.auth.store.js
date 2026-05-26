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

    // Whitelist of Appwrite Session fields safe to mirror across tabs.
    // CRITICALLY excludes `secret` (the bearer credential), `providerAccessToken`,
    // `providerRefreshToken`, and `providerAccessTokenExpiry`. The cookie set
    // on the Appwrite domain is the actual auth of record; this localStorage
    // copy only supports UI cross-tab sync ("someone just logged in here").
    // An XSS on this origin must not be able to lift session secrets out.
    const SAFE_SESSION_FIELDS = [
        '$id', 'userId', 'provider', 'expire', 'current',
        'clientName', 'osName', 'osCode', 'deviceName',
        'deviceBrand', 'deviceModel', 'countryCode', 'countryName'
    ];

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
                    // Update store state from other tab
                    store.isAuthenticated = state.isAuthenticated;
                    store.isAnonymous = state.isAnonymous;
                    store.user = state.user;
                    store.session = state.session;
                    store.magicLinkSent = state.magicLinkSent || false;
                    store.magicLinkExpired = state.magicLinkExpired || false;
                    store.error = state.error;
                }
            } catch (error) {
                // Failed to sync state from other tab
            }
        }
    });

    // Helper to sync state to localStorage (for cross-tab communication)
    function syncStateToStorage(store) {
        try {
            const state = {
                isAuthenticated: store.isAuthenticated,
                isAnonymous: store.isAnonymous,
                user: store.user,
                session: sanitizeSessionForStorage(store.session),
                magicLinkSent: store.magicLinkSent,
                magicLinkExpired: store.magicLinkExpired,
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
            // This is async, so we can't use a getter directly
            // Return null and let users call getPersonalTeam() or getDefaultTeams() directly
            return null;
        },

        // Get authentication method (oauth, magic, anonymous)
        getMethod() {
            if (!this.session) return null;
            const provider = this.session.provider;
            if (provider === 'anonymous') return 'anonymous';
            if (provider === 'magic-url') return 'magic';
            // OAuth providers return their name (google, github, etc.)
            if (provider && provider !== 'anonymous' && provider !== 'magic-url') return 'oauth';
            return null;
        },

        // Get OAuth provider name (google, github, etc.) or null for non-OAuth methods
        // Uses stored provider from loginOAuth() call, or falls back to session.provider
        // For existing sessions without stored provider, triggers async fetch from Appwrite identities
        getProvider() {
            if (!this.session) {
                return null;
            }
            const sessionProvider = this.session.provider;

            // For OAuth, return the stored provider name (google, github, etc.)
            // session.provider returns "oauth2" generically, so we use _oauthProvider
            if (sessionProvider && sessionProvider !== 'anonymous' && sessionProvider !== 'magic-url') {
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
                const appwriteConfig = await config.getAppwriteConfig();
                this._guestAuto = appwriteConfig?.guestAuto === true;
                this._guestManual = appwriteConfig?.guestManual === true;
                this.guestManualEnabled = appwriteConfig?.guestManual === true;

                // Try to restore existing session
                try {
                    this.user = await appwrite.account.get();
                    const sessionsResponse = await appwrite.account.listSessions();
                    const allSessions = sessionsResponse.sessions || [];
                    const currentSession = allSessions.find(s => s.current === true) || allSessions[0];

                    if (currentSession) {
                        this.session = currentSession;
                        this.isAuthenticated = true;
                        this.isAnonymous = currentSession.provider === 'anonymous';

                        // Restore OAuth provider from localStorage if available (persists across redirects)
                        // This ensures provider name persists across page refreshes
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

                    // Load teams if enabled and user is authenticated
                    if (this.isAuthenticated && appwriteConfig?.teams && this.listTeams) {
                        try {
                            await this.listTeams();
                            // Auto-create default teams if enabled
                            if ((appwriteConfig.permanentTeams || appwriteConfig.templateTeams) && window.ManifestAppwriteAuthTeamsDefaults?.ensureDefaultTeams) {
                                await window.ManifestAppwriteAuthTeamsDefaults.ensureDefaultTeams(this);
                            }
                        } catch (teamsError) {
                            // Don't fail initialization if teams fail to load
                        }
                    }
                } catch (error) {
                    // No existing session - this is expected
                    this.isAuthenticated = false;
                    this.isAnonymous = false;
                    this.user = null;
                    this.session = null;
                }

                // Sync state to localStorage
                syncStateToStorage(this);
            } catch (error) {
                this.error = error.message;
                this.isAuthenticated = false;
                this.isAnonymous = false;
            } finally {
                this.inProgress = false;
                this._initialized = true;
                this._initializing = false;

                // Dispatch initialized event - let callback handlers process after
                window.dispatchEvent(new CustomEvent('manifest:auth:initialized', {
                    detail: {
                        isAuthenticated: this.isAuthenticated,
                        isAnonymous: this.isAnonymous
                    }
                }));
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

                // Clear teams for guest sessions (guests don't have teams)
                this.teams = [];
                this.currentTeam = null;

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

            // If not authenticated, nothing to logout from
            if (!this.isAuthenticated) {
                return { success: true };
            }

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

                // Clear deleted teams tracking for this user (optional - uncomment if you want to clear on logout)
                // try {
                //     const userId = this.user?.$id;
                //     if (userId) {
                //         localStorage.removeItem(`manifest:deleted-teams:${userId}`);
                //     }
                // } catch (e) {
                //     // Ignore
                // }

                // Restore to guest state after logout (if guest-auto is enabled)
                // This only applies to non-guest sessions - if logging out from guest, don't create a new guest
                if (!this.isAnonymous && this._guestAuto && this._createAnonymousSession) {
                    await this._createAnonymousSession();
                } else {
                    // Clear auth state completely
                    this.isAuthenticated = false;
                    this.isAnonymous = false;
                    this.user = null;
                    this.session = null;
                }

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
                syncStateToStorage(this);
                return this.user;
            } catch (error) {
                // Session may have expired
                this.isAuthenticated = false;
                this.isAnonymous = false;
                this.user = null;
                this.session = null;
                syncStateToStorage(this);
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