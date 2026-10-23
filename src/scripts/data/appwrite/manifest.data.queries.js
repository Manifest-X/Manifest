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

// Thrown by interpolateQuery/interpolateObject when a whitelisted $auth.
// variable hasn't resolved yet (auth store not settled) — buildQueries
// catches this and returns NOT_READY rather than sending a query with a
// null/undefined arg (Appwrite 400s on that) to the network.
const NOT_READY = Symbol('manifest-data-not-ready');

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
                const value = interpolateVariable(arg);
                if (value === null || value === undefined) throw NOT_READY;
                return value;
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
                const resolved = interpolateVariable(value);
                if (resolved === null || resolved === undefined) throw NOT_READY;
                result[key] = resolved;
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

// Event-driven wait for the auth store's initial hydration — resolves immediately
// once already settled, otherwise waits for manifest:auth:initialized (capped so a
// misconfigured/absent auth plugin can't hang a read forever).
const AUTH_INIT_WAIT_MS = 3000;
function waitForAuthInit(authStore) {
    if (!authStore || (authStore._initialized && authStore.isAuthenticated !== undefined)) {
        return Promise.resolve();
    }
    if (typeof window === 'undefined') return Promise.resolve();
    return new Promise(resolve => {
        let done = false;
        const timer = setTimeout(finish, AUTH_INIT_WAIT_MS);
        function finish() {
            if (done) return;
            done = true;
            clearTimeout(timer);
            window.removeEventListener('manifest:auth:initialized', finish);
            resolve();
        }
        window.addEventListener('manifest:auth:initialized', finish);
    });
}

// Build queries with scope injection. Returns null ("not ready") instead of a
// query array when a $auth. arg or a required scope value hasn't resolved yet
// — callers must skip the read (never send a null/undefined/empty-equal arg to
// Appwrite) and retry once auth settles (manifest:auth:initialized/teams-loaded/login).
// SECURITY: Scope queries are ALWAYS prepended to user queries to prevent bypass
// scopeColumns: { team, user } column names to filter/write on (default teamId/userId)
async function buildQueries(queriesConfig, scope, scopeColumns) {
    const cols = { ...DEFAULT_SCOPE_COLUMNS, ...(scopeColumns || {}) };
    if (!queriesConfig || !Array.isArray(queriesConfig)) {
        return [];
    }

    // Wait for auth to settle before interpolating — a $auth. reference in a raw
    // user query (queries.default) needs this regardless of whether `scope` is set.
    const authStore = typeof Alpine !== 'undefined' ? Alpine.store('auth') : null;
    await waitForAuthInit(authStore);

    // Interpolate user-provided queries
    let userQueries;
    try {
        userQueries = queriesConfig.map(query => interpolateQuery(query));
    } catch (e) {
        if (e === NOT_READY) return null;
        throw e;
    }

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
            // No user or teams resolved — not ready (or genuinely unauthenticated):
            // skip the read rather than send an empty-equal; caller retries on an auth event.
            return null;
        }
    } else {
        // Handle user scope (when not combined with teams)
        if (hasUserScope) {
            const isAuthenticated = authStore?.isAuthenticated === true;
            const user = authStore?.user;

            if (!isAuthenticated || !user) {
                // Not (yet) authenticated — skip the read; caller retries on manifest:auth:login
                return null;
            }

            // Get user ID value
            const userId = getAuthValue('userId') || getAuthValue('user.$id') || getAuthValue('user.id') || user.$id || user.id;
            if (userId) {
                scopeQueries.push(['equal', cols.user, userId]);
            } else {
                // Authenticated but userId not found — not ready
                if (!window.__manifestDataDebugLogged) {
                    window.__manifestDataDebugLogged = true;
                    debugAuthStore();
                }
                return null;
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
                // No current team (yet) — skip the read; caller retries on manifest:auth:teams-loaded
                return null;
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
                // No teams (yet) — skip the read; caller retries on manifest:auth:teams-loaded
                return null;
            }
        }
    }

    // SECURITY: Prepend scope queries to user queries
    // This ensures scope restrictions are ALWAYS applied and cannot be bypassed
    // User queries that conflict with scope will be ANDed together (both must match)
    return [...scopeQueries, ...userQueries];
}

