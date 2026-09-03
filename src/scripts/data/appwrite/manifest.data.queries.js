/* Manifest Data Sources - Query Building */

// Whitelist of allowed variables for interpolation
const ALLOWED_VARIABLES = [
    '$auth.userId',
    '$auth.user.$id',
    '$auth.currentTeam.$id',
    '$auth.currentTeam.id',
    '$auth.session.$id',
    '$auth.session.id',
    '$locale.current'
];

// Get auth store value safely
// Path is relative to the auth store itself (e.g. "currentTeam.$id", not "auth.currentTeam.$id").
// Supports optional-chaining syntax ("currentTeam?.$id") by normalizing "?." to "." — a
// missing intermediate value already returns null via the loop below.
function getAuthValue(path) {
    try {
        const store = Alpine.store('auth');
        if (!store) return null;

        const parts = path.replace(/\?\./g, '.').split('.');
        let value = store;

        for (const part of parts) {
            if (value && typeof value === 'object') {
                value = value[part];
            } else {
                return null;
            }
        }

        return value;
    } catch (error) {
        return null;
    }
}

// Debug helper to inspect auth store
function debugAuthStore() {
    try {
        const store = Alpine.store('auth');
        if (!store) {
            return;
        }
        if (store.user) {
        }
    } catch (error) {
        console.error('[Manifest Data] Error inspecting auth store:', error);
    }
}

// Get locale value safely
function getLocaleValue() {
    try {
        const store = Alpine.store('locale');
        return store?.current || null;
    } catch (error) {
        return null;
    }
}

// Interpolate variables in a value
function interpolateVariable(value) {
    if (typeof value !== 'string') return value;

    // Check if it's a variable reference
    if (value.startsWith('$auth.')) {
        // Strip the '$auth.' prefix (not just '$') — Alpine.store('auth') IS the auth
        // object, so a path starting with another 'auth' segment would never resolve.
        const path = value.substring('$auth.'.length);
        return getAuthValue(path);
    } else if (value === '$locale.current') {
        return getLocaleValue();
    }

    return value;
}

// Check if a string is a variable that needs interpolation
// Variables follow patterns like $auth.xxx, $locale.xxx
// Appwrite system fields like $id, $createdAt, $updatedAt are NOT variables
function isVariable(str) {
    if (typeof str !== 'string' || !str.startsWith('$')) {
        return false;
    }
    // Variables have a namespace prefix (e.g., $auth, $locale)
    // Appwrite system fields are just $fieldName (no dot)
    return str.includes('.') || ALLOWED_VARIABLES.includes(str);
}

// Interpolate variables in query array
function interpolateQuery(query) {
    if (!Array.isArray(query) || query.length === 0) {
        return query;
    }

    const [method, ...args] = query;
    const interpolatedArgs = args.map(arg => {
        if (typeof arg === 'string' && isVariable(arg)) {
            // Check if it's in the whitelist
            if (ALLOWED_VARIABLES.includes(arg)) {
                return interpolateVariable(arg);
            } else {
                console.warn(`[Manifest Data] Variable "${arg}" is not in whitelist. Allowed:`, ALLOWED_VARIABLES);
                // SECURITY: Return empty string for non-whitelisted variables to prevent injection
                // Empty string will cause query to return no results (safe default)
                return '';
            }
        } else if (typeof arg === 'object' && arg !== null) {
            // Recursively interpolate objects
            return interpolateObject(arg);
        }
        return arg;
    });

    return [method, ...interpolatedArgs];
}

// Interpolate variables in an object
function interpolateObject(obj) {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
        return obj;
    }

    const result = {};
    for (const [key, value] of Object.entries(obj)) {
        if (typeof value === 'string' && isVariable(value)) {
            if (ALLOWED_VARIABLES.includes(value)) {
                result[key] = interpolateVariable(value);
            } else {
                console.warn(`[Manifest Data] Variable "${value}" is not in whitelist`);
                // SECURITY: Return empty string for non-whitelisted variables to prevent injection
                // Empty string will cause query to return no results (safe default)
                result[key] = '';
            }
        } else if (typeof value === 'object' && value !== null) {
            result[key] = interpolateObject(value);
        } else {
            result[key] = value;
        }
    }

    return result;
}

// Default scope column names, overridable per data source via `scopeColumn`
const DEFAULT_SCOPE_COLUMNS = { team: 'teamId', user: 'userId' };

