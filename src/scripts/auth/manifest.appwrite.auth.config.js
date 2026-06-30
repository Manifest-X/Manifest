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

    // Guest session support: "guest"/"guest-auto" = automatic, "guest-manual" = manual only.
    // ("guest" is the schema's documented spelling; "guest-auto" is accepted as a synonym.)
    const guestAuto = authMethods.includes("guest") || authMethods.includes("guest-auto");
    const guestManual = authMethods.includes("guest-manual");
    const hasGuest = guestAuto || guestManual;

    const magicEnabled = authMethods.includes("magic");
    const otpEnabled = authMethods.includes("otp");
    const oauthEnabled = authMethods.includes("oauth");

    // Teams support: presence of teams object enables it
    const teamsEnabled = !!appwriteConfig.auth?.teams;
    const permanentTeams = appwriteConfig.auth?.teams?.permanent || null; // Array of team names (immutable)
    const templateTeams = appwriteConfig.auth?.teams?.template || null; // Array of team names (can be deleted and reapplied)
    const teamsPollInterval = appwriteConfig.auth?.teams?.pollInterval || null; // Polling interval in milliseconds (null = disabled)
    const guestTeams = !!appwriteConfig.auth?.teams?.guests; // Seed default teams for guest (anonymous) sessions

    // Guest upgrade: preserve the anonymous account (and its teams) when a guest signs in,
    // rather than discarding it and minting a fresh user. Supported by magic links and OAuth;
    // email OTP cannot convert anonymous accounts (Appwrite limitation). Defaults to guestTeams,
    // since orphaning guest-created teams on signup is the failure mode guest teams introduce.
    const guestUpgrade = appwriteConfig.auth?.guestUpgrade !== undefined
        ? !!appwriteConfig.auth.guestUpgrade
        : guestTeams;

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

    // Creator roles (plural): the custom role(s) the team creator is assigned, atomically,
    // at team creation. Accepts string | string[] | null. An explicit null / [] means
    // "no template role — creator holds only Appwrite's intrinsic owner". Takes precedence
    // over the legacy singular `creatorRole`. When NEITHER is set, createTeam keeps its
    // historical default (first defined role). Resolved to: array (configured, [] = owner-only)
    // or null (unconfigured → use the historical default).
    let creatorRoles = null;
    if (appwriteConfig.auth && Object.prototype.hasOwnProperty.call(appwriteConfig.auth, 'creatorRoles')) {
        const raw = appwriteConfig.auth.creatorRoles;
        creatorRoles = raw == null ? [] : (Array.isArray(raw) ? raw.filter(r => typeof r === 'string') : [raw]).filter(Boolean);
    } else if (creatorRole && memberRoles && memberRoles[creatorRole]) {
        creatorRoles = [creatorRole];
    }

    // Guest migration: id of the deployed guest-migration Appwrite Function. When set,
    // a guest's teams are carried over to the account they sign into via OTP (which
    // Appwrite can't convert in place). See templates/guest-migration-function.
    const guestMigrationFunctionId = appwriteConfig.auth?.guestMigration?.functionId || null;

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
        otp: otpEnabled, // Email one-time-passcode authentication
        oauth: oauthEnabled,
        teams: teamsEnabled,
        permanentTeams: permanentTeams, // Array of team names (cannot be deleted)
        templateTeams: templateTeams, // Array of team names (can be deleted and reapplied)
        teamsPollInterval: teamsPollInterval, // Polling interval in milliseconds (null = disabled)
        guestTeams: guestTeams, // Seed default teams for guest (anonymous) sessions
        guestUpgrade: guestUpgrade, // Preserve guest account + teams on sign-in (magic/oauth)
        guestMigrationFunctionId: guestMigrationFunctionId, // Carry guest teams to the OTP account via this function
        memberRoles: memberRoles, // Role definitions: { "RoleName": ["permission1", "permission2"] }
        permanentRoles: permanentRoles, // Object: { "RoleName": ["permission1", ...] } (cannot be deleted)
        templateRoles: templateRoles, // Object: { "RoleName": ["permission1", ...] } (can be deleted)
        creatorRole: creatorRole, // String reference to memberRoles key (legacy singular)
        creatorRoles: creatorRoles // array (configured; [] = owner-only) or null (use historical default)
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
        functions: window.Appwrite?.Functions ? new window.Appwrite.Functions(appwriteClient) : null, // For guest-migration function calls
        realtime: window.Appwrite?.Realtime ? new window.Appwrite.Realtime(appwriteClient) : null // Realtime service for subscriptions
    };
}

// Export configuration interface
window.ManifestAppwriteAuthConfig = {
    getAppwriteConfig,
    getAppwriteClient,
    ensureManifest
};