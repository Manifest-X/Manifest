/* Manifest Data Sources - Presence Realtime Subscription */

// Create realtime subscription callback
function createPresenceRealtimeCallback(
    channelId,
    userInfo,
    cursors,
    containerElement,
    isLocalUserEditing,
    currentEditing,
    onUserJoin,
    onUserLeave,
    onCursorUpdate
) {
    return (response) => {

        // Handle both array and single event formats (like in manifest.data.realtime.js)
        if (!response) {
            return;
        }

        // Check if events exist, handle both array and single event
        const events = response.events ?
            (Array.isArray(response.events) ? response.events : [response.events]) :
            [];

        if (events.length === 0) {
            return;
        }

        events.forEach(event => {
            if (typeof event !== 'string') {
                return;
            }

            const payload = response.payload || response;
            const userId = payload.userId || payload.$id;

            // Ignore our own updates
            if (!userId || userId === userInfo.id) {
                return;
            }

            if (event.includes('create') || event.includes('rows.create')) {
                handleUserJoin(event, payload, channelId, userId, cursors, containerElement, onUserJoin, onCursorUpdate);
            } else if (event.includes('update') || event.includes('rows.update')) {
                handleUserUpdate(event, payload, channelId, userId, cursors, containerElement, isLocalUserEditing, currentEditing, onCursorUpdate);
            } else if (event.includes('delete') || event.includes('rows.delete')) {
                handleUserLeave(event, userId, onUserLeave, onCursorUpdate, cursors);
            }
        });
    };
}

// Handle user join event
function handleUserJoin(event, payload, channelId, userId, cursors, containerElement, onUserJoin, onCursorUpdate) {
    // User joined
    if (payload.channelId === channelId) {
        // Parse JSON strings for focus/selection/editing
        let focus = null, selection = null, editing = null;
        try {
            focus = payload.focus ? (typeof payload.focus === 'string' ? JSON.parse(payload.focus) : payload.focus) : null;
            selection = payload.selection ? (typeof payload.selection === 'string' ? JSON.parse(payload.selection) : payload.selection) : null;
            editing = payload.editing ? (typeof payload.editing === 'string' ? JSON.parse(payload.editing) : payload.editing) : null;
        } catch (e) {
            console.warn('[Manifest Presence] Failed to parse presence data:', e);
        }

        const userColor = payload.color || getUserColor(userId);
        cursors.set(userId, {
            x: payload.x || 0,
            y: payload.y || 0,
            vx: payload.vx || 0, // Velocity X for interpolation
            vy: payload.vy || 0, // Velocity Y for interpolation
            name: payload.name || 'Anonymous',
            color: userColor,
            lastSeen: payload.lastSeen || Date.now(),
            lastUpdateTime: Date.now(), // Track when we received this update for interpolation
            focus: focus,
            selection: selection,
            editing: editing
        });

        // Apply visual indicators when user joins
        applyVisualIndicators(userId, focus, selection, editing, userColor, containerElement);

        if (onUserJoin) {
            onUserJoin({ userId, name: payload.name, color: userColor });
        }

        if (onCursorUpdate) {
            onCursorUpdate(Array.from(cursors.values()));
        }
    } else {
    }
}

