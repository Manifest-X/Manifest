/*  Manifest Appwrite Auth — config resolution
/*  By Andrew Matlock under MIT license
*/

// Reject strings still holding an unresolved ${VAR} — an undefined env var that
// would leak verbatim into an Appwrite HTTP header. Loud-fail instead.
function resolvedOrNull(value, fieldName) {
    if (typeof value !== 'string') return value;
    if (/\$\{[^}]+\}/.test(value)) {
        console.error(`[Manifest Auth] manifest.appwrite.${fieldName} references an undefined env var (${value}). Auth disabled.`);
        return null;
    }
    return value;
}

// Load manifest if not already loaded
async function ensureManifest() {
    if (window.ManifestComponentsRegistry?.manifest) {
        return window.ManifestComponentsRegistry.manifest;
    }
    if (window.__manifestLoaded) {
        return window.__manifestLoaded;
    }

    try {
        const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
        const response = await fetch(manifestUrl);
        const manifest = await response.json();
        // No-loader path: resolve ${VAR} placeholders the dynamic loader would have.
        window.ManifestDataConfig?.interpolateManifest?.(manifest);
        return manifest;
    } catch (error) {
        return null;
    }
}

// Get Appwrite config from manifest
async function getAppwriteConfig() {
    const manifest = await ensureManifest();
    if (!manifest?.appwrite) {
        return null;
    }

    const appwriteConfig = manifest.appwrite;
    const endpoint = resolvedOrNull(appwriteConfig.endpoint, 'endpoint');
    const projectId = resolvedOrNull(appwriteConfig.projectId, 'projectId');
    // Optional dev key to bypass rate limits in development.
    const devKey = appwriteConfig.devKey ? resolvedOrNull(appwriteConfig.devKey, 'devKey') : undefined;

    if (!endpoint || !projectId) {
        return null;
    }
    // Supplied-but-unresolved devKey: drop the config rather than send a literal ${VAR} header.
    if (appwriteConfig.devKey && devKey === null) {
        return null;
    }

    // Auth methods (defaults to magic + oauth)
    const authMethods = appwriteConfig.auth?.methods || ["magic", "oauth"];

    // Guest sessions: "guest"/"guest-auto" = automatic, "guest-manual" = manual only.
    const guestAuto = authMethods.includes("guest") || authMethods.includes("guest-auto");
    const guestManual = authMethods.includes("guest-manual");
    const hasGuest = guestAuto || guestManual;

    const magicEnabled = authMethods.includes("magic");
    const otpEnabled = authMethods.includes("otp");
    const oauthEnabled = authMethods.includes("oauth");

    // Teams (presence of teams object enables it)
    const teamsEnabled = !!appwriteConfig.auth?.teams;
    const permanentTeams = appwriteConfig.auth?.teams?.permanent || null; // immutable
    const templateTeams = appwriteConfig.auth?.teams?.template || null; // deletable + reappliable
    const teamsPollInterval = appwriteConfig.auth?.teams?.pollInterval || null; // ms, null = disabled
    // Coerce a config boolean that may arrive as an interpolated string. `${VAR}`
    // placeholders resolve to strings, so a bare !! would read "false" as truthy and
    // break per-environment config (e.g. teams.guests via `${PUBLIC_GUESTS}`).
    const toBool = v => typeof v === 'string' ? /^(true|1|yes|on)$/i.test(v.trim()) : !!v;

    const guestTeams = toBool(appwriteConfig.auth?.teams?.guests); // seed default teams for guests
    // Seed default teams for authenticated (non-anonymous) sessions. Defaults to true
    // (historical behavior). Set teams.authenticated:false with teams.guests:true to make
    // seeding guest-only — e.g. a per-guest sandbox that must never be minted for a
    // signed-in user who already belongs to their real workspace.
    const authenticatedTeams = appwriteConfig.auth?.teams?.authenticated === undefined
        ? true
        : toBool(appwriteConfig.auth.teams.authenticated);

    // Guest upgrade: preserve the anonymous account + teams on sign-in (magic/oauth;
    // OTP can't convert anonymous accounts). Defaults to guestTeams.
    const guestUpgrade = appwriteConfig.auth?.guestUpgrade !== undefined
        ? toBool(appwriteConfig.auth.guestUpgrade)
        : guestTeams;

    // Default roles: { "RoleName": ["permission", ...] }
    const permanentRoles = appwriteConfig.auth?.roles?.permanent || null; // not deletable
    const templateRoles = appwriteConfig.auth?.roles?.template || null; // deletable

    // Member roles: permanent + template merged (fallback to legacy memberRoles)
    const memberRoles = permanentRoles || templateRoles
        ? { ...(permanentRoles || {}), ...(templateRoles || {}) }
        : (appwriteConfig.auth?.memberRoles || null);

    // Creator role: memberRoles key the creator gets by default (legacy singular)
    const creatorRole = appwriteConfig.auth?.creatorRole || null;

    // Creator roles (plural): role(s) assigned to the team creator atomically at creation.
    // string | string[] | null; explicit null/[] = owner-only. Wins over creatorRole.
    // Resolves to array (configured) or null (use historical default of first role).
    let creatorRoles = null;
    if (appwriteConfig.auth && Object.prototype.hasOwnProperty.call(appwriteConfig.auth, 'creatorRoles')) {
        const raw = appwriteConfig.auth.creatorRoles;
        creatorRoles = raw == null ? [] : (Array.isArray(raw) ? raw.filter(r => typeof r === 'string') : [raw]).filter(Boolean);
    } else if (creatorRole && memberRoles && memberRoles[creatorRole]) {
        creatorRoles = [creatorRole];
    }

    // Guest migration: deployed Appwrite Function id that carries guest teams to
    // the OTP account (which Appwrite can't convert in place).
    const guestMigrationFunctionId = appwriteConfig.auth?.guestMigration?.functionId || null;

    return {
        endpoint,
        projectId,
        devKey,
        authMethods,
        guest: hasGuest,
        guestAuto: guestAuto,
        guestManual: guestManual,
        anonymous: guestAuto, // back-compat alias
        magic: magicEnabled,
        otp: otpEnabled,
        oauth: oauthEnabled,
        teams: teamsEnabled,
        permanentTeams: permanentTeams,
        templateTeams: templateTeams,
        teamsPollInterval: teamsPollInterval,
        guestTeams: guestTeams,
        authenticatedTeams: authenticatedTeams, // seed defaults for authenticated sessions (default true)
        guestUpgrade: guestUpgrade,
        guestMigrationFunctionId: guestMigrationFunctionId,
        memberRoles: memberRoles,
        permanentRoles: permanentRoles,
        templateRoles: templateRoles,
        creatorRole: creatorRole,
        creatorRoles: creatorRoles
    };
}

