/* Manifest Data Sources - Presence Main Subscription */

// Subscribe to presence channel for cursor tracking
// Uses a database table to store cursor positions (Appwrite Realtime is read-only)
async function subscribeToPresence(channelId, options = {}) {
    // Get configuration from manifest (if available)
    const manifestConfig = await getPresenceConfig();

    // Read CSS variables for timing/threshold values (with fallbacks)
    const cssThrottle = getCSSVariableValue('--presence-throttle', 300);
    const cssCleanupInterval = getCSSVariableValue('--presence-cleanup-interval', 30000);
    const cssMinChangeThreshold = getCSSVariableValue('--presence-min-change-threshold', 5);
    const cssIdleThreshold = getCSSVariableValue('--presence-idle-threshold', 5000);

    // Merge defaults: options > manifest > CSS variables > hardcoded defaults
    const finalOptions = {
        element: options.element ?? document.body,
        databaseId: options.databaseId ?? manifestConfig.appwriteDatabaseId ?? null,
        tableId: options.tableId ?? manifestConfig.appwriteTableId ?? 'presence',
        onCursorUpdate: options.onCursorUpdate ?? null,
        onUserJoin: options.onUserJoin ?? null,
        onUserLeave: options.onUserLeave ?? null,
        throttle: options.throttle ?? manifestConfig.throttle ?? cssThrottle,
        cleanupInterval: options.cleanupInterval ?? manifestConfig.cleanupInterval ?? cssCleanupInterval,
        minChangeThreshold: options.minChangeThreshold ?? manifestConfig.minChangeThreshold ?? cssMinChangeThreshold,
        idleThreshold: options.idleThreshold ?? manifestConfig.idleThreshold ?? cssIdleThreshold,
        enableVisualRendering: options.enableVisualRendering ?? manifestConfig.enableVisualRendering ?? true,
        includeVelocity: options.includeVelocity ?? manifestConfig.includeVelocity ?? false
    };

    const {
        element,
        databaseId,
        tableId,
        onCursorUpdate,
        onUserJoin,
        onUserLeave,
        throttle,
        cleanupInterval,
        minChangeThreshold,
        idleThreshold,
        enableVisualRendering,
        includeVelocity
    } = finalOptions;

    // Unsubscribe from existing subscription if any
    if (presenceSubscriptions.has(channelId)) {
        const existing = presenceSubscriptions.get(channelId);
        if (existing.unsubscribe) {
            existing.unsubscribe();
        }
        if (existing.updateInterval) {
            clearInterval(existing.updateInterval);
        }
        if (existing.cleanupInterval) {
            clearInterval(existing.cleanupInterval);
        }
        if (existing.cursorTracker && existing.cursorTracker.cleanup) {
            existing.cursorTracker.cleanup();
        }
        presenceSubscriptions.delete(channelId);
    }

    const services = await getAppwriteServices();
    if (!services?.tablesDB || !services?.realtime) {
        console.warn('[Manifest Presence] Appwrite services not available');
        return null;
    }

    if (!databaseId) {
        console.error('[Manifest Presence] databaseId is required');
        return null;
    }

    const userInfo = getUserInfo();
    if (!userInfo) {
        console.warn('[Manifest Presence] User not authenticated');
        return null;
    }

    // Track cursors for other users
    const cursors = new Map(); // Map<userId, { x, y, name, color, lastSeen }>

    // Current presence state for this user (wrapped in objects for reference passing)
    const currentCursor = { x: 0, y: 0 };
    const currentFocus = { value: null }; // { elementId, elementType, tagName }
    const currentSelection = { value: null }; // { start, end, text }
    const currentEditing = { value: null }; // { elementId, value, caretPosition }
    const isLocalUserEditing = { value: false }; // Track if local user is actively editing
    const lastBroadcastTime = { value: 0 };

    // Optimization: Track last sent position and state for change detection
    const lastSentCursor = { value: { x: null, y: null } };
    const lastSentFocus = { value: null };
    const lastSentSelection = { value: null };
    const lastSentEditing = { value: null };
    const lastActivityTime = { value: Date.now() }; // Track user activity for idle detection
    const lastVelocity = { vx: 0, vy: 0 }; // Velocity for smooth interpolation (future use)
    const lastPosition = { x: 0, y: 0, time: Date.now() }; // For velocity calculation

    // Create updateCursorPosition wrapper that uses the state objects
    const updateCursorPositionWrapper = (forceImmediate = false) => {
        return updateCursorPosition(
            services,
            databaseId,
            tableId,
            channelId,
            userInfo,
            currentCursor,
            currentFocus,
            currentSelection,
            currentEditing,
            lastVelocity,
            includeVelocity,
            lastBroadcastTime,
            lastActivityTime,
            throttle,
            idleThreshold,
            minChangeThreshold,
            lastSentCursor,
            lastSentFocus,
            lastSentSelection,
            lastSentEditing,
            forceImmediate
        );
    };

    // Create event handlers
    const eventHandlersState = {
        currentCursor,
        currentFocus,
        currentSelection,
        currentEditing,
        isLocalUserEditing,
        lastPosition,
        lastVelocity,
        lastActivityTime
    };

    const eventHandlersCallbacks = {
        getElementId: (el) => getElementId(el, element),
        updateCursorPosition: updateCursorPositionWrapper
    };

    const cleanupEventHandlers = createPresenceEventHandlers(element, eventHandlersState, eventHandlersCallbacks);

    // Update cursor position periodically
    const updateInterval = setInterval(updateCursorPositionWrapper, throttle);

    // Subscribe to real-time updates from the presence table
    const presenceChannel = `databases.${databaseId}.tables.${tableId}.rows`;

    // Setup realtime subscription
    const unsubscribe = await setupPresenceRealtimeSubscription(
        services,
        presenceChannel,
        channelId,
        userInfo,
        cursors,
        element,
        isLocalUserEditing,
        currentEditing,
        onUserJoin,
        onUserLeave,
        onCursorUpdate
    );

    // Load initial cursor positions from database
    await loadInitialCursors(
        services,
        databaseId,
        tableId,
        channelId,
        userInfo,
        cursors,
        includeVelocity,
        applyVisualIndicators,
        element,
        onCursorUpdate
    );

    // Ensure initial cursors trigger callback even if load failed
    if (onCursorUpdate && cursors.size > 0) {
        onCursorUpdate(Array.from(cursors.values()));
    }

    // Clean up stale cursors (users who haven't updated in a while)
    const cleanupIntervalId = setInterval(() => {
        const now = Date.now();
        let hasChanges = false;

        cursors.forEach((cursor, userId) => {
            if (now - cursor.lastSeen > cleanupInterval) {
                cursors.delete(userId);
                hasChanges = true;

                if (onUserLeave) {
                    onUserLeave({ userId });
                }
            }
        });

        if (hasChanges && onCursorUpdate) {
            onCursorUpdate(Array.from(cursors.values()));
        }
    }, cleanupInterval);

    // Cleanup function
    const cleanup = () => {
        cleanupEventHandlers();
        clearInterval(updateInterval);
        clearInterval(cleanupIntervalId);

        // Remove our presence from database on cleanup
        try {
            services.tablesDB.deleteRow({
                databaseId,
                tableId,
                rowId: userInfo.id
            });
        } catch (error) {
            console.warn('[Manifest Presence] Failed to remove presence on cleanup:', error);
        }
    };

    // Store subscription info
    presenceSubscriptions.set(channelId, {
        unsubscribe,
        cursorTracker: { cleanup },
        cursors,
        element,
        userInfo,
        updateInterval,
        cleanupInterval: cleanupIntervalId
    });

    return {
        unsubscribe: () => {
            cleanup();
            // Only call unsubscribe if it's actually a function
            if (typeof unsubscribe === 'function') {
                try {
                    unsubscribe();
                } catch (error) {
                    console.warn('[Manifest Presence] Error during unsubscribe:', error);
                }
            }
            presenceSubscriptions.delete(channelId);
        },
        cursors, // Expose cursors map for rendering
        userInfo
    };
}

