/* Auth main */

// Initialize auth plugin - orchestrates all modules
let _pluginInitializing = false;
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
            window.addEventListener('manifest:auth:initialized', async () => {
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
                if (window.ManifestAppwriteAuthCallbacks) {
                    const callbackInfo = window.ManifestAppwriteAuthCallbacks.detect();
                    if (callbackInfo.hasCallback || callbackInfo.hasExpired) {
                        window.ManifestAppwriteAuthCallbacks.process(callbackInfo);
                    }
                }

                // If no session and guest-auto is enabled, create guest session (not while the session check is unreachable)
                if (!store.isAuthenticated && !store._sessionUnverified && store._guestAuto && store._createAnonymousSession) {
                    store._createAnonymousSession();
                }
            }, { once: true });

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