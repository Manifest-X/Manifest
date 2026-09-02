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
                        const memberRoles = appwriteConfig?.memberRoles;
                        const configuredCreatorRoles = appwriteConfig?.creatorRoles; // array | null

                        if (Array.isArray(configuredCreatorRoles)) {
                            // Explicitly configured via auth.creatorRoles (or legacy creatorRole).
                            // An empty array means "owner-only" — the creator holds just
                            // Appwrite's intrinsic owner, with no template role assigned.
                            creatorRoles = configuredCreatorRoles.length ? configuredCreatorRoles.slice() : ['owner'];
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
                    invalidateRolesCache(teamId);
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