// Build queries with scope injection
// SECURITY: Scope queries are ALWAYS prepended to user queries to prevent bypass
// scopeColumns: { team, user } column names to filter/write on (default teamId/userId)
async function buildQueries(queriesConfig, scope, scopeColumns) {
    const cols = { ...DEFAULT_SCOPE_COLUMNS, ...(scopeColumns || {}) };
    if (!queriesConfig || !Array.isArray(queriesConfig)) {
        return [];
    }

    // Interpolate user-provided queries
    const userQueries = queriesConfig.map(query => interpolateQuery(query));

    // SECURITY: Build scope queries FIRST (they will be prepended)
    // This ensures scope restrictions cannot be bypassed by user queries
    const scopeQueries = [];

    // Inject scope-based queries if scope is provided
    // Scope can be:
    // - "user" (uses userId column) - single user
    // - "team" (uses teamId column) - single team (currentTeam)
    // - "teams" (uses teamId column) - all teams user belongs to
    // - ["user", "team"] or ["team", "user"] - dual scope (both userId AND teamId)
    // - ["user", "teams"] - user AND all teams
    if (!scope) {
        return userQueries;
    }

    const scopeArray = Array.isArray(scope) ? scope : [scope];
    const hasUserScope = scopeArray.includes('user');
    const hasTeamScope = scopeArray.includes('team');
    const hasTeamsScope = scopeArray.includes('teams');

    // Wait for auth store to be initialized (shared for all scopes)
    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    if (authStore && (!authStore._initialized || authStore.isAuthenticated === undefined)) {
        let attempts = 0;
        const maxAttempts = 10; // Wait up to 500ms (10 * 50ms)
        while (attempts < maxAttempts && (!authStore._initialized || authStore.isAuthenticated === undefined)) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }
    }

    // Special case: ["user", "team"] or ["user", "teams"] or ["teams", "user"] or ["team", "user"] - use OR logic
    // Show projects that belong to user OR current team OR any of their teams
    // Note: "team" (singular) means currentTeam, "teams" (plural) means all teams in user's teams array
    if (hasUserScope && (hasTeamScope || hasTeamsScope)) {
        const isAuthenticated = authStore?.isAuthenticated === true;
        const user = authStore?.user;
        const teams = authStore?.teams || [];

        const orQueries = [];

        // Add user query
        if (isAuthenticated && user) {
            const userId = getAuthValue('userId') || getAuthValue('user.$id') || getAuthValue('user.id') || user.$id || user.id;
            if (userId) {
                orQueries.push(['equal', cols.user, userId]);
            } else {
            }
        } else {
        }

        // Add team queries
        // If hasTeamScope (singular), use currentTeam only
        // If hasTeamsScope (plural), use all teams in user's teams array
        let teamIds = [];
        if (hasTeamScope) {
            // Single team scope - use currentTeam
            const currentTeamId = authStore?.currentTeam?.$id || authStore?.currentTeam?.id;
            if (currentTeamId) {
                teamIds.push(currentTeamId);
            }
        }
        if (hasTeamsScope) {
            // Multi-team scope - use all teams in user's teams array
            const allTeamIds = teams
                .map(team => team.$id || team.id)
                .filter(id => id);
            teamIds.push(...allTeamIds);
        }

        // Remove duplicates
        teamIds = [...new Set(teamIds)];

        teamIds.forEach(teamId => {
            orQueries.push(['equal', cols.team, teamId]);
        });

        if (orQueries.length > 0) {
            if (orQueries.length === 1) {
                scopeQueries.push(orQueries[0]);
            } else {
                scopeQueries.push(['or', orQueries]);
            }
        } else {
            // No user or teams - return no results
            scopeQueries.push(['equal', cols.user, '']);
        }
    } else {
        // Handle user scope (when not combined with teams)
        if (hasUserScope) {
            const isAuthenticated = authStore?.isAuthenticated === true;
            const user = authStore?.user;

            if (!isAuthenticated || !user) {
                // User is not authenticated - return no results
                scopeQueries.push(['equal', cols.user, '']);
                // SECURITY: Return early with scope query to prevent any data access
                return scopeQueries;
            }

            // Get user ID value
            const userId = getAuthValue('userId') || getAuthValue('user.$id') || getAuthValue('user.id') || user.$id || user.id;
            if (userId) {
                scopeQueries.push(['equal', cols.user, userId]);
            } else {
                // User is authenticated but userId not found - return no results
                scopeQueries.push(['equal', cols.user, '']);
                if (!window.__manifestDataDebugLogged) {
                    window.__manifestDataDebugLogged = true;
                    debugAuthStore();
                }
            }
        }

        // Handle team scope (single team - takes precedence over teams)
        if (hasTeamScope) {
            // Try multiple paths to get team ID
            const teamId = getAuthValue('currentTeam.$id') ||
                getAuthValue('currentTeam.id') ||
                authStore?.currentTeam?.$id ||
                authStore?.currentTeam?.id;

            if (teamId) {
                scopeQueries.push(['equal', cols.team, teamId]);
            } else {
                // No team ID found - return no results
                scopeQueries.push(['equal', cols.team, '']);
            }
        } else if (hasTeamsScope) {
            // Multi-team scope - use all teams user belongs to
            // Get all team IDs from user's teams
            const teams = authStore?.teams || [];
            const teamIds = teams
                .map(team => team.$id || team.id)
                .filter(id => id); // Remove any undefined/null values

            if (teamIds.length > 0) {
                if (teamIds.length === 1) {
                    // Single team - use equal for efficiency
                    scopeQueries.push(['equal', cols.team, teamIds[0]]);
                } else {
                    // Multiple teams - use Query.or() with multiple Query.equal() calls
                    // Build: Query.or([Query.equal('teamId', id1), Query.equal('teamId', id2), ...])
                    const equalQueries = teamIds.map(id => ['equal', cols.team, id]);
                    scopeQueries.push(['or', equalQueries]);
                }
            } else {
                // No teams found - return no results
                scopeQueries.push(['equal', cols.team, '']);
            }
        }
    }

    // SECURITY: Prepend scope queries to user queries
    // This ensures scope restrictions are ALWAYS applied and cannot be bypassed
    // User queries that conflict with scope will be ANDed together (both must match)
    return [...scopeQueries, ...userQueries];
}