// Unsubscribe from presence channel
function unsubscribeFromPresence(channelId) {
    if (presenceSubscriptions.has(channelId)) {
        const subscription = presenceSubscriptions.get(channelId);
        if (subscription.unsubscribe) {
            subscription.unsubscribe();
        }
        if (subscription.cursorTracker && subscription.cursorTracker.cleanup) {
            subscription.cursorTracker.cleanup();
        }
        presenceSubscriptions.delete(channelId);
    }
}

// Unsubscribe from all presence channels
function unsubscribeAllPresence() {
    presenceSubscriptions.forEach((subscription, channelId) => {
        if (subscription.unsubscribe) {
            subscription.unsubscribe();
        }
        if (subscription.cursorTracker && subscription.cursorTracker.cleanup) {
            subscription.cursorTracker.cleanup();
        }
    });
    presenceSubscriptions.clear();
}

// Initialize visual rendering on plugin load (if DOM is ready)
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            initializeVisualRendering();
        });
    } else {
        initializeVisualRendering();
    }
}

// Export functions
window.ManifestDataPresence = {
    subscribeToPresence,
    unsubscribeFromPresence,
    unsubscribeAllPresence,
    getUserColor,
    getUserInfo,
    interpolateCursorPosition, // Export for UI rendering
    lerp, // Export for UI rendering
    smoothInterpolate, // Export for UI rendering
    renderCaret, // Export for manual caret rendering
    renderSelection, // Export for manual selection rendering
    initializeVisualRendering, // Export for manual initialization
    presenceSubscriptions // Expose for debugging
};