// Initialize Appwrite client (assumes SDK loaded separately)
let appwriteClient = null;
let appwriteAccount = null;
let appwriteTeams = null;
let appwriteUsers = null;

async function getAppwriteClient() {
    if (!window.Appwrite || !window.Appwrite.Client || !window.Appwrite.Account) {
        return null;
    }

    if (!appwriteClient) {
        const config = await getAppwriteConfig();
        if (!config) {
            return null;
        }

        appwriteClient = new window.Appwrite.Client()
            .setEndpoint(config.endpoint)
            .setProject(config.projectId);

        // Dev key header bypasses rate limits in development.
        if (config.devKey) {
            appwriteClient.headers['X-Appwrite-Dev-Key'] = config.devKey;
        }

        appwriteAccount = new window.Appwrite.Account(appwriteClient);
        appwriteTeams = new window.Appwrite.Teams(appwriteClient);

        if (window.Appwrite.Users) {
            appwriteUsers = new window.Appwrite.Users(appwriteClient);
        }
    }

    return {
        client: appwriteClient,
        account: appwriteAccount,
        teams: appwriteTeams,
        users: appwriteUsers,
        functions: window.Appwrite?.Functions ? new window.Appwrite.Functions(appwriteClient) : null,
        realtime: window.Appwrite?.Realtime ? new window.Appwrite.Realtime(appwriteClient) : null
    };
}

// Export configuration interface
window.ManifestAppwriteAuthConfig = {
    getAppwriteConfig,
    getAppwriteClient,
    ensureManifest
};