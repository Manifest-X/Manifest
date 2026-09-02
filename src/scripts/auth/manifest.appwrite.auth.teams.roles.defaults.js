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
                    invalidateRolesCache(teamId);
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
                        invalidateRolesCache(teamId);
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

