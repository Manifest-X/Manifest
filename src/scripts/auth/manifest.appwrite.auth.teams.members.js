/* Auth teams - Membership operations */

// The Users service is server-only (node-appwrite); it is never present on the
// browser SDK, so member-email enrichment degrades gracefully. Warn once rather
// than on every membership lookup to avoid flooding the console. The flag lives on
// window (not a module `let`) so "once" holds across the whole page even if the
// bundle is evaluated more than once or memberships load concurrently.
function _warnUsersServiceOnce() {
    if (typeof window !== 'undefined') {
        if (window.__manifestAuthUsersServiceWarned) return;
        window.__manifestAuthUsersServiceWarned = true;
    }
    console.warn('[Manifest Appwrite Auth] Users service unavailable on the browser SDK — member emails will not be enriched. (This is expected; logged once.)');
}

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
                                            _warnUsersServiceOnce();
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
                                                    _warnUsersServiceOnce();
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

