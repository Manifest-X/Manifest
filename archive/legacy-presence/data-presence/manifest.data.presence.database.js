/* Manifest Data Sources - Presence Database Operations */

// Helper function to check if data has changed significantly
function hasSignificantChange(currentCursor, lastSentCursor, currentFocus, lastSentFocus, currentSelection, lastSentSelection, currentEditing, lastSentEditing, minChangeThreshold) {
    // Check cursor position change (minimum threshold)
    const cursorDeltaX = Math.abs(currentCursor.x - (lastSentCursor.x || 0));
    const cursorDeltaY = Math.abs(currentCursor.y - (lastSentCursor.y || 0));
    const cursorMoved = cursorDeltaX >= minChangeThreshold || cursorDeltaY >= minChangeThreshold;

    // Check if focus changed
    const focusChanged = JSON.stringify(currentFocus) !== JSON.stringify(lastSentFocus);

    // Check if selection changed
    const selectionChanged = JSON.stringify(currentSelection) !== JSON.stringify(lastSentSelection);

    // Check if editing changed (always send editing updates - they're important)
    const editingChanged = JSON.stringify(currentEditing) !== JSON.stringify(lastSentEditing);

    // Update if cursor moved significantly OR any state changed
    return cursorMoved || focusChanged || selectionChanged || editingChanged;
}

// Broadcast cursor position to database table
async function updateCursorPosition(
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
    forceImmediate = false
) {
    const now = Date.now();

    // Throttle broadcasts (unless forced)
    if (!forceImmediate && now - lastBroadcastTime.value < throttle) {
        return;
    }

    // Idle detection: Skip updates if user has been inactive
    const timeSinceActivity = now - lastActivityTime.value;
    if (timeSinceActivity > idleThreshold) {
        // User is idle - don't send updates (saves writes)
        return;
    }

    // Change detection: Only update if something actually changed
    if (!forceImmediate && !hasSignificantChange(
        currentCursor,
        lastSentCursor.value,
        currentFocus.value,
        lastSentFocus.value,
        currentSelection.value,
        lastSentSelection.value,
        currentEditing.value,
        lastSentEditing.value,
        minChangeThreshold
    ) && lastSentCursor.value.x !== null) {
        // Nothing significant changed - skip this update (saves writes)
        return;
    }

    lastBroadcastTime.value = now;

    try {
        // Create or update cursor position in database
        // Use userId as the unique identifier (upsert pattern)
        // Store focus/selection/editing as JSON strings (Appwrite doesn't have native JSON type)
        // Include velocity for client-side interpolation (optional, requires table schema)
        const presenceData = {
            userId: userInfo.id,
            channelId: channelId,
            x: currentCursor.x,
            y: currentCursor.y,
            name: userInfo.name,
            color: userInfo.color,
            lastSeen: now,
            focus: currentFocus.value ? JSON.stringify(currentFocus.value) : null,
            selection: currentSelection.value ? JSON.stringify(currentSelection.value) : null,
            editing: currentEditing.value ? JSON.stringify(currentEditing.value) : null
        };

        // Only include velocity if enabled and table schema supports it
        if (includeVelocity) {
            presenceData.vx = lastVelocity.vx; // Velocity X (pixels per second) for interpolation
            presenceData.vy = lastVelocity.vy; // Velocity Y (pixels per second) for interpolation
        }

        // Update last sent values for change detection
        lastSentCursor.value = { x: currentCursor.x, y: currentCursor.y };
        lastSentFocus.value = currentFocus.value ? JSON.parse(JSON.stringify(currentFocus.value)) : null;
        lastSentSelection.value = currentSelection.value ? JSON.parse(JSON.stringify(currentSelection.value)) : null;
        lastSentEditing.value = currentEditing.value ? JSON.parse(JSON.stringify(currentEditing.value)) : null;

        // Upsert logic: try update first, then create if not found
        try {
            // Try to update existing row first
            await services.tablesDB.updateRow({
                databaseId,
                tableId,
                rowId: userInfo.id,
                data: presenceData
            });
        } catch (updateError) {
            // If 404, row doesn't exist yet - create it
            // Check multiple error properties (Appwrite SDK may structure errors differently)
            const isNotFound = updateError?.code === 404 ||
                updateError?.response?.code === 404 ||
                updateError?.statusCode === 404 ||
                updateError?.message?.includes('404') ||
                updateError?.message?.includes('not found');

            if (isNotFound) {
                try {
                    await services.tablesDB.createRow({
                        databaseId,
                        tableId,
                        rowId: userInfo.id, // Use userId as row ID
                        data: presenceData
                    });
                } catch (createError) {
                    // If 409 (conflict), row was created between update and create - try update again
                    if (createError?.code === 409) {
                        try {
                            await services.tablesDB.updateRow({
                                databaseId,
                                tableId,
                                rowId: userInfo.id,
                                data: presenceData
                            });
                        } catch (retryError) {
                            // Suppress 401 errors (permission issues)
                            if (retryError?.code !== 401) {
                                console.error('[Manifest Presence] Failed to update cursor position after conflict:', retryError);
                            }
                            throw retryError;
                        }
                    } else if (createError?.code !== 401) {
                        // Suppress 401 errors (permission issues) - user needs to set table permissions
                        console.error('[Manifest Presence] Failed to create cursor position:', createError);
                        throw createError;
                    } else {
                        throw createError;
                    }
                }
            } else if (updateError?.code === 401) {
                // Permission issue - suppress repeated logs
                throw updateError;
            } else {
                // Other error - suppress 404 errors (they're handled by creating the row)
                const isNotFoundError = updateError?.code === 404 ||
                    updateError?.response?.code === 404 ||
                    updateError?.statusCode === 404 ||
                    updateError?.message?.includes('404') ||
                    updateError?.message?.includes('not found');
                if (!isNotFoundError && updateError?.code !== 401) {
                    console.error('[Manifest Presence] Failed to update cursor position:', updateError);
                }
                // Don't rethrow 404 errors - they're expected and handled
                if (!isNotFoundError) {
                    throw updateError;
                }
            }
        }
    } catch (error) {
        // Suppress 401 and 404 errors (permission issues and expected not-found during initial creation)
        const isNotFoundError = error?.code === 404 ||
            error?.response?.code === 404 ||
            error?.statusCode === 404 ||
            error?.message?.includes('404') ||
            error?.message?.includes('not found');
        if (error?.code !== 401 && !isNotFoundError) {
            console.error('[Manifest Presence] Failed to update cursor position:', error);
        }
    }
}

