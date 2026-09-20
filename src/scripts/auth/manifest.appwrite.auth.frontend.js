/* Auth frontend */

// Initialize $auth magic method
function initializeAuthMagic() {
    if (typeof Alpine === 'undefined') {
        return false;
    }

    // Add $auth magic method (like $locale, $colors)
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
                    // Non-function value that should be a convenience method → store was recreated
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
                            // Reinitialize synchronously, then re-check
                            if (window.ManifestAppwriteAuthTeamsConvenience && window.ManifestAppwriteAuthTeamsConvenience.initialize) {
                                try {
                                    window.ManifestAppwriteAuthTeamsConvenience.initialize();
                                    const reinitializedValue = store[prop];
                                    if (typeof reinitializedValue === 'function') {
                                        return reinitializedValue.bind(store);
                                    }
                                } catch (error) {
                                    // Failed to reinitialize, continue to fallback
                                }
                            }
                            // Safe fallbacks while methods reinitialize
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
                    // Hand back the real value — no placeholder. A signed-out
                    // user is null, not a stand-in object: `?.`, `||` and typeof
                    // must all behave. Templates use `$auth.user?.email`; Alpine
                    // renders undefined as ''.
                    return value;
                }

                // Missing property: reinitialize known convenience methods (guards post-idle errors)
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

                // Unknown property — undefined, same as any other object.
                return undefined;
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