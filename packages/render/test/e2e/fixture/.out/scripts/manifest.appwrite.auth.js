/*  Manifest Appwrite Auth
/*  By Andrew Matlock under MIT license
/*  https://github.com/andrewmatlock/Manifest
/*
/*  Supports authentication with an Appwrite project
/*  Requires Alpine JS (alpinejs.dev) to operate
*/

/* Auth config */

// Load manifest if not already loaded (loader may set __manifestLoaded / registry.manifest)
async function ensureManifest() {
    if (window.ManifestComponentsRegistry?.manifest) {
        return window.ManifestComponentsRegistry.manifest;
    }
    if (window.__manifestLoaded) {
        return window.__manifestLoaded;
    }

    try {
        const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
        const response = await fetch(manifestUrl);
        return await response.json();
    } catch (error) {
        return null;
    }
}

// Get Appwrite config from manifest
async function getAppwriteConfig() {
    const manifest = await ensureManifest();
    if (!manifest?.appwrite) {
        return null;
    }

    const appwriteConfig = manifest.appwrite;
    const endpoint = appwriteConfig.endpoint;
    const projectId = appwriteConfig.projectId;
    const devKey = appwriteConfig.devKey; // Optional dev key to bypass rate limits in development

    if (!endpoint || !projectId) {
        return null;
    }

    // Get auth methods from config (defaults to ["magic", "oauth"] if not specified)
    const authMethods = appwriteConfig.auth?.methods || ["magic", "oauth"];

    // Guest session support: "guest-auto" = automatic, "guest-manual" = manual only
    const guestAuto = authMethods.includes("guest-auto");
    const guestManual = authMethods.includes("guest-manual");
    const hasGuest = guestAuto || guestManual;

    const magicEnabled = authMethods.includes("magic");
    const oauthEnabled = authMethods.includes("oauth");

    // Teams support: presence of teams object enables it
    const teamsEnabled = !!appwriteConfig.auth?.teams;
    const permanentTeams = appwriteConfig.auth?.teams?.permanent || null; // Array of team names (immutable)
    const templateTeams = appwriteConfig.auth?.teams?.template || null; // Array of team names (can be deleted and reapplied)
    const teamsPollInterval = appwriteConfig.auth?.teams?.pollInterval || null; // Polling interval in milliseconds (null = disabled)

    // Default roles: permanent (cannot be deleted) and template (can be deleted)
    // These are objects mapping role names to permissions: { "Admin": ["inviteMembers", ...] }
    const permanentRoles = appwriteConfig.auth?.roles?.permanent || null; // Object: { "RoleName": ["permission1", ...] }
    const templateRoles = appwriteConfig.auth?.roles?.template || null; // Object: { "RoleName": ["permission1", ...] }

    // Member roles: derived from permanent and template roles (merged)
    // This is used for role normalization, permission checking, and creatorRole logic
    const memberRoles = permanentRoles || templateRoles
        ? { ...(permanentRoles || {}), ...(templateRoles || {}) }
        : (appwriteConfig.auth?.memberRoles || null); // Fallback to legacy memberRoles if roles not defined

    // Creator role: string reference to a role in memberRoles (role creator gets by default)
    const creatorRole = appwriteConfig.auth?.creatorRole || null;

    return {
        endpoint,
        projectId,
        devKey, // Optional dev key for development
        authMethods,
        guest: hasGuest,
        guestAuto: guestAuto,
        guestManual: guestManual,
        anonymous: guestAuto, // For backwards compatibility with existing code
        magic: magicEnabled,
        oauth: oauthEnabled,
        teams: teamsEnabled,
        permanentTeams: permanentTeams, // Array of team names (cannot be deleted)
        templateTeams: templateTeams, // Array of team names (can be deleted and reapplied)
        teamsPollInterval: teamsPollInterval, // Polling interval in milliseconds (null = disabled)
        memberRoles: memberRoles, // Role definitions: { "RoleName": ["permission1", "permission2"] }
        permanentRoles: permanentRoles, // Object: { "RoleName": ["permission1", ...] } (cannot be deleted)
        templateRoles: templateRoles, // Object: { "RoleName": ["permission1", ...] } (can be deleted)
        creatorRole: creatorRole // String reference to memberRoles key
    };
}

// Initialize Appwrite client (assumes SDK loaded separately)
let appwriteClient = null;
let appwriteAccount = null;
let appwriteTeams = null;
let appwriteUsers = null;

async function getAppwriteClient() {
    // Check if Appwrite SDK is loaded
    if (!window.Appwrite || !window.Appwrite.Client || !window.Appwrite.Account) {
        return null;
    }

    if (!appwriteClient) {
        const config = await getAppwriteConfig();
        if (!config) {
            return null;
        }

        appwriteClient = new window.Appwrite.Client()
            .setEndpoint(config.endpoint)
            .setProject(config.projectId);

        // Add dev key header if provided (bypasses rate limits in development)
        // See: https://appwrite.io/docs/advanced/platform/rate-limits#dev-keys
        if (config.devKey) {
            appwriteClient.headers['X-Appwrite-Dev-Key'] = config.devKey;
        }

        appwriteAccount = new window.Appwrite.Account(appwriteClient);
        appwriteTeams = new window.Appwrite.Teams(appwriteClient);

        // Initialize Users service if available (for fetching user details)
        if (window.Appwrite.Users) {
            appwriteUsers = new window.Appwrite.Users(appwriteClient);
        }
    }

    return {
        client: appwriteClient,
        account: appwriteAccount,
        teams: appwriteTeams,
        users: appwriteUsers, // Add users service for fetching user details
        realtime: window.Appwrite?.Realtime ? new window.Appwrite.Realtime(appwriteClient) : null // Realtime service for subscriptions
    };
}

// Export configuration interface
window.ManifestAppwriteAuthConfig = {
    getAppwriteConfig,
    getAppwriteClient,
    ensureManifest
};

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
                session: store.session,
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

/* Auth main */

// Initialize auth plugin - orchestrates all modules
let _pluginInitializing = false;
async function initializeAppwriteAuthPlugin() {
    if (_pluginInitializing) {
        return;
    }

    // Wait for dependencies
    if (!window.ManifestAppwriteAuthConfig) {
        return;
    }

    if (typeof Alpine === 'undefined') {
        return;
    }

    _pluginInitializing = true;

    // Wait for store to be ready
    const waitForStore = () => {
        const store = Alpine.store('auth');
        if (store) {
            // Initialize store first
            if (!store._initialized && !store._initializing) {
                store.init();
            }

            // After store init, process callbacks and validate config
            window.addEventListener('manifest:auth:initialized', async () => {
                // Validate role configuration if roles module is loaded
                if (store.validateRoleConfig) {
                    const validation = await store.validateRoleConfig();
                    if (!validation.valid) {
                        // Invalid role configuration
                    } else if (validation.warnings && validation.warnings.length > 0) {
                        // Validation warnings
                    }
                }

                // Process callbacks after store is initialized
                if (window.ManifestAppwriteAuthCallbacks) {
                    const callbackInfo = window.ManifestAppwriteAuthCallbacks.detect();
                    if (callbackInfo.hasCallback || callbackInfo.hasExpired) {
                        window.ManifestAppwriteAuthCallbacks.process(callbackInfo);
                    }
                }

                // If no session and guest-auto is enabled, create guest session
                if (!store.isAuthenticated && store._guestAuto && store._createAnonymousSession) {
                    store._createAnonymousSession();
                }
            }, { once: true });

            _pluginInitializing = false;
        } else {
            setTimeout(waitForStore, 50);
        }
    };

    // Start waiting after a short delay
    setTimeout(waitForStore, 150);
}

// Handle initialization
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.Alpine) initializeAppwriteAuthPlugin();
    });
}

document.addEventListener('alpine:init', initializeAppwriteAuthPlugin);

// Export main interface
window.ManifestAppwriteAuth = {
    initialize: initializeAppwriteAuthPlugin
};

/* Auth frontend */

// Create a safe fallback proxy for undefined properties (similar to data proxies)
let authLoadingProxy = null;
function createAuthLoadingProxy() {
    if (authLoadingProxy) {
        return authLoadingProxy;
    }

    const fallback = Object.create(null);
    fallback[Symbol.toPrimitive] = function (hint) {
        return hint === 'number' ? 0 : '';
    };
    fallback.valueOf = function () { return ''; };
    fallback.toString = function () { return ''; };

    Object.defineProperty(fallback, 'length', {
        value: 0,
        writable: false,
        enumerable: false,
        configurable: false
    });

    authLoadingProxy = new Proxy(fallback, {
        get(target, key) {
            if (key === Symbol.iterator) {
                return function* () { };
            }
            if (key === 'then' || key === 'catch' || key === 'finally' ||
                key === Symbol.toStringTag || key === Symbol.hasInstance ||
                key === 'constructor' || key === '__proto__' || key === 'prototype') {
                return undefined;
            }
            if (key in target || key === Symbol.toPrimitive) {
                const value = target[key];
                if (value !== undefined) {
                    return value;
                }
            }
            // Return proxy itself for safe chaining (allows $auth.user.email even if user is undefined)
            return authLoadingProxy;
        },
        has(target, key) {
            if (typeof key === 'string') {
                return true;
            }
            return key in target || key === Symbol.toPrimitive;
        }
    });

    return authLoadingProxy;
}

// Initialize $auth magic method
function initializeAuthMagic() {
    if (typeof Alpine === 'undefined') {
        return false;
    }

    // Add $auth magic method (like $locale, $theme)
    Alpine.magic('auth', () => {
        const store = Alpine.store('auth');
        if (!store) {
            return {};
        }

        return new Proxy({}, {
            get(target, prop) {
                // Handle special keys
                if (prop === Symbol.iterator || prop === 'then' || prop === 'catch' || prop === 'finally') {
                    return undefined;
                }

                // Direct store property access
                if (prop in store) {
                    const value = store[prop];
                    // If it's a function, bind it to store context
                    if (typeof value === 'function') {
                        return value.bind(store);
                    }
                    // CRITICAL: If property exists but is not a function, check if it should be a convenience method
                    // This handles cases where the store was recreated and methods are missing
                    if (typeof prop === 'string') {
                        const convenienceMethodNames = [
                            'isCreatingTeam', 'isUpdatingTeam', 'isDeletingTeam', 'isInvitingMember',
                            'isUpdatingMember', 'isDeletingMember', 'createTeamFromName', 'updateCurrentTeamName',
                            'inviteToCurrentTeam', 'viewTeam', 'isCurrentTeamOwner', 'isTeamDeletable',
                            'isTeamRenamable', 'hasTeamPermission', 'hasTeamPermissionSync', 'canManageRoles',
                            'canInviteMembers', 'canUpdateMembers', 'canRemoveMembers', 'canRenameTeam',
                            'canDeleteTeam', 'isRoleDeletable', 'isRoleBeingEdited', 'getCurrentTeamRoles',
                            'getUserRole', 'getUserRoles', 'getAllAvailablePermissions',
                            'isActionDisabled', 'isInviteRoleSelected', 'teamCreatedAt', 'teamUpdatedAt',
                            'getMemberDisplayName', 'getMemberEmail'
                        ];

                        if (convenienceMethodNames.includes(prop)) {
                            // This should be a function but isn't - try to reinitialize synchronously
                            if (window.ManifestAppwriteAuthTeamsConvenience && window.ManifestAppwriteAuthTeamsConvenience.initialize) {
                                try {
                                    // Call initialize which will check and re-add methods if needed
                                    window.ManifestAppwriteAuthTeamsConvenience.initialize();
                                    // Immediately check again - initialize should have added the method
                                    const reinitializedValue = store[prop];
                                    if (typeof reinitializedValue === 'function') {
                                        return reinitializedValue.bind(store);
                                    }
                                } catch (error) {
                                    // Failed to reinitialize, continue to fallback
                                }
                            }
                            // Return a safe fallback function that returns false/empty
                            // This prevents "is not a function" errors while methods are being reinitialized
                            if (prop.startsWith('is') || prop.startsWith('can') || prop.startsWith('has')) {
                                return () => false;
                            }
                            if (prop.startsWith('getAll')) {
                                return () => Promise.resolve([]);
                            }
                            if (prop.startsWith('get')) {
                                return () => null;
                            }
                            return () => ({ success: false, error: 'Method not initialized' });
                        }
                    }
                    // CRITICAL: Handle null values - return loading proxy to allow safe chaining
                    // This prevents errors when accessing $auth.user.email when user is null
                    if (value === null || value === undefined) {
                        return createAuthLoadingProxy();
                    }
                    // If value is an array, return it as-is (arrays are already iterable and don't need proxying)
                    if (Array.isArray(value)) {
                        return value;
                    }
                    // If value is an object, wrap it in a proxy for safe nested property access
                    if (typeof value === 'object' && value !== null) {
                        // Recursive helper function for nested object proxying
                        function createNestedAuthProxy(objTarget) {
                            return new Proxy(objTarget, {
                                get(objTarget, key) {
                                    // Handle special keys
                                    if (key === Symbol.iterator || key === 'then' || key === 'catch' || key === 'finally') {
                                        return undefined;
                                    }
                                    const nestedValue = objTarget[key];
                                    // If nested value is undefined or null, return loading proxy for safe chaining
                                    if (nestedValue === undefined || nestedValue === null) {
                                        return createAuthLoadingProxy();
                                    }
                                    // If nested value is an array, return it as-is
                                    if (Array.isArray(nestedValue)) {
                                        return nestedValue;
                                    }
                                    // If nested value is an object, wrap recursively
                                    if (typeof nestedValue === 'object' && nestedValue !== null) {
                                        return createNestedAuthProxy(nestedValue);
                                    }
                                    return nestedValue;
                                }
                            });
                        }
                        return createNestedAuthProxy(value);
                    }
                    return value;
                }

                // CRITICAL: If property doesn't exist, check if convenience methods need reinitialization
                // This prevents "$auth.isCreatingTeam is not a function" errors after idle/reinitialization
                // Only check for known convenience method names to avoid unnecessary work
                const convenienceMethodNames = [
                    'isCreatingTeam', 'isUpdatingTeam', 'isDeletingTeam', 'isInvitingMember',
                    'isUpdatingMember', 'isDeletingMember', 'createTeamFromName', 'updateCurrentTeamName',
                    'inviteToCurrentTeam', 'viewTeam', 'isCurrentTeamOwner', 'isTeamDeletable',
                    'isTeamRenamable', 'hasTeamPermission', 'hasTeamPermissionSync', 'canManageRoles',
                    'canInviteMembers', 'canUpdateMembers', 'canRemoveMembers', 'canRenameTeam',
                    'canDeleteTeam', 'isRoleDeletable', 'isRoleBeingEdited', 'getCurrentTeamRoles',
                    'getUserRole', 'getUserRoles', 'getAllAvailablePermissions',
                    'isActionDisabled', 'isInviteRoleSelected', 'teamCreatedAt', 'teamUpdatedAt',
                    'getMemberDisplayName', 'getMemberEmail'
                ];

                if (typeof prop === 'string' && convenienceMethodNames.includes(prop)) {
                    const currentStore = Alpine.store('auth');
                    if (currentStore && (!currentStore[prop] || typeof currentStore[prop] !== 'function')) {
                        // Method is missing, try to reinitialize convenience methods
                        if (window.ManifestAppwriteAuthTeamsConvenience && window.ManifestAppwriteAuthTeamsConvenience.initialize) {
                            try {
                                window.ManifestAppwriteAuthTeamsConvenience.initialize();
                                // After reinitialization, check if the property now exists
                                const reinitializedStore = Alpine.store('auth');
                                if (reinitializedStore && prop in reinitializedStore) {
                                    const reinitializedValue = reinitializedStore[prop];
                                    if (typeof reinitializedValue === 'function') {
                                        return reinitializedValue.bind(reinitializedStore);
                                    }
                                    return reinitializedValue;
                                }
                            } catch (error) {
                                // Failed to reinitialize, continue to fallback
                            }
                        }
                    }
                    // Safe fallback for convenience methods that failed to reinitialize
                    if (prop.startsWith('is') || prop.startsWith('can') || prop.startsWith('has')) {
                        return () => false;
                    }
                    if (prop.startsWith('getAll')) {
                        return () => Promise.resolve([]);
                    }
                    if (prop.startsWith('get') || prop.startsWith('team')) {
                        return () => null;
                    }
                    return () => ({ success: false, error: 'Method not initialized' });
                }

                // Special handling for computed properties
                if (prop === 'method') {
                    return store.getMethod();
                }

                if (prop === 'provider') {
                    // getProvider() is synchronous but may trigger async fetch in background
                    return store.getProvider();
                }

                // Return loading proxy for undefined properties to allow safe chaining
                return createAuthLoadingProxy();
            },
            set(target, prop, value) {
                // Forward assignments to the store for two-way binding (x-model)
                if (prop in store) {
                    store[prop] = value;
                    return true;
                }
                // Allow setting new properties (though they won't persist)
                target[prop] = value;
                return true;
            }
        });
    });

    return true;
}

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.Alpine) {
            initializeAuthMagic();
        }
    });
}

