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
                } else {
                    console.warn(`[Manifest Appwrite Auth] Could not seed permanent team "${teamName}":`, result.error);
                }
            } catch (error) {
                console.warn(`[Manifest Appwrite Auth] Error seeding permanent team "${teamName}":`, error);
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
                } else {
                    console.warn(`[Manifest Appwrite Auth] Could not seed template team "${teamName}":`, result.error);
                }
            } catch (error) {
                console.warn(`[Manifest Appwrite Auth] Error seeding template team "${teamName}":`, error);
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

