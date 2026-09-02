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
                    invalidateRolesCache(teamId);
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
                    invalidateRolesCache(teamId);
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
                    invalidateRolesCache(teamId);
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

                                invalidateRolesCache(teamId);

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
                        invalidateRolesCache(teamId);
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