document.addEventListener('alpine:init', () => {
    try {
        initializeAuthMagic();
    } catch (error) {
        // Failed to initialize magic method
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeAuthMagic();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export magic interface
window.ManifestAppwriteAuthMagic = {
    initialize: initializeAuthMagic
};

/* Auth teams - Core operations */

// Add core team methods to auth store
function initializeTeamsCore() {
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
        if (store && !store.createTeam) {
            // Team creation
            store.createTeam = async function (teamId, name, roles = []) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                // Check if teams are enabled
                const appwriteConfig = await config.getAppwriteConfig();
                if (appwriteConfig && !appwriteConfig.teams) {
                    return { success: false, error: 'Teams are not enabled' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to create a team' };
                }

                // Set operation-specific loading state
                this._creatingTeam = true;
                this.error = null;

                try {
                    // Generate unique teamId if not provided
                    let finalTeamId = teamId;
                    if (!finalTeamId) {
                        if (window.Appwrite && window.Appwrite.ID && window.Appwrite.ID.unique) {
                            finalTeamId = window.Appwrite.ID.unique();
                        } else {
                            finalTeamId = 'team_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
                        }
                    }

                    // Determine initial roles for team creator
                    let creatorRoles = roles;
                    if (creatorRoles.length === 0) {
                        // If no roles specified, use creatorRole from config
                        const memberRoles = appwriteConfig?.memberRoles;
                        const creatorRoleName = appwriteConfig?.creatorRole;

                        if (memberRoles && creatorRoleName && memberRoles[creatorRoleName]) {
                            // Use specified creatorRole
                            creatorRoles = [creatorRoleName];
                        } else if (memberRoles && Object.keys(memberRoles).length > 0) {
                            // No creatorRole specified, find role with all owner permissions or use first
                            let foundRole = null;
                            for (const [roleName, permissions] of Object.entries(memberRoles)) {
                                if (this.roleHasAllOwnerPermissions && await this.roleHasAllOwnerPermissions(roleName)) {
                                    foundRole = roleName;
                                    break;
                                }
                            }
                            // If no role has all permissions, use first role
                            creatorRoles = [foundRole || Object.keys(memberRoles)[0]];
                        } else {
                            // No memberRoles defined - use Appwrite default (owner)
                            creatorRoles = ['owner'];
                        }
                    }

                    // Normalize custom roles for Appwrite (add "owner" if needed)
                    if (this.normalizeRolesForAppwrite) {
                        creatorRoles = await this.normalizeRolesForAppwrite(creatorRoles);
                    }

                    const result = await this._appwrite.teams.create(finalTeamId, name, creatorRoles);

                    // Apply default roles to the newly created team
                    if (window.ManifestAppwriteAuthTeamsRolesDefaults && this.ensureDefaultRoles) {
                        await this.ensureDefaultRoles(finalTeamId);
                    }

                    // Refresh teams list
                    await this.listTeams();

                    return { success: true, team: result };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._creatingTeam = false;
                }
            };

            // List user's teams
            store.listTeams = async function (queries = [], search = '') {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    console.warn('[Manifest Appwrite Auth] listTeams: User not authenticated');
                    return { success: false, error: 'You must be signed in to list teams' };
                }

                try {
                    const params = {
                        queries: queries
                    };
                    if (search && search.trim().length > 0) {
                        params.search = search;
                    }
                    const result = await this._appwrite.teams.list(params);

                    // Update store with teams
                    this.teams = result.teams || [];

                    // Update currentTeam if it exists and was updated
                    if (this.currentTeam && this.currentTeam.$id) {
                        const updatedCurrentTeam = this.teams?.find(t => t.$id === this.currentTeam.$id);
                        if (updatedCurrentTeam) {
                            // Only update if name changed (to avoid unnecessary reactivity triggers)
                            if (updatedCurrentTeam.name !== this.currentTeam.name) {
                                this.currentTeam = { ...updatedCurrentTeam };
                            }
                        }
                    }

                    // Cache immutable status for all teams (if defaults module is loaded)
                    if (window.ManifestAppwriteAuthTeamsDefaults && this.isTeamImmutable) {
                        for (const team of this.teams) {
                            if (!this._teamImmutableCache[team.$id]) {
                                this._teamImmutableCache[team.$id] = await this.isTeamImmutable(team.$id);
                            }
                        }
                    }

                    // Load deleted template teams (if defaults module is loaded)
                    if (window.ManifestAppwriteAuthTeamsDefaults && this.getDeletedTemplateTeams) {
                        this.deletedTemplateTeams = await this.getDeletedTemplateTeams();
                    }

                    // Clean up duplicate default teams (permanent/template) if any exist
                    if (window.ManifestAppwriteAuthTeamsDefaults && this.cleanupDuplicateDefaultTeams) {
                        const cleanupResult = await this.cleanupDuplicateDefaultTeams();
                        if (cleanupResult.cleaned > 0) {
                            if (cleanupResult.errors && cleanupResult.errors.length > 0) {
                                console.warn('[Manifest Appwrite Auth] Some duplicate teams could not be deleted:', cleanupResult.errors);
                            }
                            // Refresh teams list after cleanup
                            if (this.listTeams) {
                                await this.listTeams();
                            }
                        }
                    }

                    // Load deleted template roles for current team (if roles defaults module is loaded)
                    if (this.currentTeam && this.currentTeam.$id && window.ManifestAppwriteAuthTeamsRolesDefaults && this.getDeletedTemplateRoles) {
                        this.deletedTemplateRoles = await this.getDeletedTemplateRoles(this.currentTeam.$id);
                    }

                    // Set currentTeam to first default team if available and not already set
                    if (!this.currentTeam && this.teams.length > 0) {
                        const appwriteConfig = await config.getAppwriteConfig();
                        const hasDefaultTeams = (appwriteConfig?.permanentTeams && Array.isArray(appwriteConfig.permanentTeams) && appwriteConfig.permanentTeams.length > 0) ||
                            (appwriteConfig?.templateTeams && Array.isArray(appwriteConfig.templateTeams) && appwriteConfig.templateTeams.length > 0);

                        if (hasDefaultTeams && window.ManifestAppwriteAuthTeamsDefaults && this.getDefaultTeams) {
                            const defaultTeams = await this.getDefaultTeams();
                            if (defaultTeams.length > 0) {
                                this.currentTeam = defaultTeams[0];
                            } else {
                                this.currentTeam = this.teams[0];
                            }
                        } else {
                            this.currentTeam = this.teams[0];
                        }
                    }

                    // Auto-load memberships for current team (if members module is loaded)
                    if (this.currentTeam && this.currentTeam.$id && window.ManifestAppwriteAuthTeamsMembers && this.listMemberships) {
                        try {
                            const membershipsResult = await this.listMemberships(this.currentTeam.$id);
                            if (membershipsResult.success) {
                                this.currentTeamMemberships = membershipsResult.memberships || [];
                            }
                        } catch (error) {
                            // Silently handle errors (e.g., team was deleted)
                            // listMemberships already handles "team not found" gracefully
                            this.currentTeamMemberships = [];
                        }
                    }

                    // Start teams realtime subscription if available (only if not already subscribed)
                    // Also skip if we're in the middle of a realtime-triggered refresh
                    // Check for any truthy value (function, object, or true flag)
                    if (!this._teamsRealtimeUnsubscribe && !this._teamsRealtimeSubscribing) {
                        const appwriteConfig = await config.getAppwriteConfig();
                        if (this._appwrite?.realtime && this.startTeamsRealtime) {
                            this.startTeamsRealtime();
                        } else if (appwriteConfig?.teamsPollInterval && typeof appwriteConfig.teamsPollInterval === 'number' && appwriteConfig.teamsPollInterval > 0) {
                            // Fallback to polling if realtime not available
                            console.warn('[Manifest Appwrite Auth] Realtime not available, falling back to polling');
                            if (this.startTeamsPolling) {
                                this.startTeamsPolling(appwriteConfig.teamsPollInterval);
                            }
                        }
                    }

                    return { success: true, teams: result.teams || [], total: result.total || 0 };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                }
            };

            // Get team by ID
            store.getTeam = async function (teamId) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to get team details' };
                }

                try {
                    const result = await this._appwrite.teams.get({
                        teamId: teamId
                    });

                    return { success: true, team: result };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                }
            };

            // Update team name
            store.updateTeamName = async function (teamId, name) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to update team name' };
                }

                if (!teamId) {
                    return { success: false, error: 'Team ID is required' };
                }

                if (!name || !name.trim()) {
                    return { success: false, error: 'Team name is required' };
                }

                // Set operation-specific loading state
                this._updatingTeam = teamId;
                this.error = null;

                // Optimistically update the UI immediately
                const trimmedName = name.trim();
                const teamIndex = this.teams?.findIndex(t => t.$id === teamId);
                if (teamIndex !== undefined && teamIndex >= 0 && this.teams) {
                    // Optimistically update teams array
                    this.teams = [
                        ...this.teams.slice(0, teamIndex),
                        { ...this.teams[teamIndex], name: trimmedName },
                        ...this.teams.slice(teamIndex + 1)
                    ];
                }

                // Optimistically update currentTeam if it's the team being updated
                if (this.currentTeam && this.currentTeam.$id === teamId) {
                    this.currentTeam = { ...this.currentTeam, name: trimmedName };
                }

                try {
                    const result = await this._appwrite.teams.updateName(teamId, trimmedName);

                    // Use the result directly (it has the updated name from Appwrite)
                    const updatedTeam = result;

                    // Refresh teams list (this will update the teams array with server data)
                    await this.listTeams();

                    // Update currentTeam reference if it was the updated team
                    // Reassign the entire object to trigger Alpine reactivity
                    if (this.currentTeam && this.currentTeam.$id === teamId) {
                        // Use the result from Appwrite, or find it from the refreshed teams list
                        const refreshedTeam = this.teams?.find(t => t.$id === teamId) || updatedTeam;

                        if (refreshedTeam) {
                            // Force Alpine reactivity by creating a new object reference
                            // Alpine needs to see a new reference to trigger updates
                            this.currentTeam = { ...refreshedTeam };

                            // Also update the teams array reference in case it's being watched
                            const refreshedTeamIndex = this.teams?.findIndex(t => t.$id === teamId);
                            if (refreshedTeamIndex !== undefined && refreshedTeamIndex >= 0 && this.teams) {
                                // Create new array to trigger reactivity
                                this.teams = [
                                    ...this.teams.slice(0, refreshedTeamIndex),
                                    { ...refreshedTeam },
                                    ...this.teams.slice(refreshedTeamIndex + 1)
                                ];
                            }

                            // Use Alpine's nextTick if available to ensure reactivity is triggered
                            if (typeof Alpine !== 'undefined' && Alpine.nextTick) {
                                Alpine.nextTick(() => {
                                    // Ensure the update is visible
                                    this.currentTeam = refreshedTeam;
                                });
                            }
                        }
                    }

                    return { success: true, team: updatedTeam };
                } catch (error) {
                    // Revert optimistic update on error
                    const revertTeamIndex = this.teams?.findIndex(t => t.$id === teamId);
                    if (revertTeamIndex !== undefined && revertTeamIndex >= 0 && this.teams) {
                        // Find original team name from teams list (before optimistic update)
                        // Since we already refreshed, we need to reload to get the original
                        await this.listTeams();
                    }

                    // Revert currentTeam if it was updated
                    if (this.currentTeam && this.currentTeam.$id === teamId) {
                        const originalTeam = this.teams?.find(t => t.$id === teamId);
                        if (originalTeam) {
                            this.currentTeam = { ...originalTeam };
                        }
                    }

                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._updatingTeam = null;
                }
            };

            // Delete team
            store.deleteTeam = async function (teamId) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to delete a team' };
                }

                // Check if team is immutable
                if (this.isTeamImmutable) {
                    const isImmutable = await this.isTeamImmutable(teamId);
                    if (isImmutable) {
                        return { success: false, error: 'This team cannot be deleted' };
                    }
                }

                // Set operation-specific loading state
                this._deletingTeam = teamId;
                this.error = null;

                // Get team name before deletion (for tracking)
                const team = this.teams?.find(t => t.$id === teamId);
                const teamName = team?.name;

                // Optimistically remove team from UI immediately
                if (this.teams && Array.isArray(this.teams)) {
                    this.teams = this.teams.filter(t => t.$id !== teamId);
                }

                // Clear current team if it was deleted (before refreshing list to avoid loading memberships for deleted team)
                if (this.currentTeam && this.currentTeam.$id === teamId) {
                    this.currentTeam = null;
                    this.currentTeamMemberships = [];

                    // Select the first available team if any remain
                    if (this.teams && this.teams.length > 0) {
                        const remainingTeam = this.teams[0];
                        if (remainingTeam && this.viewTeam) {
                            // Don't await - let it happen in background
                            this.viewTeam(remainingTeam).catch(() => { });
                        } else if (remainingTeam) {
                            this.currentTeam = remainingTeam;
                        }
                    }
                }

                try {
                    await this._appwrite.teams.delete({
                        teamId: teamId
                    });

                    // Track deleted template team (don't recreate it, but allow reapplying)
                    if (teamName && window.ManifestAppwriteAuthTeamsDefaults) {
                        const config = await window.ManifestAppwriteAuthConfig.getAppwriteConfig();
                        if (config?.templateTeams && Array.isArray(config.templateTeams)) {
                            const resolvePersonalTeamName = window.ManifestAppwriteAuthTeamsDefaults.resolvePersonalTeamName;
                            // Check if this was a template team
                            for (const nameConfig of config.templateTeams) {
                                const resolvedName = await resolvePersonalTeamName(nameConfig);
                                if (resolvedName === teamName) {
                                    // Store deletion in localStorage (keyed by user ID)
                                    try {
                                        const userId = this.user?.$id;
                                        if (userId) {
                                            const key = `manifest:deleted-teams:${userId}`;
                                            const deleted = JSON.parse(localStorage.getItem(key) || '[]');
                                            if (!deleted.includes(teamName)) {
                                                deleted.push(teamName);
                                                localStorage.setItem(key, JSON.stringify(deleted));
                                            }
                                        }
                                    } catch (e) {
                                        console.warn('[Manifest Appwrite Auth] Failed to track deleted team:', e);
                                    }
                                    break;
                                }
                            }
                        }
                    }

                    // Refresh teams list to ensure consistency (but UI already updated optimistically)
                    await this.listTeams();

                    return { success: true };
                } catch (error) {
                    // Revert optimistic update on error - reload teams list
                    await this.listTeams();

                    // Restore currentTeam if it was the deleted team
                    if (!this.currentTeam && teamId) {
                        const restoredTeam = this.teams?.find(t => t.$id === teamId);
                        if (restoredTeam && this.viewTeam) {
                            await this.viewTeam(restoredTeam);
                        } else if (restoredTeam) {
                            this.currentTeam = restoredTeam;
                        }
                    }

                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._deletingTeam = null;
                }
            };

            // Duplicate team
            store.duplicateTeam = async function (teamId, options = {}) {
                const { newName, copyMembers = false, copyRoles = false } = options;

                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to duplicate a team' };
                }

                // Get the original team
                const originalTeam = this.teams?.find(t => t.$id === teamId);
                if (!originalTeam) {
                    return { success: false, error: 'Team not found' };
                }

                // Determine new team name
                let finalName = newName;
                if (!finalName) {
                    finalName = `${originalTeam.name} copy`;
                }

                // Set operation-specific loading state
                this._duplicatingTeam = teamId;
                this.error = null;

                try {
                    // Create new team with same roles as creator (if copyRoles is true)
                    let creatorRoles = [];
                    if (copyRoles && this.listMemberships) {
                        // Get memberships to find creator's roles
                        const membershipsResult = await this.listMemberships(teamId);
                        if (membershipsResult.success && membershipsResult.memberships) {
                            // Find current user's membership
                            const currentUserMembership = membershipsResult.memberships.find(
                                m => m.userId === this.user?.$id
                            );
                            if (currentUserMembership && currentUserMembership.roles) {
                                creatorRoles = Array.isArray(currentUserMembership.roles)
                                    ? currentUserMembership.roles
                                    : [currentUserMembership.roles];
                            }
                        }
                    }

                    // Create the duplicate team
                    const createResult = await this.createTeam(null, finalName, creatorRoles);
                    if (!createResult.success) {
                        return createResult;
                    }

                    const newTeam = createResult.team;
                    const newTeamId = newTeam.$id;

                    // Copy members if requested
                    if (copyMembers && this.listMemberships) {
                        const membershipsResult = await this.listMemberships(teamId);
                        if (membershipsResult.success && membershipsResult.memberships) {
                            // Get all memberships (excluding current user, who is already creator)
                            const otherMemberships = membershipsResult.memberships.filter(
                                m => m.userId !== this.user?.$id
                            );

                            // Invite each member with their original roles
                            for (const membership of otherMemberships) {
                                try {
                                    const roles = Array.isArray(membership.roles)
                                        ? membership.roles
                                        : (membership.roles ? [membership.roles] : ['owner']);

                                    // Use email if available, otherwise userId
                                    if (membership.email) {
                                        await this.inviteMember(newTeamId, roles, membership.email);
                                    } else if (membership.userId) {
                                        await this.inviteMember(newTeamId, roles, null, membership.userId);
                                    }
                                } catch (inviteError) {
                                    // Log but continue with other members
                                    console.warn(`[Manifest Appwrite Auth] Failed to invite member to duplicated team:`, inviteError);
                                }
                            }
                        }
                    }

                    // Refresh teams list
                    await this.listTeams();

                    return { success: true, team: newTeam };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._duplicatingTeam = false;
                }
            };

            // Get team preferences
            store.getTeamPrefs = async function (teamId) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to get team preferences' };
                }

                try {
                    const result = await this._appwrite.teams.getPrefs({
                        teamId: teamId
                    });

                    return { success: true, prefs: result };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                }
            };

            // Start realtime subscription for all auth entities (teams, memberships, account, roles/permissions)
            store.startTeamsRealtime = function () {
                // Don't subscribe if already subscribed (check for function, object, array, or true flag)
                if (this._teamsRealtimeUnsubscribe) {
                    return;
                }

                // Only subscribe if authenticated and realtime is available
                if (!this.isAuthenticated || !this._appwrite?.realtime) {
                    return;
                }

                const unsubscribes = [];

                try {
                    // Subscribe to teams channel (covers: team create/update/delete, team preferences/roles)
                    const teamsSubscription = this._appwrite.realtime.subscribe('teams', (response) => {
                        // Prevent recursive subscription (don't subscribe again when refreshing)
                        if (this._teamsRealtimeSubscribing) {
                            return;
                        }

                        // Handle different event types
                        if (response.events && Array.isArray(response.events)) {
                            let shouldRefreshTeams = false;

                            for (const event of response.events) {
                                // Event format can be: "teams.update", "teams.create", "teams.delete", 
                                // "teams.{teamId}", "teams *", etc.
                                const parts = event.split(/[.\s]+/);
                                const eventType = parts[0]; // 'teams', etc.
                                const action = parts[1]; // 'update', 'create', 'delete', or teamId

                                if (eventType === 'teams') {
                                    // Check if it's an action (update, create, delete) or a team-specific event
                                    // Note: team preferences (roles/permissions) updates trigger teams.update
                                    if (action === 'update' || action === 'create' || action === 'delete' || action === '*') {
                                        shouldRefreshTeams = true;
                                    } else if (action && action.length > 10) {
                                        // Likely a teamId (Appwrite IDs are long), treat as update
                                        shouldRefreshTeams = true;
                                    }
                                }
                            }

                            // Refresh teams list if needed (only once per event batch)
                            // This also refreshes roles/permissions since they're stored in team preferences
                            if (shouldRefreshTeams && !this._teamsRealtimeSubscribing) {
                                this._teamsRealtimeSubscribing = true;
                                if (this.listTeams) {
                                    this.listTeams().finally(() => {
                                        this._teamsRealtimeSubscribing = false;
                                    });
                                } else {
                                    this._teamsRealtimeSubscribing = false;
                                }
                            }
                        }
                    });

                    // Subscribe to memberships channel (covers: invite, accept, update roles, delete)
                    // Also subscribe to team-specific membership channels for better reactivity
                    const membershipsSubscription = this._appwrite.realtime.subscribe('memberships', (response) => {
                        // Prevent recursive subscription
                        if (this._teamsRealtimeSubscribing) {
                            return;
                        }

                        if (response.events && Array.isArray(response.events)) {
                            let shouldRefreshMemberships = false;
                            let affectedTeamId = null;

                            // First, check payload for teamId (most reliable source)
                            if (response.payload) {
                                // Check various possible payload structures
                                if (response.payload.teamId) {
                                    affectedTeamId = response.payload.teamId;
                                } else if (response.payload.team && response.payload.team.$id) {
                                    affectedTeamId = response.payload.team.$id;
                                } else if (response.payload.membership && response.payload.membership.teamId) {
                                    affectedTeamId = response.payload.membership.teamId;
                                }
                            }

                            for (const event of response.events) {
                                // Handle different event formats:
                                // - "memberships.update" (legacy format)
                                // - "memberships.delete" (legacy format)
                                // - "teams.{teamId}.memberships.{membershipId}.delete" (current format)
                                // - "teams.*.memberships.*.delete" (wildcard format)
                                // - "teams.{teamId}.memberships.*" (team-specific wildcard)
                                const parts = event.split(/[.\s]+/);
                                const eventType = parts[0]; // 'teams' or 'memberships'

                                // Check for both legacy format (memberships.*) and current format (teams.*.memberships.*)
                                if (eventType === 'memberships') {
                                    // Legacy format: "memberships.update", "memberships.delete", etc.
                                    const action = parts[1];

                                    // Check if second part is a teamId (long alphanumeric string)
                                    const possibleTeamId = parts[1];
                                    if (possibleTeamId && possibleTeamId.length > 10 && /^[a-f0-9]+$/i.test(possibleTeamId)) {
                                        // This is a team-specific event
                                        if (!affectedTeamId) {
                                            affectedTeamId = possibleTeamId;
                                        }
                                        const actionFromTeamId = parts[2];
                                        if (actionFromTeamId === 'create' || actionFromTeamId === 'update' || actionFromTeamId === 'delete' || actionFromTeamId === '*' || !actionFromTeamId) {
                                            shouldRefreshMemberships = true;
                                        }
                                    } else if (action === 'create' || action === 'update' || action === 'delete' || action === '*') {
                                        // Global membership event
                                        shouldRefreshMemberships = true;
                                    }
                                } else if (eventType === 'teams' && parts.length >= 3 && parts[2] === 'memberships') {
                                    // Current format: "teams.{teamId}.memberships.{membershipId}.delete"
                                    // or "teams.*.memberships.*.delete"
                                    const teamIdPart = parts[1]; // teamId or '*'
                                    const membershipIdPart = parts[3]; // membershipId or '*'
                                    const action = parts[4]; // 'create', 'update', 'delete', or undefined

                                    // Extract teamId if it's not a wildcard
                                    if (teamIdPart && teamIdPart !== '*' && teamIdPart.length > 10 && /^[a-f0-9]+$/i.test(teamIdPart)) {
                                        if (!affectedTeamId) {
                                            affectedTeamId = teamIdPart;
                                        }
                                    }

                                    // Check if this is a create, update, or delete action
                                    if (action === 'create' || action === 'update' || action === 'delete' || action === '*' || !action) {
                                        shouldRefreshMemberships = true;
                                    }
                                }
                            }

                            // Refresh memberships for current team if viewing one
                            // This ensures the UI updates immediately when a member is updated/deleted
                            if (shouldRefreshMemberships) {
                                // If we know which team was affected, only refresh if it's the current team
                                // Otherwise, refresh for current team if viewing one
                                const shouldRefreshCurrentTeam = !affectedTeamId ||
                                    (this.currentTeam && this.currentTeam.$id === affectedTeamId);

                                if (shouldRefreshCurrentTeam && this.currentTeam && this.currentTeam.$id && this.listMemberships) {
                                    // Use async/await to ensure memberships are refreshed
                                    this.listMemberships(this.currentTeam.$id).then((result) => {
                                        // Force reactivity by ensuring new array reference
                                        if (this.currentTeamMemberships) {
                                            this.currentTeamMemberships = [...this.currentTeamMemberships];
                                        }
                                    }).catch(err => {
                                        // Failed to refresh memberships after realtime event
                                    });
                                }

                                // Also refresh teams list (membership changes affect team member counts)
                                if (!this._teamsRealtimeSubscribing) {
                                    this._teamsRealtimeSubscribing = true;
                                    if (this.listTeams) {
                                        this.listTeams().finally(() => {
                                            this._teamsRealtimeSubscribing = false;
                                        });
                                    } else {
                                        this._teamsRealtimeSubscribing = false;
                                    }
                                }
                            }
                        }
                    });

                    // Subscribe to account channel (covers: user profile updates, account status changes)
                    const accountSubscription = this._appwrite.realtime.subscribe('account', (response) => {
                        if (response.events && Array.isArray(response.events)) {
                            let shouldRefreshUser = false;

                            for (const event of response.events) {
                                const parts = event.split(/[.\s]+/);
                                const eventType = parts[0]; // 'account'
                                const action = parts[1]; // 'update', 'delete', etc.

                                if (eventType === 'account') {
                                    if (action === 'update' || action === 'delete' || action === '*') {
                                        shouldRefreshUser = true;
                                    }
                                }
                            }

                            // Refresh user data if account was updated
                            if (shouldRefreshUser && this.getAccount) {
                                this.getAccount();
                            }
                        }
                    });

                    // Store unsubscribe functions/objects
                    const subscriptions = [teamsSubscription, membershipsSubscription, accountSubscription];
                    const unsubscribeFunctions = [];

                    for (const sub of subscriptions) {
                        if (typeof sub === 'function') {
                            unsubscribeFunctions.push(sub);
                        } else if (sub && typeof sub.unsubscribe === 'function') {
                            unsubscribeFunctions.push(() => sub.unsubscribe());
                        } else if (sub) {
                            unsubscribeFunctions.push(sub);
                        }
                    }

                    // Store as array if multiple, or single value if only one
                    if (unsubscribeFunctions.length > 1) {
                        this._teamsRealtimeUnsubscribe = unsubscribeFunctions;
                    } else if (unsubscribeFunctions.length === 1) {
                        this._teamsRealtimeUnsubscribe = unsubscribeFunctions[0];
                    } else {
                        this._teamsRealtimeUnsubscribe = true; // Mark as subscribed
                    }
                } catch (error) {
                    // Failed to start realtime subscriptions
                }
            };

            // Stop realtime subscriptions
            store.stopTeamsRealtime = function () {
                if (!this._teamsRealtimeUnsubscribe) {
                    return;
                }

                try {
                    // Handle array of unsubscribe functions (multiple channels)
                    if (Array.isArray(this._teamsRealtimeUnsubscribe)) {
                        for (const unsubscribe of this._teamsRealtimeUnsubscribe) {
                            if (typeof unsubscribe === 'function') {
                                unsubscribe();
                            } else if (unsubscribe && typeof unsubscribe.unsubscribe === 'function') {
                                unsubscribe.unsubscribe();
                            }
                        }
                    } else if (typeof this._teamsRealtimeUnsubscribe === 'function') {
                        // Direct unsubscribe function
                        this._teamsRealtimeUnsubscribe();
                    } else if (this._teamsRealtimeUnsubscribe === true) {
                        // Subscription active but no unsubscribe method available
                    } else {
                        // Subscription object - try to call unsubscribe if it exists
                        if (typeof this._teamsRealtimeUnsubscribe.unsubscribe === 'function') {
                            this._teamsRealtimeUnsubscribe.unsubscribe();
                        }
                    }
                } catch (error) {
                    console.warn('[Manifest Appwrite Auth] Error stopping realtime subscriptions:', error);
                } finally {
                    this._teamsRealtimeUnsubscribe = null;
                }
            };

            // Start polling teams for updates (optional, configured via teamsPollInterval) - DEPRECATED: Use realtime instead
            store.startTeamsPolling = function (intervalMs) {
                // Clear existing interval if any
                if (this._teamsPollInterval) {
                    clearInterval(this._teamsPollInterval);
                }

                // Only poll if authenticated
                if (!this.isAuthenticated) {
                    return;
                }

                this._teamsPollInterval = setInterval(async () => {
                    if (this.isAuthenticated && this.listTeams) {
                        try {
                            await this.listTeams();
                        } catch (error) {
                            console.warn('[Manifest Appwrite Auth] Teams polling error:', error);
                        }
                    } else {
                        // Stop polling if user logs out
                        if (this.stopTeamsPolling) {
                            this.stopTeamsPolling();
                        }
                    }
                }, intervalMs);
            };

            // Stop polling teams
            store.stopTeamsPolling = function () {
                if (this._teamsPollInterval) {
                    clearInterval(this._teamsPollInterval);
                    this._teamsPollInterval = null;
                }
            };

            // Update team preferences
            store.updateTeamPrefs = async function (teamId, prefs) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to update team preferences' };
                }

                this.inProgress = true;
                this.error = null;

                try {
                    const result = await this._appwrite.teams.updatePrefs({
                        teamId: teamId,
                        prefs: prefs
                    });

                    return { success: true, prefs: result };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this.inProgress = false;
                }
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
        initializeTeamsCore();
    } catch (error) {
        // Failed to initialize teams core
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeTeamsCore();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export core teams interface
window.ManifestAppwriteAuthTeamsCore = {
    initialize: initializeTeamsCore
};



/* Auth teams - Default teams (permanent and template) */

// Helper function to resolve personal team name (handles static strings and $x paths)
async function resolvePersonalTeamName(nameConfig) {
    if (!nameConfig || typeof nameConfig !== 'string') {
        return null;
    }

    // If it starts with $x., resolve via Manifest data source
    if (nameConfig.startsWith('$x.')) {
        try {
            // Remove '$x.' prefix and resolve path
            const path = nameConfig.substring(3);

            // Use Alpine's $x magic method if available
            if (typeof Alpine !== 'undefined' && Alpine.magic && Alpine.magic('x')) {
                const $x = Alpine.magic('x');
                // Split path and navigate through $x proxy
                const parts = path.split('.');
                let value = $x;
                for (const part of parts) {
                    if (value && typeof value === 'object' && part in value) {
                        value = value[part];
                        // If value is a Promise, wait for it
                        if (value && typeof value.then === 'function') {
                            value = await value;
                        }
                    } else {
                        // Data source may not be loaded yet - silently return null
                        return null;
                    }
                }
                return value || null;
            } else {
                // Fallback: try data store directly
                const dataStore = Alpine.store('data');
                if (dataStore) {
                    const parts = path.split('.');
                    let value = dataStore;
                    for (const part of parts) {
                        if (value && typeof value === 'object' && part in value) {
                            value = value[part];
                        } else {
                            return null;
                        }
                    }
                    return value || null;
                }
            }
        } catch (error) {
            // Data source may not be loaded yet - silently return null
            return null;
        }
    }

    // Otherwise, treat as static string
    return nameConfig;
}

// Add default teams methods to auth store
function initializeTeamsDefaults() {
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
        if (store && !store.isTeamImmutable) {
            // Check if a team is immutable (cannot be deleted)
            store.isTeamImmutable = async function (teamId) {
                const team = this.teams?.find(t => t.$id === teamId);
                if (!team) return false;

                const appwriteConfig = await config.getAppwriteConfig();
                if (!appwriteConfig?.permanentTeams || !Array.isArray(appwriteConfig.permanentTeams)) {
                    return false;
                }

                // Check if this team matches any permanent team
                for (const nameConfig of appwriteConfig.permanentTeams) {
                    const resolvedName = await resolvePersonalTeamName(nameConfig);
                    if (resolvedName === team.name) {
                        return true; // Immutable
                    }
                }
                return false;
            };

            // Get deleted template teams (teams that can be reapplied)
            store.getDeletedTemplateTeams = async function () {
                const appwriteConfig = await config.getAppwriteConfig();
                if (!appwriteConfig?.templateTeams || !Array.isArray(appwriteConfig.templateTeams)) {
                    return [];
                }

                // Get list of deleted template teams for this user
                let deletedTeams = [];
                try {
                    const userId = this.user?.$id;
                    if (userId) {
                        const key = `manifest:deleted-teams:${userId}`;
                        deletedTeams = JSON.parse(localStorage.getItem(key) || '[]');
                    }
                } catch (e) {
                    return [];
                }

                // Resolve all template team names and filter to only deleted ones
                const deletedTemplateTeams = [];
                for (const nameConfig of appwriteConfig.templateTeams) {
                    const resolvedName = await resolvePersonalTeamName(nameConfig);
                    if (resolvedName && deletedTeams.includes(resolvedName)) {
                        deletedTemplateTeams.push(resolvedName);
                    }
                }

                return deletedTemplateTeams;
            };

            // Track deleted template team (internal helper)
            store.trackDeletedTemplateTeam = async function (teamName) {
                const appwriteConfig = await config.getAppwriteConfig();
                if (appwriteConfig?.templateTeams && Array.isArray(appwriteConfig.templateTeams)) {
                    // Check if this was a template team
                    for (const nameConfig of appwriteConfig.templateTeams) {
                        const resolvedName = await resolvePersonalTeamName(nameConfig);
                        if (resolvedName === teamName) {
                            // Store deletion in localStorage (keyed by user ID)
                            try {
                                const userId = this.user?.$id;
                                if (userId) {
                                    const key = `manifest:deleted-teams:${userId}`;
                                    const deleted = JSON.parse(localStorage.getItem(key) || '[]');
                                    if (!deleted.includes(teamName)) {
                                        deleted.push(teamName);
                                        localStorage.setItem(key, JSON.stringify(deleted));
                                    }
                                }
                            } catch (e) {
                                console.warn('[Manifest Appwrite Auth] Failed to track deleted team:', e);
                            }
                            break;
                        }
                    }
                }
            };

            // Get default teams (teams matching configured default team names - both permanent and template)
            store.getDefaultTeams = async function () {
                if (!this.teams || this.teams.length === 0) {
                    return [];
                }

                const appwriteConfig = await config.getAppwriteConfig();
                const allDefaultTeamNames = [];

                // Resolve permanent teams
                if (appwriteConfig?.permanentTeams && Array.isArray(appwriteConfig.permanentTeams)) {
                    for (const nameConfig of appwriteConfig.permanentTeams) {
                        const resolvedName = await resolvePersonalTeamName(nameConfig);
                        if (resolvedName) {
                            allDefaultTeamNames.push(resolvedName);
                        }
                    }
                }

                // Resolve template teams
                if (appwriteConfig?.templateTeams && Array.isArray(appwriteConfig.templateTeams)) {
                    for (const nameConfig of appwriteConfig.templateTeams) {
                        const resolvedName = await resolvePersonalTeamName(nameConfig);
                        if (resolvedName) {
                            allDefaultTeamNames.push(resolvedName);
                        }
                    }
                }

                // Find teams matching default team names
                const defaultTeams = this.teams.filter(team => allDefaultTeamNames.includes(team.name));
                return defaultTeams;
            };

            // Clean up duplicate permanent/template teams (keeps the oldest one, deletes the rest)
            // This bypasses the immutable check for duplicates only
            store.cleanupDuplicateDefaultTeams = async function () {
                if (!this.teams || this.teams.length === 0) {
                    return { success: true, cleaned: 0 };
                }

                const appwriteConfig = await config.getAppwriteConfig();
                if (!appwriteConfig) {
                    return { success: false, error: 'Appwrite config not available' };
                }

                const allDefaultTeamNames = [];

                // Resolve permanent teams
                if (appwriteConfig?.permanentTeams && Array.isArray(appwriteConfig.permanentTeams)) {
                    for (const nameConfig of appwriteConfig.permanentTeams) {
                        const resolvedName = await resolvePersonalTeamName(nameConfig);
                        if (resolvedName) {
                            allDefaultTeamNames.push(resolvedName);
                        }
                    }
                }

                // Resolve template teams
                if (appwriteConfig?.templateTeams && Array.isArray(appwriteConfig.templateTeams)) {
                    for (const nameConfig of appwriteConfig.templateTeams) {
                        const resolvedName = await resolvePersonalTeamName(nameConfig);
                        if (resolvedName) {
                            allDefaultTeamNames.push(resolvedName);
                        }
                    }
                }

                let cleanedCount = 0;
                const errors = [];

                // For each default team name, find duplicates and delete all but the oldest
                for (const teamName of allDefaultTeamNames) {
                    const matchingTeams = this.teams.filter(team => team.name === teamName);

                    if (matchingTeams.length > 1) {
                        // Sort by creation date (oldest first) and keep the first one
                        const sortedTeams = matchingTeams.sort((a, b) => {
                            const dateA = new Date(a.$createdAt || 0);
                            const dateB = new Date(b.$createdAt || 0);
                            return dateA - dateB;
                        });

                        const teamToKeep = sortedTeams[0];
                        const teamsToDelete = sortedTeams.slice(1);

                        // Delete all duplicates (bypass immutable check for duplicates)
                        for (const team of teamsToDelete) {
                            try {
                                if (!this._appwrite) {
                                    this._appwrite = await config.getAppwriteClient();
                                }
                                if (this._appwrite && this._appwrite.teams) {
                                    // Directly delete via Appwrite API (bypassing our deleteTeam method which checks immutable)
                                    await this._appwrite.teams.delete({ teamId: team.$id });
                                    cleanedCount++;
                                }
                            } catch (error) {
                                const errorMsg = `Error deleting duplicate team ${team.$id}: ${error.message}`;
                                errors.push(errorMsg);
                            }
                        }
                    }
                }

                // Refresh teams list after cleanup
                if (cleanedCount > 0 && this.listTeams) {
                    await this.listTeams();
                }

                return {
                    success: errors.length === 0,
                    cleaned: cleanedCount,
                    errors: errors.length > 0 ? errors : undefined
                };
            };

            // Get personal team (first default team, or first team as fallback)
            // Kept for backwards compatibility
            store.getPersonalTeam = async function () {
                const defaultTeams = await this.getDefaultTeams();
                if (defaultTeams.length > 0) {
                    return defaultTeams[0];
                }
                // Fallback to first team if no default teams
                return this.teams && this.teams.length > 0 ? this.teams[0] : null;
            };

            // Reapply a template team (create it if it was previously deleted)
            store.reapplyTemplateTeam = async function (teamName) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to reapply a template team' };
                }

                const appwriteConfig = await config.getAppwriteConfig();
                if (!appwriteConfig?.templateTeams || !Array.isArray(appwriteConfig.templateTeams)) {
                    return { success: false, error: 'Template teams are not configured' };
                }

                // Verify this is a valid template team name
                let isTemplateTeam = false;
                for (const nameConfig of appwriteConfig.templateTeams) {
                    const resolvedName = await resolvePersonalTeamName(nameConfig);
                    if (resolvedName === teamName) {
                        isTemplateTeam = true;
                        break;
                    }
                }

                if (!isTemplateTeam) {
                    return { success: false, error: 'This is not a valid template team' };
                }

                // Check if team already exists
                if (this.teams && this.teams.some(team => team.name === teamName)) {
                    return { success: false, error: 'This team already exists' };
                }

                this.inProgress = true;
                this.error = null;

                try {
                    // Create the template team (pass empty array to use creatorRole logic)
                    const result = await this.createTeam(null, teamName, []);

                    if (result.success) {
                        // Remove from deleted teams list
                        try {
                            const userId = this.user?.$id;
                            if (userId) {
                                const key = `manifest:deleted-teams:${userId}`;
                                const deleted = JSON.parse(localStorage.getItem(key) || '[]');
                                const updated = deleted.filter(name => name !== teamName);
                                localStorage.setItem(key, JSON.stringify(updated));
                            }
                        } catch (e) {
                            console.warn('[Manifest Appwrite Auth] Failed to update deleted teams list:', e);
                        }

                        // Refresh teams list (this will also update deletedTemplateTeams)
                        if (this.listTeams) {
                            await this.listTeams();
                        }

                        // Update deletedTemplateTeams property
                        if (this.getDeletedTemplateTeams) {
                            this.deletedTemplateTeams = await this.getDeletedTemplateTeams();
                        }

                        return { success: true, team: result.team };
                    } else {
                        return { success: false, error: result.error };
                    }
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this.inProgress = false;
                }
            };
        } else if (!store) {
            setTimeout(waitForStore, 50);
        }
    };

    setTimeout(waitForStore, 100);
}