// Query methods buildAppwriteQueries serializes (anything else is dropped at
// load and must therefore never drop rows in the realtime matcher below)
const QUERY_MAP = {
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

// Client-side row matcher for realtime events: evaluates a source's configured
// filter queries against one row. Only operators the load actually serializes
// (QUERY_MAP) are evaluable. Liveness over precision: anything unevaluable —
// search, an operator the load drops, or a $auth. arg that can't resolve
// synchronously — counts as a MATCH so live events are never silently dropped.
const NON_FILTER_METHODS = new Set(['limit', 'offset', 'orderAsc', 'orderDesc', 'select', 'cursorAfter', 'cursorBefore']);

function rowMatchesQueries(row, queriesConfig) {
    if (!row || !Array.isArray(queriesConfig) || queriesConfig.length === 0) return true;
    return queriesConfig.every(query => matchQuery(row, query));
}

function matchQuery(row, query) {
    if (!Array.isArray(query) || query.length === 0) return true;
    let interpolated;
    try {
        interpolated = interpolateQuery(query);
    } catch (e) {
        if (e === NOT_READY) return true; // unresolved $auth. arg
        throw e;
    }
    const [method, ...args] = interpolated;
    if (NON_FILTER_METHODS.has(method)) return true;
    if (!(method in QUERY_MAP)) return true; // load drops it: unevaluable
    if (method === 'and') return Array.isArray(args[0]) ? args[0].every(sub => matchQuery(row, sub)) : true;
    if (method === 'or') return Array.isArray(args[0]) ? args[0].some(sub => matchQuery(row, sub)) : true;

    const attr = args[0];
    const val = row ? row[attr] : undefined;
    const values = Array.isArray(args[1]) ? args[1] : [args[1]];
    // Strings compare case-insensitively (Appwrite's ci collation); other types strictly
    const eq = (a, b) => (typeof a === 'string' && typeof b === 'string')
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    const anyEqual = () => Array.isArray(val)
        ? values.some(v => val.some(el => eq(el, v)))
        : values.some(v => eq(val, v));
    const cmp = (bound, op) => val !== null && val !== undefined && bound !== null && bound !== undefined && op(val, bound);
    const lower = s => String(s).toLowerCase();

    switch (method) {
        case 'equal': return anyEqual();
        case 'notEqual': return !anyEqual();
        case 'lessThan': return cmp(args[1], (a, b) => a < b);
        case 'lessThanEqual': return cmp(args[1], (a, b) => a <= b);
        case 'greaterThan': return cmp(args[1], (a, b) => a > b);
        case 'greaterThanEqual': return cmp(args[1], (a, b) => a >= b);
        case 'between': return cmp(args[1], (a, b) => a >= b) && cmp(args[2], (a, b) => a <= b);
        case 'isNull': return val === null || val === undefined;
        case 'isNotNull': return val !== null && val !== undefined;
        case 'startsWith': return typeof val === 'string' && values.some(v => lower(val).startsWith(lower(v)));
        case 'endsWith': return typeof val === 'string' && values.some(v => lower(val).endsWith(lower(v)));
        case 'contains':
            if (Array.isArray(val)) return values.some(v => val.some(el => eq(el, v)));
            if (typeof val === 'string') return values.some(v => lower(val).includes(lower(v)));
            return false;
        default: return true; // search: unevaluable
    }
}

// Convert query array to Appwrite Query object
function toAppwriteQuery(queryArray) {
    if (!Array.isArray(queryArray) || queryArray.length === 0) {
        return null;
    }

    const [method, ...args] = queryArray;

    // Map common query methods to Appwrite Query methods (QUERY_MAP above —
    // also the realtime matcher's evaluable set)
    const queryMap = QUERY_MAP;

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

// Realtime-expressible operators: the intersection of what the load serializes
// (QUERY_MAP), what the matcher evaluates, and what Appwrite realtime filters
// server-side. isNull/isNotNull are realtime-supported but the load drops them,
// so filtering on them server-side would drop events the matcher keeps — excluded.
const REALTIME_FILTER_OPS = new Set(['equal', 'notEqual', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual']);

function isRealtimeExpressible(query) {
    if (!Array.isArray(query) || query.length === 0) return false;
    const [method, ...args] = query;
    if (method === 'or') return Array.isArray(args[0]) && args[0].length > 0 && args[0].every(isRealtimeExpressible);
    return REALTIME_FILTER_OPS.has(method);
}

// Server-side realtime filter set: the source's resolved (scope + user) queries
// reduced to the expressible subset. Omitting a query only WIDENS delivery —
// the client matcher still filters — so unexpressible queries are dropped
// whole, never approximated. Returns { queries, key } (key = canonical sorted
// serialization, for subscription sharing) or null (not ready / nothing
// expressible → channel-only subscribe, the 0.5.248 path).
async function buildRealtimeQueries(queriesConfig, scope, scopeColumns) {
    const resolved = await buildQueries(Array.isArray(queriesConfig) ? queriesConfig : [], scope, scopeColumns);
    if (resolved === null) return null;
    const queries = resolved
        .filter(isRealtimeExpressible)
        .map(query => toAppwriteQuery(query))
        .filter(query => query !== null);
    if (queries.length === 0) return null;
    const key = queries.map(q => typeof q === 'string' ? q : JSON.stringify(q)).sort().join('\u001e');
    return { queries, key };
}

// Build Appwrite queries from configuration
// scopeColumns: { team, user } column names (default teamId/userId) — see manifest.data.config.js getScopeColumns
// Returns null ("not ready") straight through — see buildQueries.
async function buildAppwriteQueries(queriesConfig, scope, scopeColumns) {
    const queries = await buildQueries(queriesConfig, scope, scopeColumns);
    if (queries === null) return null;
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
    buildRealtimeQueries,
    rowMatchesQueries,
    toAppwriteQuery,
    ALLOWED_VARIABLES,
    DEFAULT_SCOPE_COLUMNS
};