// Handle user update event
function handleUserUpdate(event, payload, channelId, userId, cursors, containerElement, isLocalUserEditing, currentEditing, onCursorUpdate) {
    // Presence updated (cursor, focus, selection, editing)

    if (payload.channelId === channelId) {
        const existing = cursors.get(userId) || {};

        // Parse JSON strings for focus/selection/editing
        let focus = existing.focus, selection = existing.selection, editing = existing.editing;
        if (payload.focus !== undefined) {
            try {
                focus = payload.focus ? (typeof payload.focus === 'string' ? JSON.parse(payload.focus) : payload.focus) : null;

                // Add CSS class to element for customizable styling
                if (focus && focus.elementId) {
                    const targetElement = findElementById(focus.elementId, containerElement);
                    if (targetElement) {
                        targetElement.classList.add('presence-focused');
                        targetElement.setAttribute('data-presence-focus-user', userId);
                        targetElement.setAttribute('data-presence-focus-color', existing.color || getUserColor(userId));
                    }
                }
                // Remove focus class from elements that are no longer focused by this user
                if (!focus || !focus.elementId) {
                    document.querySelectorAll(`[data-presence-focus-user="${userId}"]`).forEach(el => {
                        el.classList.remove('presence-focused');
                        el.removeAttribute('data-presence-focus-user');
                        el.removeAttribute('data-presence-focus-color');
                    });
                }
            } catch (e) {
                console.warn('[Manifest Presence] Failed to parse focus:', e);
            }
        }
        if (payload.selection !== undefined) {
            try {
                selection = payload.selection ? (typeof payload.selection === 'string' ? JSON.parse(payload.selection) : payload.selection) : null;

                // Update selection indicator
                if (selection && selection.elementId) {
                    const targetElement = findElementById(selection.elementId, containerElement);
                    if (targetElement) {
                        // Store selection data for rendering
                        const start = selection.start !== undefined ? selection.start : (selection.startOffset || 0);
                        const end = selection.end !== undefined ? selection.end : (selection.endOffset || start);
                        targetElement.setAttribute('data-presence-selection-user', userId);
                        targetElement.setAttribute('data-presence-selection-start', start.toString());
                        targetElement.setAttribute('data-presence-selection-end', end.toString());
                        targetElement.setAttribute('data-presence-selection-color', existing.color || getUserColor(userId));
                        // Trigger custom event for selection rendering
                        targetElement.dispatchEvent(new CustomEvent('presence:selection', {
                            detail: { userId, selection: { start, end }, color: existing.color || getUserColor(userId) }
                        }));
                    }
                } else {
                    // Remove selection indicators
                    document.querySelectorAll(`[data-presence-selection-user="${userId}"]`).forEach(el => {
                        el.removeAttribute('data-presence-selection-user');
                        el.removeAttribute('data-presence-selection-start');
                        el.removeAttribute('data-presence-selection-end');
                        el.removeAttribute('data-presence-selection-color');
                        // Remove visual indicator
                        const indicator = el.querySelector('.presence-selection');
                        if (indicator) indicator.remove();
                    });
                }
            } catch (e) {
                console.warn('[Manifest Presence] Failed to parse selection:', e);
            }
        }
        if (payload.editing !== undefined) {
            try {
                editing = payload.editing ? (typeof payload.editing === 'string' ? JSON.parse(payload.editing) : payload.editing) : null;

                // Real-time text syncing: Update element if local user is not editing it
                if (editing && editing.elementId && editing.value !== undefined) {
                    // Check if local user is currently editing this element
                    const isLocalEditingThis = isLocalUserEditing.value &&
                        currentEditing.value &&
                        currentEditing.value.elementId === editing.elementId;

                    if (!isLocalEditingThis) {
                        // Local user is not editing this element - safe to sync
                        const targetElement = findElementById(editing.elementId, containerElement);
                        if (targetElement) {
                            // Check if element is currently being synced (to prevent conflicts)
                            if (!targetElement.hasAttribute('data-presence-syncing')) {
                                updateElementValue(targetElement, editing.value, editing.caretPosition);
                            }

                            // Add caret position indicator
                            if (editing.caretPosition !== null && editing.caretPosition !== undefined) {
                                targetElement.setAttribute('data-presence-caret-user', userId);
                                targetElement.setAttribute('data-presence-caret-position', editing.caretPosition);
                                targetElement.setAttribute('data-presence-caret-color', existing.color || getUserColor(userId));
                                // Trigger custom event for caret rendering
                                targetElement.dispatchEvent(new CustomEvent('presence:caret', {
                                    detail: { userId, caretPosition: editing.caretPosition, color: existing.color || getUserColor(userId) }
                                }));
                            }
                        } else {
                            console.warn('[Manifest Presence] Element not found for syncing:', editing.elementId);
                        }
                    }
                } else if (!editing || !editing.elementId) {
                    // Remove caret indicators when editing stops
                    document.querySelectorAll(`[data-presence-caret-user="${userId}"]`).forEach(el => {
                        el.removeAttribute('data-presence-caret-user');
                        el.removeAttribute('data-presence-caret-position');
                        el.removeAttribute('data-presence-caret-color');
                        // Remove visual indicator
                        const indicator = el.querySelector('.presence-caret');
                        if (indicator) indicator.remove();
                    });
                }
            } catch (e) {
                console.warn('[Manifest Presence] Failed to parse editing:', e);
            }
        }

        cursors.set(userId, {
            ...existing,
            x: payload.x !== undefined ? payload.x : existing.x || 0,
            y: payload.y !== undefined ? payload.y : existing.y || 0,
            vx: payload.vx !== undefined ? payload.vx : (existing.vx || 0), // Velocity X
            vy: payload.vy !== undefined ? payload.vy : (existing.vy || 0), // Velocity Y
            name: payload.name || existing.name || 'Anonymous',
            color: payload.color || existing.color || getUserColor(userId),
            lastSeen: payload.lastSeen || Date.now(),
            lastUpdateTime: Date.now(), // Track when we received this update for interpolation
            focus: focus,
            selection: selection,
            editing: editing
        });

        // Apply visual indicators for update events
        applyVisualIndicators(userId, focus, selection, editing, existing.color || getUserColor(userId), containerElement);

        if (onCursorUpdate) {
            onCursorUpdate(Array.from(cursors.values()));
        }
    } else {
    }
}