// Auto-create default teams if enabled - mandatory for all users
async function ensureDefaultTeams(store) {
    const appwriteConfig = await window.ManifestAppwriteAuthConfig.getAppwriteConfig();

    // Check if default teams are enabled
    const hasPermanent = appwriteConfig?.permanentTeams && Array.isArray(appwriteConfig.permanentTeams) && appwriteConfig.permanentTeams.length > 0;
    const hasTemplate = appwriteConfig?.templateTeams && Array.isArray(appwriteConfig.templateTeams) && appwriteConfig.templateTeams.length > 0;

    if ((!hasPermanent && !hasTemplate) || !appwriteConfig?.teams) {
        return { success: true, created: false, teams: [] };
    }

    // Ensure teams list is loaded
    if (!store.teams || store.teams.length === 0) {
        if (store.listTeams) {
            await store.listTeams();
        }
    }

    const createdTeams = [];
    const existingTeams = [];

    // Get list of deleted template teams for this user (don't recreate them)
    let deletedTeams = [];
    try {
        const userId = store.user?.$id;
        if (userId) {
            const key = `manifest:deleted-teams:${userId}`;
            deletedTeams = JSON.parse(localStorage.getItem(key) || '[]');
        }
    } catch (e) {
        console.warn('[Manifest Appwrite Auth] Failed to load deleted teams list:', e);
    }

    // Process permanent teams (always create if missing)
    if (hasPermanent) {
        for (const nameConfig of appwriteConfig.permanentTeams) {
            // Resolve team name (static or $x path)
            const teamName = await resolvePersonalTeamName(nameConfig);
            if (!teamName) {
                // Data source may not be loaded yet - skip for now, will retry on next load
                continue;
            }

            // Check if user already has this permanent team (by name matching)
            // Find ALL teams with this name to detect duplicates
            const matchingTeams = store.teams?.filter(team => team.name === teamName) || [];
            if (matchingTeams.length > 0) {
                // If there are duplicates, log a warning and use the first one
                if (matchingTeams.length > 1) {
                    console.warn(`[Manifest Appwrite Auth] Found ${matchingTeams.length} duplicate permanent teams with name "${teamName}". Using the first one.`);
                    console.warn('[Manifest Appwrite Auth] Duplicate team IDs:', matchingTeams.map(t => t.$id));
                }
                existingTeams.push(matchingTeams[0]);
                continue;
            }

            // Permanent team doesn't exist - create it (mandatory for all users)
            try {
                // Pass empty array to use creatorRole logic from config
                const result = await store.createTeam(null, teamName, []);

                if (result.success) {
                    createdTeams.push(result.team);
                }
            } catch (error) {
                // Error creating permanent team
            }
        }
    }

    // Process template teams (only create if not deleted)
    if (hasTemplate) {
        for (const nameConfig of appwriteConfig.templateTeams) {
            // Resolve team name (static or $x path)
            const teamName = await resolvePersonalTeamName(nameConfig);
            if (!teamName) {
                // Data source may not be loaded yet - skip for now, will retry on next load
                continue;
            }

            // Skip if this template team was previously deleted by the user
            if (deletedTeams.includes(teamName)) {
                continue;
            }

            // Check if user already has this template team (by name matching)
            // Find ALL teams with this name to detect duplicates
            const matchingTeams = store.teams?.filter(team => team.name === teamName) || [];
            if (matchingTeams.length > 0) {
                // If there are duplicates, log a warning and use the first one
                if (matchingTeams.length > 1) {
                    console.warn(`[Manifest Appwrite Auth] Found ${matchingTeams.length} duplicate template teams with name "${teamName}". Using the first one.`);
                    console.warn('[Manifest Appwrite Auth] Duplicate team IDs:', matchingTeams.map(t => t.$id));
                }
                existingTeams.push(matchingTeams[0]);
                continue;
            }

            // Template team doesn't exist - create it (mandatory for all users)
            try {
                // Pass empty array to use creatorRole logic from config
                const result = await store.createTeam(null, teamName, []);

                if (result.success) {
                    createdTeams.push(result.team);
                }
            } catch (error) {
                // Error creating template team
            }
        }
    }

    // Set currentTeam to first default team if not already set
    if (!store.currentTeam) {
        const allDefaultTeams = [...existingTeams, ...createdTeams];
        if (allDefaultTeams.length > 0) {
            store.currentTeam = allDefaultTeams[0];
        }
    }

    return {
        success: true,
        created: createdTeams.length > 0,
        teams: [...existingTeams, ...createdTeams],
        createdCount: createdTeams.length
    };
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeTeamsDefaults();
    } catch (error) {
        // Failed to initialize teams defaults
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeTeamsDefaults();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export defaults interface
window.ManifestAppwriteAuthTeamsDefaults = {
    initialize: initializeTeamsDefaults,
    ensureDefaultTeams: ensureDefaultTeams,
    resolvePersonalTeamName: resolvePersonalTeamName
};



/* Auth teams - Default roles (permanent and template) */

// Add default roles methods to auth store
function initializeTeamsRolesDefaults() {
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
        if (store && !store.isRolePermanent) {
            // Initialize cache if needed
            if (!store._rolePermanentCache) store._rolePermanentCache = {};

            // Check if a role is permanent (cannot be deleted)
            store.isRolePermanent = async function (teamId, roleName) {
                const appwriteConfig = await config.getAppwriteConfig();
                // permanentRoles is now an object: { "RoleName": ["permission1", ...] }
                if (!appwriteConfig?.permanentRoles || typeof appwriteConfig.permanentRoles !== 'object') {
                    return false;
                }
                const isPermanent = roleName in appwriteConfig.permanentRoles;
                // Cache the result
                if (!this._rolePermanentCache[teamId]) this._rolePermanentCache[teamId] = {};
                this._rolePermanentCache[teamId][roleName] = isPermanent;
                return isPermanent;
            };

            // Synchronous check using cache (for Alpine reactivity)
            store.isRolePermanentSync = function (teamId, roleName) {
                if (!teamId || !roleName || !this._rolePermanentCache) return false;
                return this._rolePermanentCache[teamId]?.[roleName] === true;
            };

            // Check if a role is a template role (can be deleted)
            store.isRoleTemplate = async function (teamId, roleName) {
                const appwriteConfig = await config.getAppwriteConfig();
                // templateRoles is now an object: { "RoleName": ["permission1", ...] }
                if (!appwriteConfig?.templateRoles || typeof appwriteConfig.templateRoles !== 'object') {
                    return false;
                }
                return roleName in appwriteConfig.templateRoles;
            };

            // Get deleted template roles for a team
            // NOTE: Deleted template roles are stored in team preferences (not localStorage) so they're shared across all team members
            store.getDeletedTemplateRoles = async function (teamId) {
                if (!teamId) {
                    return [];
                }

                const appwriteConfig = await config.getAppwriteConfig();
                if (!appwriteConfig?.templateRoles || typeof appwriteConfig.templateRoles !== 'object') {
                    return [];
                }

                // Get list of deleted template roles from team preferences (shared across all team members)
                let deletedRoles = [];
                try {
                    if (this._appwrite && this._appwrite.teams) {
                        const prefs = await this._appwrite.teams.getPrefs({ teamId });
                        // Deleted template roles are stored in team preferences under 'deletedTemplateRoles'
                        if (prefs && prefs.deletedTemplateRoles && Array.isArray(prefs.deletedTemplateRoles)) {
                            deletedRoles = prefs.deletedTemplateRoles;
                        }
                    }
                } catch (e) {
                    // If team was deleted (404), silently return empty array (expected behavior)
                    if (e.message && e.message.includes('could not be found')) {
                        return [];
                    }
                    // For other errors, fall back to localStorage (for backwards compatibility)
                    try {
                        const userId = this.user?.$id;
                        if (userId) {
                            const key = `manifest:deleted-roles:${userId}:${teamId}`;
                            deletedRoles = JSON.parse(localStorage.getItem(key) || '[]');
                        }
                    } catch (e2) {
                        // Silently ignore localStorage errors
                    }
                }

                // Filter to only include roles that are actually template roles
                const templateRoleNames = Object.keys(appwriteConfig.templateRoles);
                return deletedRoles.filter(roleName => templateRoleNames.includes(roleName));
            };

            // Reapply a deleted template role
            store.reapplyTemplateRole = async function (teamId, roleName) {
                if (!teamId || !roleName) {
                    return { success: false, error: 'Team ID and role name are required' };
                }

                const appwriteConfig = await config.getAppwriteConfig();
                if (!appwriteConfig?.templateRoles || typeof appwriteConfig.templateRoles !== 'object') {
                    return { success: false, error: 'Template roles are not configured' };
                }

                const templateRole = appwriteConfig.templateRoles[roleName];
                if (!templateRole || !Array.isArray(templateRole)) {
                    return { success: false, error: `Template role "${roleName}" does not exist` };
                }

                try {
                    // Get current team preferences
                    const currentPrefs = await this._appwrite.teams.getPrefs({ teamId });
                    const currentRoles = currentPrefs?.roles ? { ...currentPrefs.roles } : {};

                    // Check if role already exists
                    if (currentRoles[roleName]) {
                        return { success: false, error: 'This role already exists' };
                    }

                    // Add the template role
                    const updatedRoles = {
                        ...currentRoles,
                        [roleName]: templateRole
                    };

                    // Remove from deleted list in team preferences (shared across all team members)
                    let deletedRoles = [];
                    if (currentPrefs && currentPrefs.deletedTemplateRoles && Array.isArray(currentPrefs.deletedTemplateRoles)) {
                        deletedRoles = currentPrefs.deletedTemplateRoles.filter(r => r !== roleName);
                    }

                    const updatedPrefs = {
                        ...currentPrefs,
                        roles: updatedRoles,
                        deletedTemplateRoles: deletedRoles // Update deleted list in team preferences
                    };
                    await this._appwrite.teams.updatePrefs({
                        teamId: teamId,
                        prefs: updatedPrefs
                    });

                    // Also remove from localStorage for backwards compatibility (if it exists)
                    try {
                        const userId = this.user?.$id;
                        if (userId) {
                            const key = `manifest:deleted-roles:${userId}:${teamId}`;
                            const deleted = JSON.parse(localStorage.getItem(key) || '[]');
                            const updated = deleted.filter(name => name !== roleName);
                            localStorage.setItem(key, JSON.stringify(updated));
                        }
                    } catch (e) {
                        // Ignore localStorage errors (team preferences is the source of truth)
                    }

                    // Refresh cache for this team
                    if (this.getAllRoles) {
                        const allRoles = await this.getAllRoles(teamId);
                        const rolesCopy = allRoles ? { ...allRoles } : {};
                        if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                        this._allRolesCacheByTeam[teamId] = { ...rolesCopy };

                        // Pre-cache permanent role status
                        if (!this._rolePermanentCache) this._rolePermanentCache = {};
                        if (!this._rolePermanentCache[teamId]) this._rolePermanentCache[teamId] = {};
                        for (const rName of Object.keys(rolesCopy)) {
                            if (this.isRolePermanent) {
                                await this.isRolePermanent(teamId, rName);
                            }
                        }
                    }

                    // Refresh permission cache
                    if (this.refreshPermissionCache) {
                        await this.refreshPermissionCache();
                    }

                    return { success: true };
                } catch (error) {
                    return { success: false, error: error.message };
                }
            };

            // Ensure default roles are applied to a team
            store.ensureDefaultRoles = async function (teamId) {
                const appwriteConfig = await config.getAppwriteConfig();
                if (!appwriteConfig || !teamId) {
                    return { success: false, error: 'Invalid config or team ID' };
                }

                // permanentRoles and templateRoles are now objects: { "RoleName": ["permission1", ...] }
                const permanentRoles = appwriteConfig.permanentRoles || {};
                const templateRoles = appwriteConfig.templateRoles || {};

                // Get list of deleted template roles for this team (don't recreate them)
                // Use getDeletedTemplateRoles which reads from team preferences (shared across all team members)
                let deletedRoles = [];
                if (this.getDeletedTemplateRoles) {
                    try {
                        deletedRoles = await this.getDeletedTemplateRoles(teamId);
                    } catch (e) {
                        // Failed to load deleted roles list
                    }
                }

                // Merge permanent and template roles into one object
                const allDefaultRoles = { ...permanentRoles };
                // Only include template roles that haven't been deleted
                for (const [roleName, permissions] of Object.entries(templateRoles)) {
                    if (!deletedRoles.includes(roleName)) {
                        allDefaultRoles[roleName] = permissions;
                    }
                }

                if (Object.keys(allDefaultRoles).length === 0) {
                    return { success: true, applied: false };
                }

                try {
                    // Get current team preferences
                    const currentPrefs = await this._appwrite.teams.getPrefs({ teamId });
                    const currentRoles = currentPrefs?.roles ? { ...currentPrefs.roles } : {};

                    let rolesUpdated = false;
                    const updatedRoles = { ...currentRoles };

                    // Apply default roles that don't already exist
                    for (const [roleName, permissions] of Object.entries(allDefaultRoles)) {
                        if (!updatedRoles[roleName] && Array.isArray(permissions)) {
                            updatedRoles[roleName] = permissions;
                            rolesUpdated = true;
                        }
                    }

                    // Only update if roles were added
                    if (rolesUpdated) {
                        const updatedPrefs = {
                            ...currentPrefs,
                            roles: updatedRoles
                        };
                        await this._appwrite.teams.updatePrefs({
                            teamId: teamId,
                            prefs: updatedPrefs
                        });

                        // Refresh cache for this team
                        if (this.getAllRoles) {
                            const allRoles = await this.getAllRoles(teamId);
                            const rolesCopy = allRoles ? { ...allRoles } : {};
                            if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                            this._allRolesCacheByTeam[teamId] = rolesCopy;

                            // Pre-cache permanent role status for all roles
                            if (!this._rolePermanentCache) this._rolePermanentCache = {};
                            if (!this._rolePermanentCache[teamId]) this._rolePermanentCache[teamId] = {};
                            for (const roleName of Object.keys(rolesCopy)) {
                                if (this.isRolePermanent) {
                                    await this.isRolePermanent(teamId, roleName);
                                }
                            }
                        }

                        return { success: true, applied: true };
                    }

                    return { success: true, applied: false };
                } catch (error) {
                    return { success: false, error: error.message };
                }
            };
        } else if (!store) {
            setTimeout(waitForStore, 50);
        }
    };

    setTimeout(waitForStore, 100);
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    initializeTeamsRolesDefaults();
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeTeamsRolesDefaults();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export for use in other modules
window.ManifestAppwriteAuthTeamsRolesDefaults = {
    initialize: initializeTeamsRolesDefaults
};



/* Auth teams - Role abstraction layer */

// Valid owner permission values (must map precisely to Appwrite owner capabilities)
const OWNER_PERMISSIONS = [
    'inviteMembers',   // Can invite team members
    'updateMembers',   // Can update member roles
    'removeMembers',   // Can remove team members
    'renameTeam',      // Can rename the team
    'deleteTeam',      // Can delete the team
    'manageRoles'      // Can create, update, rename, and delete custom roles
];

// Get all owner permissions
function getOwnerPermissions() {
    return [...OWNER_PERMISSIONS];
}

// Validate role configuration from manifest
function validateRoleConfig(memberRoles, creatorRole) {
    const errors = [];
    const warnings = [];

    // If teams not enabled, roles are ignored (graceful degradation)
    // This validation assumes teams are enabled

    // Validate memberRoles structure
    if (memberRoles && typeof memberRoles !== 'object') {
        errors.push('memberRoles must be an object');
        return { valid: false, errors, warnings };
    }

    if (!memberRoles || Object.keys(memberRoles).length === 0) {
        // No roles defined - this is valid (will use Appwrite default: everyone is owner)
        return { valid: true, errors: [], warnings: [] };
    }

    // Validate each role
    for (const [roleName, permissions] of Object.entries(memberRoles)) {
        if (!Array.isArray(permissions)) {
            errors.push(`Role "${roleName}" must have a permissions array`);
            continue;
        }

        // Validate owner permissions (warn about invalid ones, but allow custom permissions)
        for (const permission of permissions) {
            if (typeof permission !== 'string') {
                errors.push(`Role "${roleName}" has invalid permission type. Permissions must be strings.`);
            } else if (!OWNER_PERMISSIONS.includes(permission)) {
                // Custom permission - this is allowed, just log for info
                // No error, as custom permissions are valid
            }
        }
    }

    // Validate creatorRole reference
    if (creatorRole) {
        if (typeof creatorRole !== 'string') {
            errors.push('creatorRole must be a string reference to a memberRoles key');
        } else if (!memberRoles || !memberRoles[creatorRole]) {
            errors.push(`creatorRole "${creatorRole}" does not exist in memberRoles`);
        }
    }

    if (errors.length > 0) {
        return { valid: false, errors, warnings };
    }

    return { valid: true, errors: [], warnings };
}

// Check if a role requires owner permissions (has any owner permission)
function roleRequiresOwner(roleName, memberRoles) {
    if (!memberRoles || !memberRoles[roleName]) {
        return false;
    }

    const permissions = memberRoles[roleName] || [];

    // If role has any owner permission, it requires owner role
    return permissions.some(perm => OWNER_PERMISSIONS.includes(perm));
}

// Check if a role has ALL owner permissions (effectively replaces "owner" in UI)
function roleHasAllOwnerPermissions(roleName, memberRoles) {
    if (!memberRoles || !memberRoles[roleName]) {
        return false;
    }

    const permissions = memberRoles[roleName] || [];

    // Check if role has all owner permissions
    return OWNER_PERMISSIONS.every(perm => permissions.includes(perm));
}

// Get user-generated roles from team preferences
async function getUserGeneratedRoles(teamId, appwrite) {
    if (!appwrite || !appwrite.teams) {
        return null;
    }

    try {
        const prefs = await appwrite.teams.getPrefs({ teamId });
        return prefs?.roles || null;
    } catch (error) {
        // Team preferences might not have roles yet, or team might be deleted (404)
        // Silently return null for deleted teams (expected behavior)
        if (error.message && error.message.includes('could not be found')) {
            return null;
        }
        // For other errors, also return null (team preferences might not exist yet)
        return null;
    }
}

// Merge manifest roles with user-generated roles (user-generated overrides manifest)
function mergeRoles(manifestRoles, userGeneratedRoles) {
    if (!manifestRoles && !userGeneratedRoles) {
        return null;
    }

    // Start with manifest roles
    const merged = manifestRoles ? { ...manifestRoles } : {};

    // Override with user-generated roles (if enabled)
    if (userGeneratedRoles && typeof userGeneratedRoles === 'object') {
        Object.assign(merged, userGeneratedRoles);
    }

    return merged;
}

// Normalize custom roles for Appwrite (add "owner" if any role requires it)
function normalizeRolesForAppwrite(customRoles, memberRoles, userGeneratedRoles = null) {
    if (!Array.isArray(customRoles)) {
        return customRoles;
    }

    // Merge manifest and user-generated roles
    const allRoles = mergeRoles(memberRoles, userGeneratedRoles);

    // If no roles config, return as-is (will use Appwrite's default behavior)
    if (!allRoles || Object.keys(allRoles).length === 0) {
        return customRoles;
    }

    // Check if any custom role requires owner
    const requiresOwner = customRoles.some(role => roleRequiresOwner(role, allRoles));

    // If owner is already in the list, don't duplicate
    if (requiresOwner && !customRoles.includes('owner')) {
        return [...customRoles, 'owner'];
    }

    return customRoles;
}

// Normalize Appwrite roles for display (filter "owner" if a custom role replaces it)
function normalizeRolesForDisplay(appwriteRoles, memberRoles, userGeneratedRoles = null) {
    if (!Array.isArray(appwriteRoles)) {
        return appwriteRoles;
    }

    // Merge manifest and user-generated roles
    const allRoles = mergeRoles(memberRoles, userGeneratedRoles);

    // If custom roles are defined, always filter out "owner" (it's a background Appwrite role)
    // "owner" is automatically added by Appwrite for permissions, but shouldn't be displayed
    if (allRoles && Object.keys(allRoles).length > 0) {
        return appwriteRoles.filter(role => role !== 'owner');
    }

    // If no custom roles config, show "owner" as-is (legacy behavior)
    return appwriteRoles;
}

// Get the primary role for display (first custom role, or "owner" if no custom roles)
function getPrimaryDisplayRole(appwriteRoles, memberRoles, userGeneratedRoles = null) {
    const displayRoles = normalizeRolesForDisplay(appwriteRoles, memberRoles, userGeneratedRoles);

    if (displayRoles.length === 0) {
        return null;
    }

    // Return first role (typically the most important)
    return displayRoles[0];
}

// Check if a user has a specific permission based on their roles
function hasPermission(userRoles, permission, memberRoles, userGeneratedRoles = null) {
    if (!Array.isArray(userRoles)) {
        return false;
    }

    // Merge manifest and user-generated roles
    const allRoles = mergeRoles(memberRoles, userGeneratedRoles);

    // If no custom roles config, owner has all permissions (including manageRoles)
    if (!allRoles || Object.keys(allRoles).length === 0) {
        // Owner always has all permissions when no custom roles are defined
        return userRoles.includes('owner');
    }

    // IMPORTANT: When custom roles are defined, we ONLY check custom roles, NOT the owner role.
    // This is because Appwrite automatically grants "owner" role to users with custom roles
    // that have native permissions, but we want to restrict them to ONLY the permissions
    // explicitly defined in their custom role(s).

    // Get user's custom roles (excluding "owner")
    const customRoles = userRoles.filter(role => role !== 'owner');

    // If user has no custom roles (only "owner" or empty), grant all permissions
    // This handles edge cases where:
    // - User's role was deleted
    // - User was never assigned a custom role
    if (customRoles.length === 0) {
        // User has no custom roles, so they should have all owner permissions
        return true;
    }

    // Check if any of the user's custom roles has this permission
    for (const roleName of customRoles) {
        const rolePermissions = allRoles[roleName];
        if (rolePermissions && Array.isArray(rolePermissions) && rolePermissions.includes(permission)) {
            return true;
        }
    }

    // User has custom roles but none of them grant this permission
    return false;
}

// Get creator role permissions (with fallback logic)
function getCreatorRolePermissions(memberRoles, creatorRole) {
    // If creatorRole specified and exists in memberRoles
    if (creatorRole && memberRoles && memberRoles[creatorRole]) {
        return memberRoles[creatorRole];
    }

    // If no creatorRole specified, find role with all owner permissions
    if (memberRoles) {
        for (const [roleName, permissions] of Object.entries(memberRoles)) {
            if (roleHasAllOwnerPermissions(roleName, memberRoles)) {
                return permissions;
            }
        }
        // If no role has all permissions, use first role
        const firstRole = Object.keys(memberRoles)[0];
        if (firstRole) {
            return memberRoles[firstRole];
        }
    }

    // Fallback: return empty array (will use Appwrite default: owner)
    return [];
}

// Initialize role abstraction
function initializeTeamsRoles() {
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
        if (store && !store._rolesInitialized) {
            // Add role abstraction methods to store
            store.getOwnerPermissions = function () {
                return getOwnerPermissions();
            };

            store.validateRoleConfig = async function () {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;
                const creatorRole = appwriteConfig?.creatorRole || null;
                return validateRoleConfig(memberRoles, creatorRole);
            };

            store.roleRequiresOwner = async function (roleName) {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;
                return roleRequiresOwner(roleName, memberRoles);
            };

            store.roleHasAllOwnerPermissions = async function (roleName) {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;
                return roleHasAllOwnerPermissions(roleName, memberRoles);
            };

            store.getUserGeneratedRoles = async function (teamId) {
                if (!this._appwrite) {
                    return null;
                }
                return await getUserGeneratedRoles(teamId, this._appwrite);
            };

            store.getAllRoles = async function (teamId) {
                // Check if team still exists before trying to access preferences
                if (teamId && this.teams && !this.teams.find(t => t.$id === teamId)) {
                    // Team was deleted, return only memberRoles (no user-generated roles)
                    const appwriteConfig = await config.getAppwriteConfig();
                    return appwriteConfig?.memberRoles || null;
                }

                const appwriteConfig = await config.getAppwriteConfig();
                let memberRoles = appwriteConfig?.memberRoles || null;

                // Filter out deleted template roles from memberRoles
                if (memberRoles && teamId && window.ManifestAppwriteAuthTeamsRolesDefaults && this.getDeletedTemplateRoles) {
                    const deletedRoles = await this.getDeletedTemplateRoles(teamId);
                    if (deletedRoles && deletedRoles.length > 0) {
                        // Create a filtered copy of memberRoles without deleted template roles
                        const filteredMemberRoles = { ...memberRoles };
                        for (const deletedRoleName of deletedRoles) {
                            delete filteredMemberRoles[deletedRoleName];
                        }
                        memberRoles = filteredMemberRoles;
                    }
                }

                // Always check for user-generated roles (stored in team preferences)
                let userRoles = null;
                if (teamId && this._appwrite) {
                    userRoles = await this.getUserGeneratedRoles(teamId);
                }

                return mergeRoles(memberRoles, userRoles);
            };

            store.normalizeRolesForAppwrite = async function (customRoles, teamId = null) {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;

                // Always check for user-generated roles (stored in team preferences)
                let userRoles = null;
                if (teamId && this._appwrite) {
                    userRoles = await this.getUserGeneratedRoles(teamId);
                }

                return normalizeRolesForAppwrite(customRoles, memberRoles, userRoles);
            };

            store.normalizeRolesForDisplay = async function (appwriteRoles, teamId = null) {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;

                // Always check for user-generated roles (stored in team preferences)
                let userRoles = null;
                if (teamId && this._appwrite) {
                    userRoles = await this.getUserGeneratedRoles(teamId);
                }

                return normalizeRolesForDisplay(appwriteRoles, memberRoles, userRoles);
            };

            store.getPrimaryDisplayRole = async function (appwriteRoles, teamId = null) {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;

                // Always check for user-generated roles (stored in team preferences)
                let userRoles = null;
                if (teamId && this._appwrite) {
                    userRoles = await this.getUserGeneratedRoles(teamId);
                }

                return getPrimaryDisplayRole(appwriteRoles, memberRoles, userRoles);
            };

            store.hasPermission = async function (userRoles, permission, teamId = null) {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;

                // Always check for user-generated roles (stored in team preferences)
                let userGenRoles = null;
                if (teamId && this._appwrite) {
                    userGenRoles = await this.getUserGeneratedRoles(teamId);
                }

                return hasPermission(userRoles, permission, memberRoles, userGenRoles);
            };

            store.getCreatorRolePermissions = async function () {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;
                const creatorRole = appwriteConfig?.creatorRole || null;
                return getCreatorRolePermissions(memberRoles, creatorRole);
            };

            // Check if custom roles are configured
            store.hasCustomRoles = async function () {
                const appwriteConfig = await config.getAppwriteConfig();
                const memberRoles = appwriteConfig?.memberRoles || null;
                return memberRoles && Object.keys(memberRoles).length > 0;
            };

            // Check if user can manage roles (has manageRoles permission)
            store.canManageRoles = async function () {
                if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                    return false;
                }
                return await this.hasTeamPermission('manageRoles');
            };

            // Alias for backwards compatibility
            store.canCreateRoles = store.canManageRoles;

            store._rolesInitialized = true;
        } else if (!store) {
            setTimeout(waitForStore, 50);
        }
    };

    setTimeout(waitForStore, 100);
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeTeamsRoles();
    } catch (error) {
        // Failed to initialize teams roles
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeTeamsRoles();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export roles interface
window.ManifestAppwriteAuthTeamsRoles = {
    initialize: initializeTeamsRoles,
    getOwnerPermissions,
    validateRoleConfig,
    roleRequiresOwner,
    roleHasAllOwnerPermissions,
    getUserGeneratedRoles,
    mergeRoles,
    normalizeRolesForAppwrite,
    normalizeRolesForDisplay,
    getPrimaryDisplayRole,
    hasPermission,
    getCreatorRolePermissions
};


/* Auth teams - User-generated roles management */

// Add user-generated role methods to auth store
function initializeTeamsUserRoles() {
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
        if (store && !store.createUserRole) {
            // Create user-generated role
            store.createUserRole = async function (teamId, roleName, permissions) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to create roles' };
                }

                // Check if user has manageRoles permission
                if (!this.hasTeamPermission || !await this.hasTeamPermission('manageRoles')) {
                    return { success: false, error: 'You do not have permission to create roles' };
                }

                if (!roleName || !roleName.trim()) {
                    return { success: false, error: 'Role name is required' };
                }

                if (!Array.isArray(permissions)) {
                    return { success: false, error: 'Permissions must be an array' };
                }

                // Set operation-specific loading state
                this._creatingRole = true;
                this.error = null;

                try {
                    // Get current team preferences (preserve all existing prefs)
                    const currentPrefs = await this._appwrite.teams.getPrefs({ teamId });
                    // Ensure we have a fresh copy of roles, not a shared reference
                    const currentRoles = currentPrefs?.roles ? { ...currentPrefs.roles } : {};

                    // Check if role already exists
                    if (currentRoles[roleName]) {
                        return { success: false, error: `Role "${roleName}" already exists` };
                    }

                    // Add new role
                    const updatedRoles = {
                        ...currentRoles,
                        [roleName]: permissions
                    };

                    // Update team preferences (preserve all other preferences)
                    const updatedPrefs = {
                        ...currentPrefs,
                        roles: updatedRoles
                    };
                    await this._appwrite.teams.updatePrefs({
                        teamId: teamId,
                        prefs: updatedPrefs
                    });

                    // Refresh permission cache to update UI
                    if (this.refreshPermissionCache) {
                        await this.refreshPermissionCache();
                    }

                    // Also update per-team cache for this specific team
                    if (this.getAllRoles) {
                        const allRoles = await this.getAllRoles(teamId);
                        const rolesCopy = allRoles ? { ...allRoles } : {};
                        if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                        this._allRolesCacheByTeam[teamId] = rolesCopy;
                        // Also update _allRolesCache if this is the current team
                        if (this.currentTeam && this.currentTeam.$id === teamId) {
                            this._allRolesCache = { ...rolesCopy };
                        }
                    }

                    return { success: true, role: { name: roleName, permissions } };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._creatingRole = false;
                }
            };

            // Convenience method: create role using newRoleName and newRolePermissions properties
            store.createRoleFromInputs = async function (teamId) {
                if (!teamId) {
                    return { success: false, error: 'Team ID is required' };
                }

                // Ensure role name is a string
                const roleName = String(this.newRoleName || '').trim();
                // newRolePermissions is now an array (from checkboxes)
                const permissions = Array.isArray(this.newRolePermissions)
                    ? this.newRolePermissions.filter(p => p && typeof p === 'string')
                    : [];

                if (!roleName) {
                    return { success: false, error: 'Role name is required' };
                }

                const result = await this.createUserRole(teamId, roleName, permissions);
                if (result.success) {
                    this.newRoleName = ''; // Clear inputs
                    this.newRolePermissions = []; // Clear permissions array
                }
                return result;
            };

            // Update user-generated role (permissions only)
            store.updateUserRole = async function (teamId, roleName, permissions) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to update roles' };
                }

                // Check if user has manageRoles permission
                if (!this.hasTeamPermission || !await this.hasTeamPermission('manageRoles')) {
                    return { success: false, error: 'You do not have permission to update roles' };
                }

                if (!roleName || !roleName.trim()) {
                    return { success: false, error: 'Role name is required' };
                }

                if (!Array.isArray(permissions)) {
                    return { success: false, error: 'Permissions must be an array' };
                }

                // Set operation-specific loading state
                this._updatingRole = { teamId, roleName };
                this.error = null;

                try {
                    // Get current team preferences (preserve all existing prefs)
                    const currentPrefs = await this._appwrite.teams.getPrefs({ teamId });
                    // Ensure we have a fresh copy of roles, not a shared reference
                    const currentRoles = currentPrefs?.roles ? { ...currentPrefs.roles } : {};

                    // Check if role exists
                    if (!currentRoles[roleName]) {
                        // Revert optimistic update
                        if (this.getAllRoles) {
                            const allRoles = await this.getAllRoles(teamId);
                            const rolesCopy = allRoles ? { ...allRoles } : {};
                            if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                            this._allRolesCacheByTeam[teamId] = rolesCopy;
                            if (this.currentTeam && this.currentTeam.$id === teamId) {
                                this._allRolesCache = { ...rolesCopy };
                            }
                        }
                        return { success: false, error: `Role "${roleName}" does not exist` };
                    }

                    // Update role permissions
                    const updatedRoles = {
                        ...currentRoles,
                        [roleName]: permissions
                    };

                    // Update team preferences (preserve all other preferences)
                    const updatedPrefs = {
                        ...currentPrefs,
                        roles: updatedRoles
                    };
                    await this._appwrite.teams.updatePrefs({
                        teamId: teamId,
                        prefs: updatedPrefs
                    });

                    // Refresh permission cache to update UI
                    if (this.refreshPermissionCache) {
                        await this.refreshPermissionCache();
                    }

                    // Also update per-team cache for this specific team (create new object reference for reactivity)
                    if (this.getAllRoles) {
                        const allRoles = await this.getAllRoles(teamId);
                        const rolesCopy = allRoles ? { ...allRoles } : {};
                        if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                        this._allRolesCacheByTeam[teamId] = { ...rolesCopy };

                        // Also update _allRolesCache if this is the current team
                        if (this.currentTeam && this.currentTeam.$id === teamId) {
                            this._allRolesCache = { ...rolesCopy };
                        }
                    }

                    return { success: true, role: { name: roleName, permissions } };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._updatingRole = null;
                }
            };

            // Rename a user-generated role
            store.renameUserRole = async function (teamId, oldRoleName, newRoleName) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to rename roles' };
                }

                // Check if user has manageRoles permission
                if (!this.hasTeamPermission || !await this.hasTeamPermission('manageRoles')) {
                    return { success: false, error: 'You do not have permission to rename roles' };
                }

                oldRoleName = String(oldRoleName || '').trim();
                newRoleName = String(newRoleName || '').trim();

                if (!oldRoleName || !newRoleName) {
                    return { success: false, error: 'Both old and new role names are required' };
                }

                if (oldRoleName === newRoleName) {
                    return { success: false, error: 'New role name must be different from the current name' };
                }

                // Check if role is permanent (cannot be renamed)
                if (this.isRolePermanent && await this.isRolePermanent(teamId, oldRoleName)) {
                    return { success: false, error: 'Permanent roles cannot be renamed' };
                }

                // Set operation-specific loading state
                this._updatingRole = { teamId, roleName: oldRoleName };
                this.error = null;

                try {
                    // Get current team preferences (preserve all existing prefs)
                    const currentPrefs = await this._appwrite.teams.getPrefs({ teamId });
                    // Ensure we have a fresh copy of roles, not a shared reference
                    const currentRoles = currentPrefs?.roles ? { ...currentPrefs.roles } : {};

                    // Check if old role exists
                    if (!currentRoles[oldRoleName]) {
                        return { success: false, error: `Role "${oldRoleName}" does not exist` };
                    }

                    // Check if new role name already exists
                    if (currentRoles[newRoleName]) {
                        return { success: false, error: `Role "${newRoleName}" already exists` };
                    }

                    // Get permissions from old role
                    const permissions = Array.isArray(currentRoles[oldRoleName])
                        ? [...currentRoles[oldRoleName]]
                        : [];

                    // Create updated roles object: remove old, add new
                    const updatedRoles = { ...currentRoles };
                    delete updatedRoles[oldRoleName];
                    updatedRoles[newRoleName] = permissions;

                    // Update team preferences (preserve all other preferences)
                    const updatedPrefs = {
                        ...currentPrefs,
                        roles: updatedRoles
                    };
                    await this._appwrite.teams.updatePrefs({
                        teamId: teamId,
                        prefs: updatedPrefs
                    });

                    // Update all memberships that have the old role name to use the new role name
                    // This prevents data drift where role names in memberships don't match role definitions
                    try {
                        if (this.listMemberships) {
                            const membershipsResult = await this.listMemberships(teamId);
                            if (membershipsResult && membershipsResult.success && membershipsResult.memberships) {
                                const memberships = membershipsResult.memberships;
                                let updatedCount = 0;

                                for (const membership of memberships) {
                                    if (membership.roles && Array.isArray(membership.roles)) {
                                        // Check if membership has the old role name
                                        const hasOldRole = membership.roles.includes(oldRoleName);

                                        if (hasOldRole) {
                                            // Replace old role name with new role name
                                            const updatedRoles = membership.roles.map(role =>
                                                role === oldRoleName ? newRoleName : role
                                            );

                                            // Update membership with new roles
                                            if (this.updateMembership) {
                                                await this.updateMembership(teamId, membership.$id, updatedRoles);
                                                updatedCount++;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    } catch (membershipError) {
                        // Log error but don't fail the rename operation
                    }

                    // Refresh permission cache to update UI
                    if (this.refreshPermissionCache) {
                        await this.refreshPermissionCache();
                    }

                    // Refresh memberships to update UI with new role names
                    if (this.listMemberships && this.currentTeam && this.currentTeam.$id === teamId) {
                        await this.listMemberships(teamId);
                    }

                    // Also update per-team cache for this specific team (create new object reference for reactivity)
                    if (this.getAllRoles) {
                        const allRoles = await this.getAllRoles(teamId);
                        const rolesCopy = allRoles ? { ...allRoles } : {};
                        if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                        this._allRolesCacheByTeam[teamId] = { ...rolesCopy };

                        // Also update _allRolesCache if this is the current team
                        if (this.currentTeam && this.currentTeam.$id === teamId) {
                            this._allRolesCache = { ...rolesCopy };
                        }
                    }

                    return { success: true, role: { name: newRoleName, permissions } };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._updatingRole = null;
                }
            };

            // Delete user-generated role
            store.deleteUserRole = async function (teamId, roleName) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to delete roles' };
                }

                // Check if user has manageRoles permission
                if (!this.hasTeamPermission || !await this.hasTeamPermission('manageRoles')) {
                    return { success: false, error: 'You do not have permission to delete roles' };
                }

                if (!roleName || !roleName.trim()) {
                    return { success: false, error: 'Role name is required' };
                }

                // Check if role is permanent (cannot be deleted)
                if (this.isRolePermanent && await this.isRolePermanent(teamId, roleName)) {
                    return { success: false, error: 'This role cannot be deleted' };
                }

                // Set operation-specific loading state
                this._deletingRole = { teamId, roleName };
                this.error = null;

                try {
                    // Check if role is assigned to any members (UI/platform requirement)
                    if (this.listMemberships) {
                        const membershipsResult = await this.listMemberships(teamId);
                        if (membershipsResult.success) {
                            const memberships = membershipsResult.memberships || [];
                            const roleInUse = memberships.some(m =>
                                m.roles && Array.isArray(m.roles) && m.roles.includes(roleName)
                            );

                            if (roleInUse) {
                                return {
                                    success: false,
                                    error: `Cannot delete role "${roleName}" - it is assigned to one or more team members. Please reassign members to other roles first.`
                                };
                            }
                        }
                    }

                    // Get current team preferences (preserve all existing prefs)
                    const currentPrefs = await this._appwrite.teams.getPrefs({ teamId });
                    // Ensure we have a fresh copy of roles, not a shared reference
                    const currentRoles = currentPrefs?.roles ? { ...currentPrefs.roles } : {};

                    // Check if role exists in team preferences OR if it's a template role (which might only exist in manifest)
                    const roleExistsInPrefs = !!currentRoles[roleName];
                    let isTemplateRole = false;
                    if (!roleExistsInPrefs && window.ManifestAppwriteAuthTeamsRolesDefaults && this.isRoleTemplate) {
                        isTemplateRole = await this.isRoleTemplate(teamId, roleName);
                    }

                    if (!roleExistsInPrefs && !isTemplateRole) {
                        return { success: false, error: `Role "${roleName}" does not exist` };
                    }

                    // Track deleted template role (don't recreate it, but allow reapplying)
                    // Note: isTemplateRole was already checked above if role doesn't exist in prefs
                    if (!isTemplateRole && window.ManifestAppwriteAuthTeamsRolesDefaults && this.isRoleTemplate) {
                        isTemplateRole = await this.isRoleTemplate(teamId, roleName);
                    }
                    if (isTemplateRole) {
                        // Store deletion in team preferences (shared across all team members)
                        // This ensures all team members see the role as deleted, not just the user who deleted it
                        try {
                            // Get current team preferences
                            const currentPrefs = await this._appwrite.teams.getPrefs({ teamId });

                            // Get existing deleted template roles list
                            let deletedRoles = [];
                            if (currentPrefs && currentPrefs.deletedTemplateRoles && Array.isArray(currentPrefs.deletedTemplateRoles)) {
                                deletedRoles = [...currentPrefs.deletedTemplateRoles];
                            }

                            // Add role to deleted list if not already there
                            if (!deletedRoles.includes(roleName)) {
                                deletedRoles.push(roleName);

                                // Update team preferences with deleted roles list
                                const updatedPrefs = {
                                    ...currentPrefs,
                                    deletedTemplateRoles: deletedRoles
                                };

                                await this._appwrite.teams.updatePrefs({
                                    teamId: teamId,
                                    prefs: updatedPrefs
                                });
                            }
                        } catch (e) {
                            // Fallback to localStorage for backwards compatibility
                            try {
                                const userId = this.user?.$id;
                                if (userId) {
                                    const key = `manifest:deleted-roles:${userId}:${teamId}`;
                                    const deleted = JSON.parse(localStorage.getItem(key) || '[]');
                                    if (!deleted.includes(roleName)) {
                                        deleted.push(roleName);
                                        localStorage.setItem(key, JSON.stringify(deleted));
                                    }
                                }
                            } catch (e2) {
                                // Failed to track deleted role in localStorage
                            }
                        }
                    }

                    // Remove role from team preferences (if it exists there)
                    const updatedRoles = { ...currentRoles };
                    if (roleExistsInPrefs) {
                        delete updatedRoles[roleName];
                    }

                    // Update team preferences only if role existed in prefs (preserve all other preferences)
                    if (roleExistsInPrefs) {
                        const updatedPrefs = {
                            ...currentPrefs,
                            roles: updatedRoles
                        };
                        await this._appwrite.teams.updatePrefs({
                            teamId: teamId,
                            prefs: updatedPrefs
                        });
                    }

                    // Update per-team cache for this specific team (create new object reference for reactivity)
                    if (this.getAllRoles) {
                        const allRoles = await this.getAllRoles(teamId);
                        const rolesCopy = allRoles ? { ...allRoles } : {};
                        if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                        // Create new object reference to ensure Alpine reactivity
                        this._allRolesCacheByTeam[teamId] = { ...rolesCopy };

                        // Also update _allRolesCache if this is the current team
                        if (this.currentTeam && this.currentTeam.$id === teamId) {
                            this._allRolesCache = { ...rolesCopy };
                        }

                        // Update permanent role cache for remaining roles
                        if (!this._rolePermanentCache) this._rolePermanentCache = {};
                        if (!this._rolePermanentCache[teamId]) this._rolePermanentCache[teamId] = {};
                        if (this.isRolePermanent) {
                            for (const rName of Object.keys(rolesCopy)) {
                                await this.isRolePermanent(teamId, rName);
                            }
                            // Remove deleted role from cache
                            if (this._rolePermanentCache[teamId][roleName] !== undefined) {
                                delete this._rolePermanentCache[teamId][roleName];
                            }
                        }
                    }

                    // Refresh permission cache to update UI (after cache updates)
                    if (this.refreshPermissionCache) {
                        await this.refreshPermissionCache();
                    }

                    return { success: true };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._deletingRole = null;
                }
            };

            // Check if role is user-generated (stored in team preferences, not in manifest)
            store.isUserGeneratedRole = async function (teamId, roleName) {
                if (!this._appwrite) {
                    return false;
                }

                try {
                    const userRoles = await this.getUserGeneratedRoles(teamId);
                    return userRoles && userRoles[roleName] !== undefined;
                } catch (error) {
                    return false;
                }
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
        initializeTeamsUserRoles();
    } catch (error) {
        // Failed to initialize teams user roles
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeTeamsUserRoles();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export user roles interface
window.ManifestAppwriteAuthTeamsUserRoles = {
    initialize: initializeTeamsUserRoles
};



/* Auth teams - Membership operations */

// Add membership methods to auth store
function initializeTeamsMembers() {
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
        if (store && !store.inviteMember) {
            // Invite member to team
            store.inviteMember = async function (teamId, roles, email = null, userId = null, phone = null, url = null, name = null) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to invite members' };
                }

                if (!email && !userId && !phone) {
                    return { success: false, error: 'You must provide email, userId, or phone' };
                }

                // Use current URL as default redirect if not provided
                if (!url) {
                    const currentUrl = new URL(window.location.href);
                    url = `${currentUrl.origin}${currentUrl.pathname}`;
                }

                // Set operation-specific loading state
                this._invitingMember = true;
                this.error = null;

                try {
                    // Ensure roles is an array
                    let rolesArray = Array.isArray(roles) ? roles : (roles ? [roles] : []);

                    // Normalize roles for Appwrite (add "owner" if custom roles require it)
                    let normalizedRoles = rolesArray;
                    if (this.normalizeRolesForAppwrite && rolesArray.length > 0) {
                        normalizedRoles = await this.normalizeRolesForAppwrite(rolesArray, teamId);
                    }

                    // If no roles provided, use default "owner" role (Appwrite requires at least one role)
                    if (!normalizedRoles || normalizedRoles.length === 0) {
                        normalizedRoles = ['owner'];
                    }

                    // Build the membership creation params (only include defined values)
                    const membershipParams = {
                        teamId: teamId,
                        roles: normalizedRoles
                    };

                    // Only include email, userId, or phone if provided (not empty strings)
                    if (email && email.trim()) {
                        membershipParams.email = email.trim();
                    } else if (userId && userId.trim()) {
                        membershipParams.userId = userId.trim();
                    } else if (phone && phone.trim()) {
                        membershipParams.phone = phone.trim();
                    }

                    // Include optional parameters if provided
                    if (url && url.trim()) {
                        membershipParams.url = url.trim();
                    }
                    if (name && name.trim()) {
                        membershipParams.name = name.trim();
                    }

                    const result = await this._appwrite.teams.createMembership(membershipParams);

                    return { success: true, membership: result };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._invitingMember = false;
                }
            };

            // List team memberships
            store.listMemberships = async function (teamId, queries = [], search = '') {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to list memberships' };
                }

                try {
                    const params = {
                        teamId: teamId,
                        queries: queries
                    };
                    if (search && search.trim().length > 0) {
                        params.search = search;
                    }
                    const result = await this._appwrite.teams.listMemberships(params);
                    let memberships = result.memberships || [];

                    // Enhance memberships with user email if missing
                    // Appwrite membership objects have 'email' for pending invites, confirmed members need user lookup
                    for (const membership of memberships) {
                        // Log all membership properties to debug
                        const allProps = Object.keys(membership);
                        const allPropValues = {};
                        allProps.forEach(prop => {
                            const value = membership[prop];
                            // Only log string/number values, skip objects/arrays
                            if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
                                allPropValues[prop] = value;
                            } else if (value && typeof value === 'object') {
                                allPropValues[prop] = Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
                            }
                        });

                        // For pending invites, email should already be in membership.email
                        // For confirmed members, we need to look it up
                        if (!membership.email && !membership.userEmail) {
                            try {
                                // For the current user, use the auth store's user object
                                if (this.user && this.user.$id === membership.userId && this.user.email) {
                                    membership.email = this.user.email;
                                    membership.userEmail = this.user.email;
                                } else if (membership.userId && membership.confirm === true) {
                                    // For confirmed members, try to fetch user details
                                    // Note: This requires 'users.read' permission
                                    try {
                                        // Check if users service is available
                                        if (!this._appwrite || !this._appwrite.users || typeof this._appwrite.users.get !== 'function') {
                                            console.warn('[Manifest Appwrite Auth] Users service not available on Appwrite client');
                                        } else {
                                            const user = await this._appwrite.users.get({ userId: membership.userId });
                                            if (user && user.email) {
                                                membership.email = user.email;
                                                membership.userEmail = user.email;
                                            } else {
                                                console.warn('[Manifest Appwrite Auth] User fetched but no email found');
                                            }
                                        }
                                    } catch (e) {
                                        console.warn('[Manifest Appwrite Auth] Failed to fetch user:', e.message);
                                        // Silently fail if we can't fetch user (permission issue or user deleted)
                                    }
                                } else if (membership.confirm === false) {
                                    // For pending invites, try to get email from membership object
                                    // Appwrite may store it in different properties
                                    const possibleEmailProps = ['email', 'userEmail', 'inviteeEmail', 'invitedEmail', 'userName'];
                                    let foundEmail = null;
                                    for (const prop of possibleEmailProps) {
                                        const value = membership[prop];
                                        if (value && typeof value === 'string' && value.includes('@')) {
                                            foundEmail = value;
                                            break;
                                        }
                                    }
                                    if (foundEmail) {
                                        membership.email = foundEmail;
                                        membership.userEmail = foundEmail;
                                    } else {
                                        // If still not found and we have userId, try fetching user
                                        if (membership.userId) {
                                            try {
                                                // Check if users service is available
                                                if (!this._appwrite || !this._appwrite.users || typeof this._appwrite.users.get !== 'function') {
                                                    console.warn('[Manifest Appwrite Auth] Users service not available for pending invite lookup');
                                                } else {
                                                    const user = await this._appwrite.users.get({ userId: membership.userId });
                                                    if (user && user.email) {
                                                        membership.email = user.email;
                                                        membership.userEmail = user.email;
                                                    }
                                                }
                                            } catch (e) {
                                                console.warn('[Manifest Appwrite Auth] Failed to fetch user for pending invite:', e.message);
                                            }
                                        } else {
                                            console.warn('[Manifest Appwrite Auth] Pending invite has no email and no userId');
                                        }
                                    }
                                }
                            } catch (e) {
                                // Silently continue if user lookup fails
                            }
                        }
                        // Ensure both properties are set for consistency
                        if (membership.email && !membership.userEmail) {
                            membership.userEmail = membership.email;
                        }
                        if (membership.userEmail && !membership.email) {
                            membership.email = membership.userEmail;
                        }
                    }

                    // Normalize roles for display (filter "owner" if custom role replaces it)
                    if (this.normalizeRolesForDisplay) {
                        for (const membership of memberships) {
                            if (membership.roles && Array.isArray(membership.roles)) {
                                membership.displayRoles = await this.normalizeRolesForDisplay(membership.roles, teamId);
                            }
                        }
                    }

                    // Update currentTeamMemberships if this is the current team
                    // Use spread operator to create new array reference for Alpine reactivity
                    if (this.currentTeam && this.currentTeam.$id === teamId) {
                        this.currentTeamMemberships = [...memberships];
                        // Refresh permission cache after loading memberships
                        if (this.refreshPermissionCache) {
                            await this.refreshPermissionCache();
                        }
                    }

                    return { success: true, memberships: memberships, total: result.total || 0 };
                } catch (error) {
                    // Handle "team not found" errors gracefully (e.g., team was just deleted)
                    if (error.message && error.message.includes('could not be found')) {
                        // Silently return empty memberships for deleted teams
                        if (this.currentTeam && this.currentTeam.$id === teamId) {
                            this.currentTeamMemberships = [];
                        }
                        return { success: true, memberships: [], total: 0 };
                    }
                    this.error = error.message;
                    return { success: false, error: error.message };
                }
            };

            // Get membership
            store.getMembership = async function (teamId, membershipId) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to get membership details' };
                }

                try {
                    const result = await this._appwrite.teams.getMembership({
                        teamId: teamId,
                        membershipId: membershipId
                    });

                    return { success: true, membership: result };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                }
            };

            // Update membership roles
            store.updateMembership = async function (teamId, membershipId, roles) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to update membership' };
                }

                // Check if user has updateMembers permission (required for updating other members' roles)
                // Users can always update their own roles
                const isUpdatingSelf = this.user && this.currentTeamMemberships?.some(
                    m => m.$id === membershipId && m.userId === this.user.$id
                );

                if (!isUpdatingSelf) {
                    // Updating another member - requires permission
                    if (!this.hasTeamPermission || !await this.hasTeamPermission('updateMembers')) {
                        return { success: false, error: 'You do not have permission to update member roles' };
                    }
                }

                // Set operation-specific loading state
                this._updatingMember = membershipId;
                this.error = null;

                // Optimistically update the UI immediately
                if (this.currentTeamMemberships && Array.isArray(this.currentTeamMemberships)) {
                    const membershipIndex = this.currentTeamMemberships.findIndex(m => m.$id === membershipId);
                    if (membershipIndex >= 0) {
                        // Optimistically update membership with new roles
                        this.currentTeamMemberships = [
                            ...this.currentTeamMemberships.slice(0, membershipIndex),
                            { ...this.currentTeamMemberships[membershipIndex], roles: roles },
                            ...this.currentTeamMemberships.slice(membershipIndex + 1)
                        ];
                    }
                }

                try {
                    // Normalize roles for Appwrite (add "owner" if custom roles require it)
                    let normalizedRoles = roles;
                    if (this.normalizeRolesForAppwrite) {
                        normalizedRoles = await this.normalizeRolesForAppwrite(roles, teamId);
                    }

                    const result = await this._appwrite.teams.updateMembership({
                        teamId: teamId,
                        membershipId: membershipId,
                        roles: normalizedRoles
                    });

                    // Check if this was the current user's membership (before refreshing)
                    const isCurrentUser = this.user && result.membership && result.membership.userId === this.user.$id;

                    // Refresh memberships if this was the current team
                    if (this.currentTeam && this.currentTeam.$id === teamId && this.listMemberships) {
                        await this.listMemberships(teamId);
                    }

                    // Refresh permission cache if this was the current user's membership
                    // (This must happen after listMemberships so currentTeamMemberships is updated)
                    if (isCurrentUser && this.currentTeam && this.currentTeam.$id === teamId && this.refreshPermissionCache) {
                        await this.refreshPermissionCache();
                    }

                    return { success: true, membership: result };
                } catch (error) {
                    // Revert optimistic update on error
                    if (this.currentTeam && this.currentTeam.$id === teamId && this.listMemberships) {
                        await this.listMemberships(teamId);
                    }

                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._updatingMember = null;
                }
            };

            // Accept team invitation
            store.acceptInvite = async function (teamId, membershipId, userId, secret) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    console.warn('[Manifest Appwrite Auth] acceptInvite: User not authenticated');
                    return { success: false, error: 'You must be signed in to accept an invitation' };
                }

                this.inProgress = true;
                this.error = null;

                try {
                    const result = await this._appwrite.teams.updateMembershipStatus({
                        teamId: teamId,
                        membershipId: membershipId,
                        userId: userId,
                        secret: secret
                    });

                    // Refresh teams list to ensure the new team appears
                    if (this.listTeams) {
                        await this.listTeams();
                    } else {
                        console.warn('[Manifest Appwrite Auth] acceptInvite: listTeams method not available');
                    }

                    // If this is now the current team, refresh memberships
                    if (this.currentTeam && this.currentTeam.$id === teamId && this.listMemberships) {
                        await this.listMemberships(teamId);
                    }

                    return { success: true, membership: result };
                } catch (error) {
                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this.inProgress = false;
                }
            };

            // Delete membership (leave team or remove member)
            store.deleteMembership = async function (teamId, membershipId) {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                if (!this.isAuthenticated) {
                    return { success: false, error: 'You must be signed in to delete membership' };
                }

                // Check if user has removeMembers permission (unless removing themselves)
                // Note: Users can always leave a team themselves, but need permission to remove others
                const isRemovingSelf = this.user && this.currentTeamMemberships?.some(
                    m => m.$id === membershipId && m.userId === this.user.$id
                );

                if (!isRemovingSelf) {
                    // Removing another member - requires permission
                    if (!this.hasTeamPermission || !await this.hasTeamPermission('removeMembers')) {
                        return { success: false, error: 'You do not have permission to remove members' };
                    }
                }

                // Set operation-specific loading state
                this._deletingMember = membershipId;
                this.error = null;

                // Optimistically remove member from UI immediately
                if (this.currentTeamMemberships && Array.isArray(this.currentTeamMemberships)) {
                    this.currentTeamMemberships = this.currentTeamMemberships.filter(m => m.$id !== membershipId);
                }

                try {
                    await this._appwrite.teams.deleteMembership({
                        teamId: teamId,
                        membershipId: membershipId
                    });

                    // Refresh memberships if this was the current team (to ensure consistency)
                    if (this.currentTeam && this.currentTeam.$id === teamId && this.listMemberships) {
                        await this.listMemberships(teamId);
                    }

                    // Refresh teams list (this will also trigger realtime updates for other users)
                    if (this.listTeams) {
                        await this.listTeams();
                    }

                    return { success: true };
                } catch (error) {
                    // Revert optimistic update on error
                    if (this.currentTeam && this.currentTeam.$id === teamId && this.listMemberships) {
                        await this.listMemberships(teamId);
                    }

                    this.error = error.message;
                    return { success: false, error: error.message };
                } finally {
                    this._deletingMember = null;
                }
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
        initializeTeamsMembers();
    } catch (error) {
        // Failed to initialize teams members
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeTeamsMembers();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export members interface
window.ManifestAppwriteAuthTeamsMembers = {
    initialize: initializeTeamsMembers
};



/* Auth teams - Callback handlers */

// Handle team invitation callbacks via events
function handleTeamCallbacks() {
    // Handle team invitation callback
    window.addEventListener('manifest:auth:callback:team', async (event) => {
        const store = Alpine.store('auth');
        if (!store) {
            return;
        }

        const callbackInfo = event.detail;

        store.inProgress = true;
        store.error = null;

        try {
            // Accept the invitation
            if (store.acceptInvite) {
                const result = await store.acceptInvite(
                    callbackInfo.teamId,
                    callbackInfo.membershipId,
                    callbackInfo.userId,
                    callbackInfo.secret
                );

                if (result.success) {
                    window.dispatchEvent(new CustomEvent('manifest:auth:team:invite-accepted', {
                        detail: { membership: result.membership }
                    }));
                } else {
                    store.error = result.error;
                }
            }
        } catch (error) {
            store.error = error.message;
        } finally {
            store.inProgress = false;
        }
    });
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        handleTeamCallbacks();
    } catch (error) {
        // Failed to initialize team callbacks
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        handleTeamCallbacks();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export callbacks interface
window.ManifestAppwriteAuthTeamsCallbacks = {
    handleCallbacks: handleTeamCallbacks
};



/* Auth teams - Convenience methods for UI */

// Add convenience methods to auth store
function initializeTeamsConvenience() {
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
        if (store) {
            // CRITICAL: Check if convenience methods exist - use isCreatingTeam as the key check
            // This ensures methods are re-added if the store was replaced or methods were lost after idle
            const needsReinitialization = !store.isCreatingTeam || typeof store.isCreatingTeam !== 'function';
            
            // Ensure cache properties are initialized (methods are already in store)
            if (!store._permissionCache) store._permissionCache = {};
            if (store._userRoleCache === undefined) store._userRoleCache = null;
            if (!store._allRolesCache) store._allRolesCache = null;
            if (!store._allRolesCacheByTeam) store._allRolesCacheByTeam = {};
            if (!store._userGeneratedRolesCache) store._userGeneratedRolesCache = {};

            // Update permission cache when team changes
            const updatePermissionCache = async function () {
                if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                    this._permissionCache = {};
                    this._userRoleCache = null;
                    this._allRolesCache = null;
                    this._userGeneratedRolesCache = {};
                    // Don't clear _allRolesCacheByTeam - keep cached roles for all teams
                    return;
                }

                const teamId = this.currentTeam.$id;
                const permissions = ['inviteMembers', 'updateMembers', 'removeMembers', 'renameTeam', 'deleteTeam', 'manageRoles'];

                // Cache permissions
                for (const perm of permissions) {
                    if (this.hasTeamPermission) {
                        const hasPerm = await this.hasTeamPermission(perm);
                        this._permissionCache[perm] = hasPerm;
                    } else {
                        this._permissionCache[perm] = false;
                    }
                }

                // Cache user role
                if (this.getUserRole) {
                    this._userRoleCache = await this.getUserRole();
                } else {
                    this._userRoleCache = null;
                }

                // Cache all roles
                if (this.getAllRoles) {
                    const allRoles = await this.getAllRoles(teamId);
                    // Create new object reference to ensure Alpine reactivity
                    const rolesCopy = allRoles ? { ...allRoles } : {};
                    this._allRolesCache = rolesCopy;
                    // Also cache by team ID for per-team lookups (create new object reference)
                    if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                    this._allRolesCacheByTeam[teamId] = { ...rolesCopy };

                    // Pre-populate permanent role cache for all roles (for isRoleDeletable to work)
                    if (!this._rolePermanentCache) this._rolePermanentCache = {};
                    if (!this._rolePermanentCache[teamId]) this._rolePermanentCache[teamId] = {};
                    if (this.isRolePermanent) {
                        for (const roleName of Object.keys(rolesCopy)) {
                            // Pre-cache permanent status for all roles
                            await this.isRolePermanent(teamId, roleName);
                        }
                    }

                    // Cache which roles are user-generated (always check, no feature flag needed)
                    this._userGeneratedRolesCache = {};
                    if (this._allRolesCache && this.isUserGeneratedRole) {
                        for (const roleName of Object.keys(this._allRolesCache)) {
                            this._userGeneratedRolesCache[roleName] = await this.isUserGeneratedRole(teamId, roleName);
                        }
                    }
                } else {
                    this._allRolesCache = {};
                    if (!this._allRolesCacheByTeam) this._allRolesCacheByTeam = {};
                    this._allRolesCacheByTeam[teamId] = {};
                }
            };

            // Public method to refresh permission cache
            if (!store.refreshPermissionCache) {
                store.refreshPermissionCache = async function () {
                    await updatePermissionCache.call(this);
                };
            }

            // CRITICAL: Check if convenience methods exist - use isCreatingTeam as the key check
            // This ensures methods are re-added if the store was replaced or methods were lost after idle
            if (needsReinitialization) {
                // Convenience method: create team using newTeamName property
                store.createTeamFromName = async function () {
                    // Ensure newTeamName is a string and has content
                    const teamNameValue = String(this.newTeamName || '').trim();
                    if (!teamNameValue) {
                        return { success: false, error: 'Team name is required' };
                    }

                    const result = await this.createTeam(null, teamNameValue, []);
                    if (result.success) {
                        this.newTeamName = ''; // Clear input
                    }
                    return result;
                };

                // Convenience method: update current team name using updateTeamNameInput property
                store.updateCurrentTeamName = async function () {
                    if (!this.currentTeam || !this.currentTeam.$id) {
                        return { success: false, error: 'No team selected' };
                    }

                    // Ensure updateTeamNameInput is a string and has content
                    const teamNameValue = String(this.updateTeamNameInput || '').trim();
                    if (!teamNameValue) {
                        return { success: false, error: 'Team name is required' };
                    }

                    const teamId = this.currentTeam.$id;
                    const result = await this.updateTeamName(teamId, teamNameValue);

                    if (result.success) {
                        this.updateTeamNameInput = ''; // Clear input
                        // Note: updateTeamName() already calls listTeams() and updates currentTeam
                    }
                    return result;
                };

                // Convenience method: invite to current team using inviteEmail and inviteRoles properties
                store.inviteToCurrentTeam = async function () {
                    if (!this.currentTeam) {
                        return { success: false, error: 'No team selected' };
                    }

                    // Ensure email is a string
                    const email = String(this.inviteEmail || '').trim();

                    // Email is required for invitations
                    if (!email) {
                        return { success: false, error: 'Email is required' };
                    }

                    // Use inviteRoles array directly (already an array)
                    const roles = Array.isArray(this.inviteRoles)
                        ? this.inviteRoles.filter(r => r && typeof r === 'string')
                        : [];

                    // If no roles specified, use empty array (will default to "owner" in inviteMember)
                    const result = await this.inviteMember(this.currentTeam.$id, roles, email);
                    if (result.success) {
                        this.inviteEmail = ''; // Clear inputs
                        this.inviteRoles = []; // Clear roles array
                        if (this.listMemberships) {
                            await this.listMemberships(this.currentTeam.$id); // Refresh memberships
                        }
                    }
                    return result;
                };

                // Role management methods for invite (similar to permission management)
                store.toggleInviteRole = function (roleName) {
                    if (!roleName || typeof roleName !== 'string') return;
                    if (!this.inviteRoles) this.inviteRoles = [];
                    const index = this.inviteRoles.indexOf(roleName);
                    if (index === -1) {
                        // Add role (create new array for reactivity)
                        this.inviteRoles = [...this.inviteRoles, roleName];
                    } else {
                        // Remove role (create new array for reactivity)
                        this.inviteRoles = this.inviteRoles.filter(r => r !== roleName);
                    }
                };

                store.isInviteRoleSelected = function (roleName) {
                    if (!this.inviteRoles || !Array.isArray(this.inviteRoles)) return false;
                    return this.inviteRoles.includes(roleName);
                };

                store.addCustomInviteRoles = function (inputValue) {
                    if (!inputValue || typeof inputValue !== 'string') return;
                    if (!this.inviteRoles) this.inviteRoles = [];

                    // Parse comma-separated roles
                    const newRoles = inputValue.split(',')
                        .map(r => r.trim())
                        .filter(r => r && typeof r === 'string');

                    // Add each role if not already present
                    const updated = [...this.inviteRoles];
                    for (const role of newRoles) {
                        if (!updated.includes(role)) {
                            updated.push(role);
                        }
                    }

                    // Create new array reference for reactivity
                    this.inviteRoles = updated;
                };

                store.clearInviteRoles = function () {
                    this.inviteRoles = [];
                };

                // Member editing methods (for existing members)
                store.startEditingMember = async function (teamId, membershipId, currentRoles) {
                    if (!teamId || !membershipId) return;

                    // Initialize editing state
                    this.editingMember = {
                        teamId: teamId,
                        membershipId: membershipId,
                        roles: Array.isArray(currentRoles) ? [...currentRoles] : []
                    };

                    // Initialize role selection with current roles
                    this.inviteRoles = Array.isArray(currentRoles) ? [...currentRoles] : [];
                };

                store.cancelEditingMember = function () {
                    this.editingMember = null;
                    this.inviteRoles = [];
                };

                store.saveEditingMember = async function () {
                    if (!this.editingMember) {
                        return { success: false, error: 'No member being edited' };
                    }

                    const { teamId, membershipId } = this.editingMember;
                    const roles = Array.isArray(this.inviteRoles)
                        ? this.inviteRoles.filter(r => r && typeof r === 'string')
                        : [];

                    // Update membership roles (this will refresh memberships and permission cache if needed)
                    const result = await this.updateMembership(teamId, membershipId, roles);

                    if (result.success) {
                        this.cancelEditingMember();
                        // Note: updateMembership already refreshes memberships and permission cache
                    }

                    return result;
                };

                // Convenience method: delete/remove a member
                store.deleteMember = async function (teamId, membershipId) {
                    if (!teamId || !membershipId) {
                        return { success: false, error: 'Team ID and membership ID are required' };
                    }

                    // Check permission
                    if (!this.hasTeamPermissionSync || !this.hasTeamPermissionSync('removeMembers')) {
                        return { success: false, error: 'You do not have permission to remove members' };
                    }

                    const result = await this.deleteMembership(teamId, membershipId);
                    return result;
                };

                // Convenience method: leave a team (user removes themselves)
                store.leaveTeam = async function (teamId, membershipId) {
                    if (!teamId || !membershipId) {
                        return { success: false, error: 'Team ID and membership ID are required' };
                    }

                    // Verify this is the current user's membership
                    const isCurrentUser = this.user && this.currentTeamMemberships?.some(
                        m => m.$id === membershipId && m.userId === this.user.$id
                    );

                    if (!isCurrentUser) {
                        return { success: false, error: 'You can only leave teams you are a member of' };
                    }

                    // Delete membership (users can always leave themselves)
                    const result = await this.deleteMembership(teamId, membershipId);

                    // If leaving the current team, clear it and select another team if available
                    if (result.success && this.currentTeam && this.currentTeam.$id === teamId) {
                        this.currentTeam = null;
                        this.currentTeamMemberships = [];

                        // Select the first available team if any remain
                        if (this.teams && this.teams.length > 0) {
                            const remainingTeam = this.teams.find(t => t.$id !== teamId);
                            if (remainingTeam) {
                                if (this.viewTeam) {
                                    await this.viewTeam(remainingTeam);
                                } else {
                                    this.currentTeam = remainingTeam;
                                }
                            }
                        }
                    }

                    return result;
                };

                // Convenience method: view team (sets current team and loads memberships)
                store.viewTeam = async function (team) {
                    this.currentTeam = team;
                    // Reset rename input to current team name when viewing a team
                    if (team && team.name) {
                        this.updateTeamNameInput = team.name;
                    } else {
                        this.updateTeamNameInput = '';
                    }
                    if (team && team.$id && this.listMemberships) {
                        const result = await this.listMemberships(team.$id);
                        if (result.success) {
                            this.currentTeamMemberships = result.memberships || [];
                        }
                    }
                    return { success: true };
                };

                // Check if current user is an owner of the current team
                store.isCurrentTeamOwner = function () {
                    if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                        return false;
                    }
                    const userMembership = this.currentTeamMemberships.find(
                        m => m.userId === this.user.$id
                    );
                    return userMembership && userMembership.roles && userMembership.roles.includes('owner');
                };

                // Check if a team can be deleted (checks both immutable status and permissions)
                store.isTeamDeletable = function (team) {
                    if (!team || !team.$id) {
                        return false;
                    }
                    // Check if team is immutable/permanent
                    if (this._teamImmutableCache && this._teamImmutableCache[team.$id]) {
                        return false;
                    }
                    // If checking current team, also check permissions
                    if (this.currentTeam && this.currentTeam.$id === team.$id) {
                        return (this._permissionCache && this._permissionCache.deleteTeam) || false;
                    }
                    // For other teams, assume deletable if not immutable
                    return true;
                };

                // Check if a team can be renamed (checks permissions for current team)
                store.isTeamRenamable = function (team) {
                    if (!team || !team.$id) {
                        return false;
                    }
                    // If checking current team, check permissions
                    if (this.currentTeam && this.currentTeam.$id === team.$id) {
                        return (this._permissionCache && this._permissionCache.renameTeam) || false;
                    }
                    // For other teams, assume renamable (permissions will be checked when team becomes current)
                    return true;
                };

                // Check if a role can be deleted (checks if it's permanent) - synchronous version for Alpine
                store.isRoleDeletable = function (teamId, roleName) {
                    if (!teamId || !roleName) {
                        return false;
                    }
                    // Permanent roles cannot be deleted
                    if (this.isRolePermanentSync && this.isRolePermanentSync(teamId, roleName)) {
                        return false;
                    }
                    // Template roles and user-generated roles can be deleted
                    return true;
                };

                // Check if a role is currently being edited - cleaner state check
                store.isRoleBeingEdited = function (teamId, roleName) {
                    if (!this.editingRole || !teamId || !roleName) {
                        return false;
                    }
                    return this.editingRole.teamId === teamId &&
                        this.editingRole.oldRoleName === roleName;
                };

                // Permission convenience methods (synchronous for Alpine bindings)
                // Note: These override async versions from roles.js for use in Alpine bindings
                store.canManageRolesSync = function () {
                    return this.hasTeamPermissionSync && this.hasTeamPermissionSync('manageRoles');
                };

                // Alias for cleaner HTML (overrides async version for Alpine bindings)
                store.canManageRoles = store.canManageRolesSync;

                store.canInviteMembers = function () {
                    return this.hasTeamPermissionSync && this.hasTeamPermissionSync('inviteMembers');
                };

                store.canUpdateMembers = function () {
                    return this.hasTeamPermissionSync && this.hasTeamPermissionSync('updateMembers');
                };

                store.canRemoveMembers = function () {
                    return this.hasTeamPermissionSync && this.hasTeamPermissionSync('removeMembers');
                };

                store.canRenameTeam = function () {
                    return this.hasTeamPermissionSync && this.hasTeamPermissionSync('renameTeam');
                };

                store.canDeleteTeam = function () {
                    return this.hasTeamPermissionSync && this.hasTeamPermissionSync('deleteTeam');
                };

                // Combined action disabled check (combines inProgress and permission)
                store.isActionDisabled = function (permission) {
                    if (this.inProgress) return true;
                    if (permission && this.hasTeamPermissionSync) {
                        return !this.hasTeamPermissionSync(permission);
                    }
                    return false;
                };

                // Operation-specific loading state checks for better UI reactivity
                store.isUpdatingTeam = function (teamId) {
                    return this._updatingTeam === teamId;
                };

                store.isDeletingTeam = function (teamId) {
                    return this._deletingTeam === teamId;
                };

                store.isCreatingTeam = function () {
                    return this._creatingTeam === true;
                };

                // Check if any team operation is in progress (for general UI disabling)
                store.isAnyTeamOperationInProgress = function () {
                    return this._updatingTeam !== null ||
                        this._deletingTeam !== null ||
                        this._creatingTeam === true;
                };

                // Member operation-specific loading state checks
                store.isUpdatingMember = function (membershipId) {
                    return this._updatingMember === membershipId;
                };

                store.isDeletingMember = function (membershipId) {
                    return this._deletingMember === membershipId;
                };

                store.isInvitingMember = function () {
                    return this._invitingMember === true;
                };

                // Check if any member operation is in progress
                store.isAnyMemberOperationInProgress = function () {
                    return this._updatingMember !== null ||
                        this._deletingMember !== null ||
                        this._invitingMember === true;
                };

                // Role operation-specific loading state checks
                store.isUpdatingRole = function (teamId, roleName) {
                    const result = this._updatingRole !== null &&
                        this._updatingRole.teamId === teamId &&
                        this._updatingRole.roleName === roleName;
                    return result;
                };

                store.isDeletingRole = function (teamId, roleName) {
                    return this._deletingRole !== null &&
                        this._deletingRole.teamId === teamId &&
                        this._deletingRole.roleName === roleName;
                };

                store.isCreatingRole = function () {
                    return this._creatingRole === true;
                };

                // Check if any role operation is in progress
                store.isAnyRoleOperationInProgress = function () {
                    return this._updatingRole !== null ||
                        this._deletingRole !== null ||
                        this._creatingRole === true;
                };

                // Get member display name (extracts complex logic)
                store.getMemberDisplayName = function (membership) {
                    if (!membership) return 'Unknown user';
                    if (membership.userId === this.user?.$id) {
                        return this.user?.name || this.user?.email || 'You';
                    }
                    return membership.userName ||
                        membership.email ||
                        membership.userEmail ||
                        (membership.confirm === false ? 'Pending invitation' : 'Unknown user');
                };

                // Get member email (extracts complex logic)
                store.getMemberEmail = function (membership) {
                    if (!membership) return 'No email';
                    return membership.email ||
                        membership.userEmail ||
                        (membership.userId === this.user?.$id ? (this.user?.email || '') : '') ||
                        'No email';
                };

                // Get all available permissions (standard + custom from existing roles)
                store.getAllAvailablePermissions = async function (teamId) {
                    const permissions = new Set();

                    // Add standard owner permissions (from roles module)
                    // These are defined in manifest.appwrite.auth.teams.roles.js
                    const standardPermissions = [
                        'inviteMembers',
                        'removeMembers',
                        'renameTeam',
                        'deleteTeam',
                        'manageRoles'
                    ];
                    standardPermissions.forEach(p => permissions.add(p));

                    // Add permissions from existing roles in this team
                    if (teamId && this.getAllRoles) {
                        const allRoles = await this.getAllRoles(teamId);
                        if (allRoles && typeof allRoles === 'object') {
                            for (const rolePermissions of Object.values(allRoles)) {
                                if (Array.isArray(rolePermissions)) {
                                    rolePermissions.forEach(p => permissions.add(p));
                                }
                            }
                        }
                    }

                    // Also check permanent and template roles from config
                    const config = window.ManifestAppwriteAuthConfig;
                    if (config) {
                        const appwriteConfig = await config.getAppwriteConfig();
                        const permanentRoles = appwriteConfig?.permanentRoles || {};
                        const templateRoles = appwriteConfig?.templateRoles || {};

                        for (const rolePermissions of Object.values(permanentRoles)) {
                            if (Array.isArray(rolePermissions)) {
                                rolePermissions.forEach(p => permissions.add(p));
                            }
                        }

                        for (const rolePermissions of Object.values(templateRoles)) {
                            if (Array.isArray(rolePermissions)) {
                                rolePermissions.forEach(p => permissions.add(p));
                            }
                        }
                    }

                    return Array.from(permissions).sort();
                };

                // Permission management methods for role creation
                store.togglePermission = function (permission) {
                    if (!permission || typeof permission !== 'string') return;
                    if (!this.newRolePermissions) this.newRolePermissions = [];
                    const index = this.newRolePermissions.indexOf(permission);
                    if (index === -1) {
                        // Add permission (create new array for reactivity)
                        this.newRolePermissions = [...this.newRolePermissions, permission];
                    } else {
                        // Remove permission (create new array for reactivity)
                        this.newRolePermissions = this.newRolePermissions.filter(p => p !== permission);
                    }
                };

                store.isPermissionSelected = function (permission) {
                    if (!this.newRolePermissions || !Array.isArray(this.newRolePermissions)) return false;
                    return this.newRolePermissions.includes(permission);
                };

                store.addCustomPermissions = function (inputValue) {
                    if (!inputValue || typeof inputValue !== 'string') return;
                    if (!this.newRolePermissions) this.newRolePermissions = [];

                    // Parse comma-separated permissions
                    const newPerms = inputValue.split(',')
                        .map(p => p.trim())
                        .filter(p => p && typeof p === 'string');

                    // Add each permission if not already present
                    const updated = [...this.newRolePermissions];
                    for (const perm of newPerms) {
                        if (!updated.includes(perm)) {
                            updated.push(perm);
                        }
                    }

                    // Create new array reference for reactivity
                    this.newRolePermissions = updated;
                };

                store.removePermission = function (permission) {
                    if (!permission || !this.newRolePermissions || !Array.isArray(this.newRolePermissions)) return;
                    this.newRolePermissions = this.newRolePermissions.filter(p => p !== permission);
                };

                store.clearPermissions = function () {
                    this.newRolePermissions = [];
                };

                // Role editing methods (for existing roles)
                store.startEditingRole = async function (teamId, roleName) {
                    if (!teamId || !roleName) {
                        return;
                    }

                    // If already editing this role, don't reset
                    if (this.editingRole &&
                        this.editingRole.teamId === teamId &&
                        this.editingRole.oldRoleName === roleName) {
                        return;
                    }

                    // Get current role permissions
                    const allRoles = this.allTeamRoles({ $id: teamId });
                    const permissions = allRoles && allRoles[roleName] ? [...allRoles[roleName]] : [];

                    // Ensure allAvailablePermissions is populated (for dropdown)
                    if (!this.allAvailablePermissions || this.allAvailablePermissions.length === 0) {
                        if (this.getAllAvailablePermissions) {
                            await this.getAllAvailablePermissions(teamId);
                        }
                    }

                    // Set editing state
                    this.editingRole = {
                        teamId: teamId,
                        oldRoleName: roleName,
                        newRoleName: roleName,
                        permissions: permissions
                    };

                    // Don't modify newRolePermissions when editing existing roles - that's only for new role creation
                    // The UI will use editingRole.permissions or pendingPermissions for existing roles
                };

                store.cancelEditingRole = function () {
                    this.editingRole = null;
                    this.newRolePermissions = [];
                };

                store.saveEditingRole = async function (overridePermissions = null) {
                    if (!this.editingRole) {
                        return { success: false, error: 'No role being edited' };
                    }

                    const { teamId, oldRoleName, newRoleName } = this.editingRole;
                    // Use overridePermissions if provided, otherwise use editingRole.permissions if available (for existing role edits), otherwise fall back to newRolePermissions
                    const permissions = overridePermissions !== null && Array.isArray(overridePermissions)
                        ? overridePermissions.filter(p => p && typeof p === 'string')
                        : (Array.isArray(this.editingRole.permissions) && this.editingRole.permissions.length > 0
                            ? this.editingRole.permissions.filter(p => p && typeof p === 'string')
                            : (Array.isArray(this.newRolePermissions)
                                ? this.newRolePermissions.filter(p => p && typeof p === 'string')
                                : []));

                    let result;

                    // If name changed, rename the role
                    if (oldRoleName !== newRoleName && newRoleName.trim()) {
                        result = await this.renameUserRole(teamId, oldRoleName, newRoleName.trim());
                        if (!result.success) {
                            return result;
                        }
                    }

                    // Update permissions (use new name if renamed, otherwise old name)
                    const roleNameToUpdate = newRoleName.trim() || oldRoleName;
                    result = await this.updateUserRole(teamId, roleNameToUpdate, permissions);

                    if (result.success) {
                        this.cancelEditingRole();
                    }

                    return result;
                };

                // Format team date (createdAt or updatedAt)
                store.formatTeamDate = function (dateString) {
                    if (!dateString) return '';
                    try {
                        const date = new Date(dateString);
                        if (isNaN(date.getTime())) return dateString; // Return original if invalid
                        return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    } catch (e) {
                        return dateString; // Return original if parsing fails
                    }
                };

                // Get formatted createdAt for a team
                store.teamCreatedAt = function (team) {
                    if (!team) return '';
                    return this.formatTeamDate(team.$createdAt || team.createdAt);
                };

                // Get formatted updatedAt for a team
                store.teamUpdatedAt = function (team) {
                    if (!team) return '';
                    return this.formatTeamDate(team.$updatedAt || team.updatedAt);
                };

                // Get current user's roles in the current team
                store.getCurrentTeamRoles = function () {
                    if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                        return [];
                    }
                    const userMembership = this.currentTeamMemberships.find(
                        m => m.userId === this.user.$id
                    );
                    return userMembership?.roles || [];
                };

                // Check if current user has a specific permission in the current team
                // Uses role abstraction layer to check permissions based on custom roles
                store.hasTeamPermission = async function (permission) {
                    if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                        return false;
                    }

                    const userRoles = this.getCurrentTeamRoles();
                    const teamId = this.currentTeam?.$id;
                    if (this.hasPermission) {
                        return await this.hasPermission(userRoles, permission, teamId);
                    }

                    // Fallback: check owner role directly
                    return userRoles.includes('owner');
                };

                // Synchronous version for Alpine.js bindings (uses permission cache)
                store.hasTeamPermissionSync = function (permission) {
                    if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                        return false;
                    }

                    // Use cached permissions if available (updated by updatePermissionCache)
                    if (this._permissionCache && typeof this._permissionCache[permission] === 'boolean') {
                        return this._permissionCache[permission];
                    }

                    // Fallback: check if user has no custom roles (should have all permissions)
                    // This matches the logic in hasPermission: if customRoles.length === 0, return true
                    const userRoles = this.getCurrentTeamRoles();
                    const customRoles = userRoles.filter(role => role !== 'owner');

                    // If user has no custom roles (only "owner" or empty), grant all permissions
                    // This handles users with "No Role" who should have all owner permissions
                    if (customRoles.length === 0) {
                        return true;
                    }

                    // If user has custom roles but cache is missing, return false (shouldn't happen if cache is working)
                    return false;
                };

                // Check if current user has a specific role
                store.hasRole = function (roleName) {
                    if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                        return false;
                    }
                    const userRoles = this.getCurrentTeamRoles();
                    return userRoles.includes(roleName);
                };

                // Get current user's primary role in current team
                store.getUserRole = async function () {
                    if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                        return null;
                    }
                    const userRoles = this.getCurrentTeamRoles();
                    const teamId = this.currentTeam?.$id;
                    if (this.getPrimaryDisplayRole) {
                        return await this.getPrimaryDisplayRole(userRoles, teamId);
                    }
                    return userRoles[0] || null;
                };

                // Get current user's all roles in current team
                store.getUserRoles = async function () {
                    if (!this.currentTeam || !this.currentTeamMemberships || !this.user) {
                        return [];
                    }
                    const userRoles = this.getCurrentTeamRoles();
                    const teamId = this.currentTeam?.$id;
                    if (this.normalizeRolesForDisplay) {
                        return await this.normalizeRolesForDisplay(userRoles, teamId);
                    }
                    return userRoles;
                };

            } // End of if (!store.isCreatingTeam || typeof store.isCreatingTeam !== 'function')

            // Note: hasPermission from roles module takes (userRoles, permission, teamId)
            // hasTeamPermission is the convenience wrapper for current team

            // Update cache when team is viewed (wrap existing viewTeam if it exists)
            if (store.viewTeam && !store._viewTeamWrapped) {
                const originalViewTeam = store.viewTeam;
                store.viewTeam = async function (team) {
                    const result = await originalViewTeam.call(this, team);
                    // Update cache after viewing team (which loads memberships)
                    if (updatePermissionCache) {
                        await updatePermissionCache.call(this);
                    }
                    // Update available permissions for autocomplete
                    if (this.getAllAvailablePermissions && team && team.$id) {
                        this.allAvailablePermissions = await this.getAllAvailablePermissions(team.$id);
                    }
                    return result;
                };
                store._viewTeamWrapped = true; // Prevent double-wrapping
            }

        } else if (!store) {
            setTimeout(waitForStore, 50);
        }
    };

    setTimeout(waitForStore, 100);
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeTeamsConvenience();
    } catch (error) {
        // Failed to initialize teams convenience
    }
});

