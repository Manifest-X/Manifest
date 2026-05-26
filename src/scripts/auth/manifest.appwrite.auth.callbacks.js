/* Auth callbacks */

// Handle authentication callbacks from URL parameters
// This module coordinates callback detection and delegates to method-specific handlers

function initializeCallbacks() {
    const config = window.ManifestAppwriteAuthConfig;
    if (!config) {
        return;
    }

    // Check for callback in URL or sessionStorage
    function detectCallback() {
        const urlParams = new URLSearchParams(window.location.search);
        const userId = urlParams.get('userId');
        const secret = urlParams.get('secret');
        const expire = urlParams.get('expire');

        // Eagerly clear any stale magic-link credentials left in sessionStorage
        // by an earlier (pre-fix) Manifest version. We no longer persist them,
        // and reading stale ones could resurrect a credential that should have
        // been forgotten.
        try { sessionStorage.removeItem('manifest:magic-link:callback'); } catch (e) {}

        // Check OAuth redirect flag
        const isOAuthCallback = sessionStorage.getItem('manifest:oauth:redirect') === 'true';

        return {
            userId: userId,
            secret: secret,
            expire: expire,
            isOAuth: isOAuthCallback,
            hasCallback: !!userId && !!secret,
            hasExpired: !!expire && !userId && !secret
        };
    }

    // Clean up URL parameters
    function cleanupUrl() {
        const url = new URL(window.location.href);
        const paramsToRemove = ['userId', 'secret', 'expire', 'project'];
        paramsToRemove.forEach(param => {
            while (url.searchParams.has(param)) {
                url.searchParams.delete(param);
            }
        });
        url.hash = '';
        window.history.replaceState({}, '', url.toString());
    }

    // Process callback - delegates to method-specific handlers
    async function processCallback(callbackInfo) {
        const store = Alpine.store('auth');
        if (!store || !store._appwrite) {
            return { handled: false };
        }

        const appwrite = store._appwrite;

        // Clean up URL immediately
        cleanupUrl();

        // Handle expired magic link
        if (callbackInfo.hasExpired) {
            // Dispatch event for magic link handler
            window.dispatchEvent(new CustomEvent('manifest:auth:callback:expired', {
                detail: callbackInfo
            }));
            return { handled: true, type: 'expired' };
        }

        // Handle valid callback (userId + secret)
        if (callbackInfo.hasCallback) {
            if (callbackInfo.isOAuth) {
                // OAuth callback - dispatch event
                window.dispatchEvent(new CustomEvent('manifest:auth:callback:oauth', {
                    detail: callbackInfo
                }));
                return { handled: true, type: 'oauth' };
            } else {
                // Magic link callback - dispatch event
                window.dispatchEvent(new CustomEvent('manifest:auth:callback:magic', {
                    detail: callbackInfo
                }));
                return { handled: true, type: 'magic' };
            }
        }

        return { handled: false };
    }

    // Export callback detection and processing
    window.ManifestAppwriteAuthCallbacks = {
        detect: detectCallback,
        process: processCallback,
        cleanupUrl
    };
}

// Initialize when config is available
if (window.ManifestAppwriteAuthConfig) {
    initializeCallbacks();
} else {
    document.addEventListener('DOMContentLoaded', () => {
        if (window.ManifestAppwriteAuthConfig) {
            initializeCallbacks();
        }
    });
}