// Convert query array to Appwrite Query object
function toAppwriteQuery(queryArray) {
    if (!Array.isArray(queryArray) || queryArray.length === 0) {
        return null;
    }

    const [method, ...args] = queryArray;

    // Map common query methods to Appwrite Query methods
    const queryMap = {
        'equal': 'equal',
        'notEqual': 'notEqual',
        'lessThan': 'lessThan',
        'lessThanEqual': 'lessThanEqual',
        'greaterThan': 'greaterThan',
        'greaterThanEqual': 'greaterThanEqual',
        'contains': 'contains',
        'search': 'search',
        'or': 'or', // Support for multi-team queries (Query.or([Query.equal(...), ...]))
        'orderAsc': 'orderAsc',
        'orderDesc': 'orderDesc',
        'limit': 'limit',
        'offset': 'offset',
        'cursorAfter': 'cursorAfter',
        'cursorBefore': 'cursorBefore'
    };

    if (!window.Appwrite || !window.Appwrite.Query) {
        console.error('[Manifest Data] Appwrite Query not available');
        return null;
    }

    const queryMethod = queryMap[method];
    if (!queryMethod) {
        console.warn(`[Manifest Data] Unknown query method: ${method}`);
        return null;
    }

    try {
        // Special handling for 'or' queries - args[0] should be an array of query arrays
        if (method === 'or' && Array.isArray(args[0])) {
            // Build Query.or([Query.equal(...), Query.equal(...), ...])
            const orQueries = args[0]
                .map(queryArray => toAppwriteQuery(queryArray))
                .filter(query => query !== null);

            if (orQueries.length === 0) {
                return null;
            }

            if (orQueries.length === 1) {
                // Single query - return it directly (no need for or)
                return orQueries[0];
            }

            // Multiple queries - use Query.or()
            return window.Appwrite.Query.or(orQueries);
        }

        return window.Appwrite.Query[queryMethod](...args);
    } catch (error) {
        console.error(`[Manifest Data] Error building query ${method}:`, error);
        return null;
    }
}

// Build Appwrite queries from configuration
// scopeColumns: { team, user } column names (default teamId/userId) — see manifest.data.config.js getScopeColumns
async function buildAppwriteQueries(queriesConfig, scope, scopeColumns) {
    const queries = await buildQueries(queriesConfig, scope, scopeColumns);
    return queries
        .map(query => toAppwriteQuery(query))
        .filter(query => query !== null);
}

// Export functions to window for use by other subscripts
window.ManifestDataQueries = {
    interpolateVariable,
    interpolateQuery,
    interpolateObject,
    getAuthValue,
    buildQueries,
    buildAppwriteQueries,
    toAppwriteQuery,
    ALLOWED_VARIABLES,
    DEFAULT_SCOPE_COLUMNS
};