// Handle user leave event
function handleUserLeave(event, userId, onUserLeave, onCursorUpdate, cursors) {
    // User left - clean up all indicators
    document.querySelectorAll(`[data-presence-focus-user="${userId}"]`).forEach(el => {
        el.classList.remove('presence-focused');
        el.removeAttribute('data-presence-focus-user');
        el.removeAttribute('data-presence-focus-color');
    });
    document.querySelectorAll(`[data-presence-caret-user="${userId}"]`).forEach(el => {
        el.removeAttribute('data-presence-caret-user');
        el.removeAttribute('data-presence-caret-position');
        el.removeAttribute('data-presence-caret-color');
    });
    document.querySelectorAll(`[data-presence-selection-user="${userId}"]`).forEach(el => {
        el.removeAttribute('data-presence-selection-user');
        el.removeAttribute('data-presence-selection-start');
        el.removeAttribute('data-presence-selection-end');
        el.removeAttribute('data-presence-selection-color');
    });

    if (cursors.has(userId)) {
        cursors.delete(userId);

        if (onUserLeave) {
            onUserLeave({ userId });
        }

        if (onCursorUpdate) {
            onCursorUpdate(Array.from(cursors.values()));
        }
    }
}

// Setup realtime subscription
async function setupPresenceRealtimeSubscription(
    services,
    presenceChannel,
    channelId,
    userInfo,
    cursors,
    containerElement,
    isLocalUserEditing,
    currentEditing,
    onUserJoin,
    onUserLeave,
    onCursorUpdate
) {
    // Initialize unsubscribe as a no-op function in case subscription fails
    let unsubscribe = () => {
        console.warn('[Manifest Presence] Unsubscribe called but subscription was not successful');
    };

    try {
        // Verify we're using the same realtime service instance
        // Call subscribe with inline callback
        // Note: subscribe() returns a Promise that resolves when subscription is active
        const subscribeResult = services.realtime.subscribe(presenceChannel, (response) => {

            // Handle both array and single event formats (like in manifest.data.realtime.js)
            if (!response) {
                return;
            }

            // Check if events exist, handle both array and single event
            const events = response.events ?
                (Array.isArray(response.events) ? response.events : [response.events]) :
                [];

            if (events.length === 0) {
                return;
            }

            events.forEach(event => {
                if (typeof event !== 'string') {
                    return;
                }

                const payload = response.payload || response;
                const userId = payload.userId || payload.$id;

                // Ignore our own updates
                if (!userId || userId === userInfo.id) {
                    return;
                }

                if (event.includes('create') || event.includes('rows.create')) {
                    handleUserJoin(event, payload, channelId, userId, cursors, containerElement, onUserJoin, onCursorUpdate);
                } else if (event.includes('update') || event.includes('rows.update')) {
                    handleUserUpdate(event, payload, channelId, userId, cursors, containerElement, isLocalUserEditing, currentEditing, onCursorUpdate);
                } else if (event.includes('delete') || event.includes('rows.delete')) {
                    handleUserLeave(event, userId, onUserLeave, onCursorUpdate, cursors);
                }
            });
        });

        // Handle Promise resolution asynchronously (don't await - callback is already registered)
        // Match the pattern from working subscribeToTable which doesn't await
        if (subscribeResult && typeof subscribeResult.then === 'function') {
            // Callback is already registered synchronously, Promise is just for unsubscribe function
            subscribeResult.then((resolvedUnsubscribe) => {
                if (typeof resolvedUnsubscribe === 'function') {
                    unsubscribe = resolvedUnsubscribe;
                } else if (resolvedUnsubscribe && typeof resolvedUnsubscribe.close === 'function') {
                    unsubscribe = () => resolvedUnsubscribe.close();
                }
            }).catch((error) => {
            });
            // Set temporary unsubscribe that will be replaced when Promise resolves
            unsubscribe = () => {
                if (subscribeResult && typeof subscribeResult.then === 'function') {
                    subscribeResult.then((resolved) => {
                        if (resolved && typeof resolved.close === 'function') {
                            resolved.close();
                        } else if (typeof resolved === 'function') {
                            resolved();
                        }
                    });
                }
            };
        } else if (typeof subscribeResult === 'function') {
            unsubscribe = subscribeResult;
        } else if (subscribeResult && typeof subscribeResult.close === 'function') {
            unsubscribe = () => subscribeResult.close();
        }

        // Test: Log a message after a delay to verify subscription is still active
        setTimeout(() => {
        }, 5000);
        return unsubscribe;
    } catch (error) {
        console.error('[Manifest Presence] Failed to subscribe to presence:', error);
        return unsubscribe; // Return no-op function
    }
}