// Load initial cursor positions from database
async function loadInitialCursors(services, databaseId, tableId, channelId, userInfo, cursors, includeVelocity, applyVisualIndicators, containerElement, onCursorUpdate) {
    try {
        const allCursors = await services.tablesDB.listRows({
            databaseId,
            tableId,
            queries: [
                window.Appwrite.Query.equal('channelId', channelId)
            ]
        });

        if (allCursors && allCursors.rows) {
            allCursors.rows.forEach(row => {
                if (row.userId && row.userId !== userInfo.id) {
                    // Parse JSON strings for focus/selection/editing
                    let focus = null, selection = null, editing = null;
                    try {
                        focus = row.focus ? (typeof row.focus === 'string' ? JSON.parse(row.focus) : row.focus) : null;
                        selection = row.selection ? (typeof row.selection === 'string' ? JSON.parse(row.selection) : row.selection) : null;
                        editing = row.editing ? (typeof row.editing === 'string' ? JSON.parse(row.editing) : row.editing) : null;
                    } catch (e) {
                        console.warn('[Manifest Presence] Failed to parse presence data from row:', e);
                    }

                    const userColor = row.color || getUserColor(row.userId);
                    cursors.set(row.userId, {
                        x: row.x || 0,
                        y: row.y || 0,
                        vx: (includeVelocity && row.vx !== undefined) ? row.vx : 0, // Velocity X for interpolation (optional)
                        vy: (includeVelocity && row.vy !== undefined) ? row.vy : 0, // Velocity Y for interpolation (optional)
                        name: row.name || 'Anonymous',
                        color: userColor,
                        lastSeen: row.lastSeen || Date.now(),
                        lastUpdateTime: Date.now(), // Track when we loaded this for interpolation
                        focus: focus,
                        selection: selection,
                        editing: editing
                    });

                    // Apply visual indicators for initial load
                    applyVisualIndicators(row.userId, focus, selection, editing, userColor, containerElement);
                }
            });


            // Trigger callback after loading initial cursors
            if (onCursorUpdate) {
                const cursorArray = Array.from(cursors.values());
                onCursorUpdate(cursorArray);
            }
        }
    } catch (error) {
        // Suppress 401 errors (permission issues) - user needs to set table permissions
        if (error?.code !== 401) {
            console.warn('[Manifest Presence] Failed to load initial cursors:', error);
        }
    }
}
