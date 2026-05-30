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
            // Decide whether to (re)attach convenience methods. Use a sentinel
            // that ONLY this module defines — `createTeamFromName`. The earlier
            // sentinel (`isCreatingTeam`) was unreliable: the store itself
            // defines an `isCreatingTeam()` stub at init (see manifest.appwrite
            // .auth.store.js — the "Stub team convenience methods" block), so
            // `typeof store.isCreatingTeam === 'function'` is true BEFORE this
            // module runs. The check then fired false-positive and skipped the
            // whole `if (needsReinitialization)` block below, leaving the real
            // convenience methods (startEditingMember, createTeamFromName,
            // cancelEditingMember, saveEditingMember, deleteMember, leaveTeam,
            // toggleInviteRole, etc.) unattached — surfacing as
            // "$auth.startEditingMember is not a function" the moment a user
            // clicked an edit-member button.
            const needsReinitialization = typeof store.createTeamFromName !== 'function';
            
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

