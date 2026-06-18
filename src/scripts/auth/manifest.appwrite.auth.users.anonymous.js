/* Auth anonymous */

// Add anonymous session methods to auth store
function initializeAnonymous() {
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
        if (store && !store._createAnonymousSession) {
            // Add anonymous session method to store (internal, used by store itself)
            store._createAnonymousSession = async function () {
                if (!this._appwrite) {
                    this._appwrite = await config.getAppwriteClient();
                }
                if (!this._appwrite) {
                    return { success: false, error: 'Appwrite not configured' };
                }

                // Check if guest sessions are enabled (auto or manual)
                if (!this._guestAuto && !this._guestManual) {
                    return { success: false, error: 'Guest sessions are not enabled' };
                }

                try {
                    const session = await this._appwrite.account.createAnonymousSession();
                    this.session = session;
                    this.user = await this._appwrite.account.get();
                    this.isAuthenticated = true;
                    this.isAnonymous = true;

                    // Seed default teams for the guest when auth.teams.guests is enabled
                    const appwriteConfig = await config.getAppwriteConfig();
                    if (appwriteConfig?.guestTeams && this._loadTeamsAndSeed) {
                        try {
                            await this._loadTeamsAndSeed(appwriteConfig);
                        } catch (teamsError) {
                            // Don't fail guest creation if teams fail to load, but surface why
                            console.warn('[Manifest Appwrite Auth] Failed to seed guest teams:', teamsError);
                        }
                    }

                    // Sync state to localStorage for cross-tab synchronization
                    if (this._syncStateToStorage) {
                        this._syncStateToStorage(this);
                    }

                    window.dispatchEvent(new CustomEvent('manifest:auth:anonymous', {
                        detail: { user: this.user }
                    }));

                    return { success: true, user: this.user };
                } catch (error) {
                    this.error = error.message;
                    this.isAuthenticated = false;
                    this.isAnonymous = false;
                    return { success: false, error: error.message };
                }
            };
        } else if (!store) {
            // Wait a bit more for store to initialize
            setTimeout(waitForStore, 50);
        }
    };

    // Start waiting after a short delay to ensure store is ready
    setTimeout(waitForStore, 100);
}

// Initialize when Alpine is ready
document.addEventListener('alpine:init', () => {
    try {
        initializeAnonymous();
    } catch (error) {
        // Failed to initialize anonymous
    }
});

// Export anonymous interface
window.ManifestAppwriteAuthAnonymous = {
    initialize: initializeAnonymous
};