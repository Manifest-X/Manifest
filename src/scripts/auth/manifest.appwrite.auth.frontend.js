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