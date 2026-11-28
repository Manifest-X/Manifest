/* Auth main */

// Initialize auth plugin - orchestrates all modules
let _pluginInitializing = false;
let _initHandled = false;
async function initializeAppwriteAuthPlugin() {
    if (_pluginInitializing) {
        return;
    }

    // Wait for dependencies
    if (!window.ManifestAppwriteAuthConfig) {
        return;
    }

    if (typeof Alpine === 'undefined') {
        return;
    }

    _pluginInitializing = true;

    // Wait for store to be ready
    const waitForStore = () => {
        const store = Alpine.store('auth');
        if (store) {
            // Initialize store first
            if (!store._initialized && !store._initializing) {
                store.init();
            }

            // After store init, process callbacks and validate config
            const onInitialized = async () => {
                if (_initHandled) return;
                _initHandled = true;
                const callbacks = window.ManifestAppwriteAuthCallbacks;
                const callbackInfo = callbacks ? callbacks.detect() : null;
                // Store methods this work calls attach on the other modules' 100 ms timers: wait briefly for them
                const needed = [];
                if (store._guestAuto) needed.push('_createAnonymousSession');
                if (callbackInfo?.hasCallback && !callbackInfo.isOAuth) needed.push(callbackInfo.isTeamInvite ? 'acceptInvite' : 'handleMagicLinkCallback');
                const missing = () => needed.filter(name => typeof store[name] !== 'function');
                for (let i = 0; i < 40 && missing().length; i++) {
                    await new Promise(r => setTimeout(r, 50));
                }
                if (missing().length) console.warn('[Manifest Appwrite Auth] Auth modules not ready after init:', missing().join(', '));
                // Validate role configuration if roles module is loaded
                if (store.validateRoleConfig) {
                    const validation = await store.validateRoleConfig();
                    if (!validation.valid) {
                        // Invalid role configuration
                    } else if (validation.warnings && validation.warnings.length > 0) {
                        // Validation warnings
                    }
                }

                // Process callbacks after store is initialized
                if (callbacks && (callbackInfo.hasCallback || callbackInfo.hasExpired)) {
                    callbacks.process(callbackInfo);
                }

                // If no session and guest-auto is enabled, create guest session (not while the session check is unreachable or a sign-in link awaits confirmation)
                if (!store.isAuthenticated && !store.signInPending && !store._sessionUnverified && store._guestAuto && store._createAnonymousSession) {
                    store._createAnonymousSession();
                }
            };
            // Init may have finished inside the start delay
            if (store._initAnnounced) onInitialized();
            else window.addEventListener('manifest:auth:initialized', onInitialized, { once: true });

            _pluginInitializing = false;
        } else {
            setTimeout(waitForStore, 50);
        }
    };

    // Start waiting after a short delay
    setTimeout(waitForStore, 150);
}

// Handle initialization
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.Alpine) initializeAppwriteAuthPlugin();
    });
}

document.addEventListener('alpine:init', initializeAppwriteAuthPlugin);

// Export main interface
window.ManifestAppwriteAuth = {
    initialize: initializeAppwriteAuthPlugin
};