// Also try immediately if Alpine is already available
if (typeof Alpine !== 'undefined') {
    try {
        initializeTeamsConvenience();
    } catch (error) {
        // Alpine might not be fully initialized yet, that's okay
    }
}

// Export convenience interface
window.ManifestAppwriteAuthTeamsConvenience = {
    initialize: initializeTeamsConvenience
};



/* Auth anonymous */

// Add anonymous session methods to auth store
function initializeAnonymous() {
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
        if (store && !store._createAnonymousSession) {
            // Add anonymous session method to store (internal, used by store itself)
            store._createAnonymousSession = async function () {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                // Check if guest sessions are enabled (auto or manual)
                if (!this._guestAuto && !this._guestManual) {
                    return { success: false, error: 'Guest sessions are not enabled' };
                }

                try {
                    const session = await this._appwrite.account.createAnonymousSession();
                    this.session = session;
                    this.user = await this._appwrite.account.get();
                    this.isAuthenticated = true;
                    this.isAnonymous = true;

                    // Sync state to localStorage for cross-tab synchronization
                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    window.dispatchEvent(new CustomEvent('manifest:auth:anonymous', {
                        detail: { user: this.user }
                    }));

                    return { success: true, user: this.user };
                } catch (error) {
                    this.error = error.message;
                    this.isAuthenticated = false;
                    this.isAnonymous = false;
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

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeAnonymous();
    } catch (error) {
        // Failed to initialize anonymous
    }
});

// Export anonymous interface
window.ManifestAppwriteAuthAnonymous = {
    initialize: initializeAnonymous
};

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
                        // Store callback for retry
                        try {
                            sessionStorage.setItem('manifest:magic-link:callback', JSON.stringify({ userId, secret }));
                        } catch (e) {
                            // Ignore
                        }
                        this.error = 'Rate limit exceeded. Please wait a moment and refresh the page.';
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

        // Store callback for retry if rate limited
        try {
            sessionStorage.setItem('manifest:magic-link:callback', JSON.stringify({
                userId: callbackInfo.userId,
                secret: callbackInfo.secret
            }));
        } catch (e) {
            console.warn('[Manifest Appwrite Auth] Could not store callback:', e);
        }

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
                // Appwrite will create a new account for OAuth if needed
                if (this.isAnonymous && this.session) {
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
            // Delete any existing anonymous sessions first
            if (store.session && store.isAnonymous) {
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

            // Sync state
            if (store._syncStateToStorage) {
                store._syncStateToStorage(store);
            }

            // Load teams if enabled
            const appwriteConfig = await window.ManifestAppwriteAuthConfig.getAppwriteConfig();
            if (appwriteConfig?.teams && store.listTeams) {
                try {
                    await store.listTeams();
                    // Auto-create default teams if enabled
                    if ((appwriteConfig.permanentTeams || appwriteConfig.templateTeams) && window.ManifestAppwriteAuthTeamsDefaults?.ensureDefaultTeams) {
                        await window.ManifestAppwriteAuthTeamsDefaults.ensureDefaultTeams(store);
                    }
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

/* Auth callbacks */

// Handle authentication callbacks from URL parameters
// This module coordinates callback detection and delegates to method-specific handlers

function initializeCallbacks() {
    const config = window.ManifestAppwriteAuthConfig;
    if (!config) {
        return;
    }

    // Check for callback in URL or sessionStorage
    function detectCallback() {
        const fullUrl = window.location.href;
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('userId');
        const secret = urlParams.get('secret');
        const expire = urlParams.get('expire');

        // Check for stored callback (from rate limit retry)
        let storedCallback = null;
        try {
            const stored = sessionStorage.getItem('manifest:magic-link:callback');
            if (stored) {
                storedCallback = JSON.parse(stored);
            }
        } catch (e) {
            // Ignore parse errors
        }

        // Check OAuth redirect flag
        const isOAuthCallback = sessionStorage.getItem('manifest:oauth:redirect') === 'true';

        // Check for team invitation (teamId and membershipId in URL)
        const teamId = urlParams.get('teamId');
        const membershipId = urlParams.get('membershipId');
        const isTeamInvite = !!(teamId && membershipId && userId && secret);

        const callbackInfo = {
            userId: userId || storedCallback?.userId,
            secret: secret || storedCallback?.secret,
            expire: expire,
            teamId: teamId,
            membershipId: membershipId,
            isOAuth: isOAuthCallback,
            isTeamInvite: isTeamInvite,
            hasCallback: !!(userId || storedCallback?.userId) && !!(secret || storedCallback?.secret),
            hasExpired: !!expire && !userId && !secret
        };

        return callbackInfo;
    }

    // Clean up URL parameters
    function cleanupUrl() {
        const url = new URL(window.location.href);
        const paramsToRemove = ['userId', 'secret', 'expire', 'project', 'teamId', 'membershipId'];
        paramsToRemove.forEach(param => {
            while (url.searchParams.has(param)) {
                url.searchParams.delete(param);
            }
        });
        url.hash = '';
        window.history.replaceState({}, '', url.toString());
    }

    // Process callback - delegates to method-specific handlers
    async function processCallback(callbackInfo) {
        const store = Alpine.store('auth');
        if (!store || !store._appwrite) {
            return { handled: false };
        }

        const appwrite = store._appwrite;

        // Clean up URL immediately
        cleanupUrl();

        // Handle expired magic link
        if (callbackInfo.hasExpired) {
            // Dispatch event for magic link handler
            window.dispatchEvent(new CustomEvent('manifest:auth:callback:expired', {
                detail: callbackInfo
            }));
            return { handled: true, type: 'expired' };
        }

        // Handle valid callback (userId + secret)
        if (callbackInfo.hasCallback) {
            if (callbackInfo.isTeamInvite) {
                // Team invitation callback - dispatch event
                window.dispatchEvent(new CustomEvent('manifest:auth:callback:team', {
                    detail: callbackInfo
                }));
                return { handled: true, type: 'team' };
            } else if (callbackInfo.isOAuth) {
                // OAuth callback - dispatch event
                window.dispatchEvent(new CustomEvent('manifest:auth:callback:oauth', {
                    detail: callbackInfo
                }));
                return { handled: true, type: 'oauth' };
            } else {
                // Magic link callback - dispatch event
                window.dispatchEvent(new CustomEvent('manifest:auth:callback:magic', {
                    detail: callbackInfo
                }));
                return { handled: true, type: 'magic' };
            }
        }

        return { handled: false };
    }

    // Export callback detection and processing
    window.ManifestAppwriteAuthCallbacks = {
        detect: detectCallback,
        process: processCallback,
        cleanupUrl
    };
}

// Initialize when config is available
if (window.ManifestAppwriteAuthConfig) {
    initializeCallbacks();
} else {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.ManifestAppwriteAuthConfig) {
            initializeCallbacks();
        }
    });
}