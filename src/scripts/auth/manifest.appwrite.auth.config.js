/*  Manifest Appwrite Auth
/*  By Andrew Matlock under MIT license
/*  https://github.com/andrewmatlock/Manifest
/*
/*  Supports authentication with an Appwrite project
/*  Requires Alpine JS (alpinejs.dev) to operate
*/

/* Auth config */

// Refuse strings that still contain an unresolved ${VAR} reference. The loader
// runs window.ManifestDataConfig.interpolateManifest at manifest-load time, so
// by the time we read these fields the env-var substitution has already been
// applied. Anything still matching ${VAR} is an undefined env var — passing it
// to Appwrite would either silently fail or, worse, be sent verbatim as an
// HTTP header value, leaking the env var name. Loud-fail instead.
function resolvedOrNull(value, fieldName) {
    if (typeof value !== 'string') return value;
    if (/\$\{[^}]+\}/.test(value)) {
        console.error(`[Manifest Auth] manifest.appwrite.${fieldName} references an undefined env var (${value}). Auth disabled.`);
        return null;
    }
    return value;
}

// Load manifest if not already loaded (loader may set __manifestLoaded / registry.manifest)
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
        return await response.json();
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
    // Optional dev key to bypass rate limits in development. The schema
    // documents `${VAR_NAME}` interpolation for this field specifically —
    // refuse to forward a literal placeholder as an HTTP header.
    const devKey = appwriteConfig.devKey ? resolvedOrNull(appwriteConfig.devKey, 'devKey') : undefined;

    if (!endpoint || !projectId) {
        return null;
    }
    // devKey is optional: if the user supplied one but it failed to resolve,
    // resolvedOrNull returned null (and logged) — drop the field rather than
    // initialize Appwrite with a literal `${VAR}` header.
    if (appwriteConfig.devKey && devKey === null) {
        return null;
    }

    // Get auth methods from config (defaults to ["magic", "oauth"] if not specified)
    const authMethods = appwriteConfig.auth?.methods || ["magic", "oauth"];

    // Guest session support: "guest-auto" = automatic, "guest-manual" = manual only
    const guestAuto = authMethods.includes("guest-auto");
    const guestManual = authMethods.includes("guest-manual");
    const hasGuest = guestAuto || guestManual;

    const magicEnabled = authMethods.includes("magic");
    const oauthEnabled = authMethods.includes("oauth");

    // Teams support: presence of teams object enables it
    const teamsEnabled = !!appwriteConfig.auth?.teams;
    const permanentTeams = appwriteConfig.auth?.teams?.permanent || null; // Array of team names (immutable)
    const templateTeams = appwriteConfig.auth?.teams?.template || null; // Array of team names (can be deleted and reapplied)
    const teamsPollInterval = appwriteConfig.auth?.teams?.pollInterval || null; // Polling interval in milliseconds (null = disabled)

    // Default roles: permanent (cannot be deleted) and template (can be deleted)
    // These are objects mapping role names to permissions: { "Admin": ["inviteMembers", ...] }
    const permanentRoles = appwriteConfig.auth?.roles?.permanent || null; // Object: { "RoleName": ["permission1", ...] }
    const templateRoles = appwriteConfig.auth?.roles?.template || null; // Object: { "RoleName": ["permission1", ...] }

    // Member roles: derived from permanent and template roles (merged)
    // This is used for role normalization, permission checking, and creatorRole logic
    const memberRoles = permanentRoles || templateRoles
        ? { ...(permanentRoles || {}), ...(templateRoles || {}) }
        : (appwriteConfig.auth?.memberRoles || null); // Fallback to legacy memberRoles if roles not defined

    // Creator role: string reference to a role in memberRoles (role creator gets by default)
    const creatorRole = appwriteConfig.auth?.creatorRole || null;

    return {
        endpoint,
        projectId,
        devKey, // Optional dev key for development
        authMethods,
        guest: hasGuest,
        guestAuto: guestAuto,
        guestManual: guestManual,
        anonymous: guestAuto, // For backwards compatibility with existing code
        magic: magicEnabled,
        oauth: oauthEnabled,
        teams: teamsEnabled,
        permanentTeams: permanentTeams, // Array of team names (cannot be deleted)
        templateTeams: templateTeams, // Array of team names (can be deleted and reapplied)
        teamsPollInterval: teamsPollInterval, // Polling interval in milliseconds (null = disabled)
        memberRoles: memberRoles, // Role definitions: { "RoleName": ["permission1", "permission2"] }
        permanentRoles: permanentRoles, // Object: { "RoleName": ["permission1", ...] } (cannot be deleted)
        templateRoles: templateRoles, // Object: { "RoleName": ["permission1", ...] } (can be deleted)
        creatorRole: creatorRole // String reference to memberRoles key
    };
}

// Initialize Appwrite client (assumes SDK loaded separately)
let appwriteClient = null;
let appwriteAccount = null;
let appwriteTeams = null;
let appwriteUsers = null;

async function getAppwriteClient() {
    // Check if Appwrite SDK is loaded
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

        // Add dev key header if provided (bypasses rate limits in development)
        // See: https://appwrite.io/docs/advanced/platform/rate-limits#dev-keys
        if (config.devKey) {
            appwriteClient.headers['X-Appwrite-Dev-Key'] = config.devKey;
        }

        appwriteAccount = new window.Appwrite.Account(appwriteClient);
        appwriteTeams = new window.Appwrite.Teams(appwriteClient);

        // Initialize Users service if available (for fetching user details)
        if (window.Appwrite.Users) {
            appwriteUsers = new window.Appwrite.Users(appwriteClient);
        }
    }

    return {
        client: appwriteClient,
        account: appwriteAccount,
        teams: appwriteTeams,
        users: appwriteUsers, // Add users service for fetching user details
        realtime: window.Appwrite?.Realtime ? new window.Appwrite.Realtime(appwriteClient) : null // Realtime service for subscriptions
    };
}

// Export configuration interface
window.ManifestAppwriteAuthConfig = {
    getAppwriteConfig,
    getAppwriteClient,
    ensureManifest
};