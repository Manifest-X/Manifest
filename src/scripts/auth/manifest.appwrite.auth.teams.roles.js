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

// Appwrite membership role tokens allow only [a-zA-Z0-9._-]. Role definitions are
// keyed by display name (which may contain spaces/unicode), so we store an
// Appwrite-safe slug on the membership and resolve by matching slug(token) against
// slug(defName). Idempotent, and "owner" (Appwrite's intrinsic role) passes through.
function roleSlug(name) {
    if (name === 'owner') return 'owner';
    return String(name)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

// Normalize custom roles for Appwrite: slugify tokens (so space/unicode names stay
// assignable) and add "owner" if any role requires it.
function normalizeRolesForAppwrite(customRoles, memberRoles, userGeneratedRoles = null) {
    if (!Array.isArray(customRoles)) {
        return customRoles;
    }

    const slugged = customRoles.map(role => roleSlug(role));

    // Merge manifest and user-generated roles
    const allRoles = mergeRoles(memberRoles, userGeneratedRoles);

    // If no roles config, return slugged tokens (Appwrite handles owner default)
    if (!allRoles || Object.keys(allRoles).length === 0) {
        return slugged;
    }

    // Which definition slugs require owner — checked by slug so this works whether the
    // incoming tokens are display names or already slugged.
    const ownerSlugs = new Set();
    for (const name of Object.keys(allRoles)) {
        if (roleRequiresOwner(name, allRoles)) ownerSlugs.add(roleSlug(name));
    }
    const requiresOwner = slugged.some(s => ownerSlugs.has(s));

    // If owner is already in the list, don't duplicate
    if (requiresOwner && !slugged.includes('owner')) {
        return [...slugged, 'owner'];
    }

    return slugged;
}

// Normalize Appwrite roles for display (filter "owner" if a custom role replaces it)
function normalizeRolesForDisplay(appwriteRoles, memberRoles, userGeneratedRoles = null) {
    if (!Array.isArray(appwriteRoles)) {
        return appwriteRoles;
    }

    // Merge manifest and user-generated roles
    const allRoles = mergeRoles(memberRoles, userGeneratedRoles);

    // If custom roles are defined, filter out "owner" (a background Appwrite role) and
    // translate slug tokens back to their display names (legacy exact-name tokens map
    // through slug() too; unknown tokens pass through as-is).
    if (allRoles && Object.keys(allRoles).length > 0) {
        const bySlug = {};
        for (const name of Object.keys(allRoles)) bySlug[roleSlug(name)] = name;
        return appwriteRoles
            .filter(role => role !== 'owner')
            .map(role => bySlug[roleSlug(role)] || role);
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

    // Check if any of the user's custom roles has this permission. Match by slug so
    // display-name definitions resolve against slugged membership tokens, and legacy
    // exact-name tokens still resolve.
    const bySlug = {};
    for (const [name, perms] of Object.entries(allRoles)) bySlug[roleSlug(name)] = perms;
    for (const roleName of customRoles) {
        const rolePermissions = bySlug[roleSlug(roleName)];
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

            store.roleSlug = function (name) {
                return roleSlug(name);
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
    roleSlug,
    normalizeRolesForAppwrite,
    normalizeRolesForDisplay,
    getPrimaryDisplayRole,
    hasPermission,
    getCreatorRolePermissions
};
