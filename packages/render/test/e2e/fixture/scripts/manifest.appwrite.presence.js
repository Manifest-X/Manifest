/* Manifest Data Sources - Presence Utilities */

// Track active presence subscriptions
const presenceSubscriptions = new Map(); // Map<channelId, { unsubscribe, cursors, updateInterval }>

// Cursor position tracking per channel
const cursorPositions = new Map(); // Map<channelId, { x, y }>

// Generate a color for a user based on their ID
function getUserColor(userId) {
    if (!userId) return '#666';

    // Simple hash function to generate consistent color
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }

    // Generate a bright, saturated color
    const hue = Math.abs(hash) % 360;
    return `hsl(${hue}, 70%, 50%)`;
}

// Smooth cursor interpolation using velocity (dead reckoning)
// This allows smooth cursor rendering between updates without frequent server writes
// Based on techniques used by Figma, Google Docs, and other collaborative tools
function interpolateCursorPosition(lastKnown, velocity, elapsedMs) {
    if (!lastKnown || !velocity) {
        return lastKnown;
    }

    // Calculate predicted position based on velocity (dead reckoning)
    // Position = LastKnown + Velocity * Time
    const elapsedSeconds = elapsedMs / 1000;
    const predictedX = lastKnown.x + (velocity.vx || 0) * elapsedSeconds;
    const predictedY = lastKnown.y + (velocity.vy || 0) * elapsedSeconds;

    // Apply damping to velocity (gradually slow down if no new updates)
    // This prevents cursors from flying off screen if user stops moving
    const dampingFactor = Math.max(0, 1 - (elapsedMs / 2000)); // Full stop after 2 seconds
    const dampedVx = (velocity.vx || 0) * dampingFactor;
    const dampedVy = (velocity.vy || 0) * dampingFactor;

    return {
        x: predictedX,
        y: predictedY,
        vx: dampedVx,
        vy: dampedVy,
        interpolated: true // Flag to indicate this is interpolated, not actual position
    };
}

// Linear interpolation between two points (for rendering smooth paths)
function lerp(start, end, t) {
    // t should be between 0 and 1
    return start + (end - start) * t;
}

// Smooth interpolation with easing (ease-out for natural deceleration)
function smoothInterpolate(start, end, t) {
    // Ease-out cubic: t * (2 - t)
    const easedT = t * (2 - t);
    return lerp(start, end, easedT);
}

// Get user info from auth store
function getUserInfo() {
    if (typeof Alpine === 'undefined') return null;

    const authStore = Alpine.store('auth');
    if (!authStore || !authStore.user) return null;

    return {
        id: authStore.user.$id,
        name: authStore.user.name || authStore.user.email || 'Anonymous',
        email: authStore.user.email || null,
        color: getUserColor(authStore.user.$id)
    };
}

// Get Appwrite services
async function getAppwriteServices() {
    return await window.ManifestDataAppwrite._getAppwriteDataServices();
}

// Read CSS variable value (returns number in specified unit, or fallback)
function getCSSVariableValue(variableName, unit = 'ms', fallback = 0) {
    if (typeof document === 'undefined') return fallback;

    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(variableName)
        .trim();

    if (!value) return fallback;

    // Remove unit and parse as number
    const numValue = parseFloat(value);
    if (isNaN(numValue)) return fallback;

    // Convert to milliseconds if needed (for px values, return as-is)
    if (unit === 'ms' && value.endsWith('px')) {
        // For pixel values, return as-is (they're already in pixels)
        return numValue;
    } else if (unit === 'ms' && value.endsWith('ms')) {
        return numValue;
    } else if (unit === 'px' && value.endsWith('px')) {
        return numValue;
    }

    return numValue;
}

// Get presence configuration from manifest
async function getPresenceConfig() {
    try {
        const manifest = await window.ManifestDataConfig?.ensureManifest?.();
        return manifest?.data?.presence || {};
    } catch (error) {
        console.warn('[Manifest Presence] Failed to load manifest config:', error);
        return {};
    }
}


/* Manifest Data Sources - Presence Element Utilities */

// Generate a unique ID for an element if it doesn't have one
function getElementId(element, containerElement) {
    if (!element) return null;
    if (element.id) return element.id;
    if (element.dataset && element.dataset.presenceId) return element.dataset.presenceId;
    // Generate a stable ID based on element's position in DOM
    const path = [];
    let current = element;
    while (current && current !== containerElement && current !== document.body) {
        const parent = current.parentElement;
        if (parent) {
            const index = Array.from(parent.children).indexOf(current);
            path.unshift(`${current.tagName.toLowerCase()}:${index}`);
        }
        current = parent;
    }
    return path.join('>') || null;
}

// Helper function to find element by ID (supports id, data-presence-id, and DOM path)
function findElementById(elementId, containerElement) {
    if (!elementId) return null;
    // Try by ID first
    let targetElement = document.getElementById(elementId);
    if (targetElement && containerElement.contains(targetElement)) return targetElement;
    // Try by data-presence-id
    targetElement = document.querySelector(`[data-presence-id="${elementId}"]`);
    if (targetElement && containerElement.contains(targetElement)) return targetElement;
    // Try to find by DOM path (generated by getElementId)
    // IMPORTANT: getElementId counts ALL children, not filtered by tagName
    if (elementId.includes('>')) {
        const pathParts = elementId.split('>');
        let current = containerElement;
        for (const part of pathParts) {
            if (!current) break;
            const [tagName, indexStr] = part.split(':');
            const index = parseInt(indexStr, 10);
            if (isNaN(index)) break;
            // Count ALL children (not filtered), matching getElementId behavior
            const allChildren = Array.from(current.children);
            if (index >= 0 && index < allChildren.length) {
                const child = allChildren[index];
                // Verify tagName matches (safety check)
                if (child.tagName.toLowerCase() === tagName.toLowerCase()) {
                    current = child;
                } else {
                    console.warn(`[Presence Debug] TagName mismatch at path step "${part}": expected ${tagName}, got ${child.tagName.toLowerCase()}`);
                    current = null;
                    break;
                }
            } else {
                console.warn(`[Presence Debug] Index out of bounds at path step "${part}": index ${index}, children count ${allChildren.length}`);
                current = null;
                break;
            }
        }
        if (current && containerElement.contains(current)) return current;
    }
    return null;
}

// Helper function to apply visual indicators for a user's presence state
function applyVisualIndicators(userId, focus, selection, editing, userColor, containerElement) {
    const color = userColor || getUserColor(userId);

    // Apply focus indicator
    if (focus && focus.elementId) {
        const targetElement = findElementById(focus.elementId, containerElement);
        if (targetElement) {
            targetElement.classList.add('presence-focused');
            targetElement.setAttribute('data-presence-focus-user', userId);
            targetElement.setAttribute('data-presence-focus-color', color);
        } else {
        }
    }

    // Apply selection indicator
    if (selection && selection.elementId) {
        const targetElement = findElementById(selection.elementId, containerElement);
        if (targetElement) {
            const start = selection.start !== undefined ? selection.start : (selection.startOffset || 0);
            const end = selection.end !== undefined ? selection.end : (selection.endOffset || start);
            targetElement.setAttribute('data-presence-selection-user', userId);
            targetElement.setAttribute('data-presence-selection-start', start.toString());
            targetElement.setAttribute('data-presence-selection-end', end.toString());
            targetElement.setAttribute('data-presence-selection-color', color);
            // Trigger custom event for selection rendering
            targetElement.dispatchEvent(new CustomEvent('presence:selection', {
                detail: { userId, selection: { start, end }, color }
            }));
        }
    }

    // Apply caret indicator
    if (editing && editing.elementId && editing.caretPosition !== null && editing.caretPosition !== undefined) {
        const targetElement = findElementById(editing.elementId, containerElement);
        if (targetElement) {
            targetElement.setAttribute('data-presence-caret-user', userId);
            targetElement.setAttribute('data-presence-caret-position', editing.caretPosition.toString());
            targetElement.setAttribute('data-presence-caret-color', color);
            // Trigger custom event for caret rendering
            targetElement.dispatchEvent(new CustomEvent('presence:caret', {
                detail: { userId, caretPosition: editing.caretPosition, color }
            }));
        }
    }
}

// Helper function to update element value (agnostic for input/textarea/contenteditable)
function updateElementValue(targetElement, newValue, caretPosition) {
    if (!targetElement) return false;

    try {
        // Check if element is editable
        const isEditable = targetElement.tagName === 'INPUT' ||
            targetElement.tagName === 'TEXTAREA' ||
            targetElement.isContentEditable;

        if (!isEditable) return false;

        // Temporarily disable input event to prevent infinite loop
        const wasDisabled = targetElement.hasAttribute('data-presence-syncing');
        targetElement.setAttribute('data-presence-syncing', 'true');

        // Update value based on element type
        if (targetElement.tagName === 'INPUT' || targetElement.tagName === 'TEXTAREA') {
            const currentValue = targetElement.value || '';
            if (currentValue !== newValue) {
                targetElement.value = newValue;
                // Set caret position if provided
                if (caretPosition !== null && caretPosition !== undefined &&
                    targetElement.setSelectionRange) {
                    try {
                        targetElement.setSelectionRange(caretPosition, caretPosition);
                    } catch (e) {
                        // Some input types don't support setSelectionRange
                    }
                }
                // Trigger input event for reactivity (but mark it as synced)
                const inputEvent = new Event('input', { bubbles: true });
                targetElement.dispatchEvent(inputEvent);
            }
        } else if (targetElement.isContentEditable) {
            const currentValue = targetElement.textContent || '';
            if (currentValue !== newValue) {
                targetElement.textContent = newValue;
                // Try to set caret position for contenteditable
                if (caretPosition !== null && caretPosition !== undefined) {
                    try {
                        const range = document.createRange();
                        const selection = window.getSelection();
                        const textNode = targetElement.firstChild;
                        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                            const pos = Math.min(caretPosition, textNode.textContent.length);
                            range.setStart(textNode, pos);
                            range.setEnd(textNode, pos);
                            selection.removeAllRanges();
                            selection.addRange(range);
                        }
                    } catch (e) {
                        // Ignore caret positioning errors
                    }
                }
            }
        }

        // Remove sync flag after a short delay
        setTimeout(() => {
            targetElement.removeAttribute('data-presence-syncing');
        }, 50);

        return true;
    } catch (e) {
        console.warn('[Manifest Presence] Failed to update element value:', e);
        targetElement.removeAttribute('data-presence-syncing');
        return false;
    }
}


/* Manifest Data Sources - Presence Event Tracking */

// Create event handlers for presence tracking
function createPresenceEventHandlers(element, state, callbacks) {
    const {
        currentCursor,
        currentFocus,
        currentSelection,
        currentEditing,
        isLocalUserEditing,
        lastPosition,
        lastVelocity,
        lastActivityTime
    } = state;

    const {
        getElementId,
        updateCursorPosition
    } = callbacks;

    // Throttle mousemove to prevent performance issues
    let lastMouseMoveTime = 0;
    const mouseMoveThrottle = 16; // ~60fps max

    // Cursor position tracker with velocity calculation for smooth interpolation
    const handleMouseMove = (e) => {
        const now = Date.now();
        // Throttle mousemove events to prevent forced reflows
        if (now - lastMouseMoveTime < mouseMoveThrottle) {
            return;
        }
        lastMouseMoveTime = now;

        // Use requestAnimationFrame to batch DOM reads
        requestAnimationFrame(() => {
            const rect = element.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const now = Date.now();

            // Calculate velocity for smooth interpolation (pixels per second)
            const dt = (now - lastPosition.time) / 1000; // Convert to seconds
            if (dt > 0 && dt < 1) { // Only calculate if reasonable time difference
                lastVelocity.vx = (x - lastPosition.x) / dt;
                lastVelocity.vy = (y - lastPosition.y) / dt;
            }

            currentCursor.x = x;
            currentCursor.y = y;
            lastPosition.x = x;
            lastPosition.y = y;
            lastPosition.time = now;
            lastActivityTime.value = now; // Update activity timestamp
        });
    };

    const handleTouchMove = (e) => {
        if (e.touches.length > 0) {
            const rect = element.getBoundingClientRect();
            const x = e.touches[0].clientX - rect.left;
            const y = e.touches[0].clientY - rect.top;
            const now = Date.now();

            // Calculate velocity
            const dt = (now - lastPosition.time) / 1000;
            if (dt > 0 && dt < 1) {
                lastVelocity.vx = (x - lastPosition.x) / dt;
                lastVelocity.vy = (y - lastPosition.y) / dt;
            }

            currentCursor.x = x;
            currentCursor.y = y;
            lastPosition.x = x;
            lastPosition.y = y;
            lastPosition.time = now;
            lastActivityTime.value = now;
        }
    };

    // Focus tracking
    const handleFocus = (e) => {
        const target = e.target;
        if (target && element.contains(target)) {
            const elementId = getElementId(target, element);
            currentFocus.value = {
                elementId: elementId,
                elementType: target.type || target.tagName.toLowerCase(),
                tagName: target.tagName.toLowerCase(),
                placeholder: target.placeholder || null,
                name: target.name || null
            };
            lastActivityTime.value = Date.now(); // Update activity on focus
            // Trigger immediate update for focus changes (important for UX)
            updateCursorPosition(true); // Force immediate update
        }
    };

    const handleBlur = (e) => {
        currentFocus.value = null;
        currentEditing.value = null;
        currentSelection.value = null;
        isLocalUserEditing.value = false;
        // Trigger immediate update when focus is lost
        updateCursorPosition(true); // Force immediate update
    };

    // Text selection tracking
    const handleSelectionChange = () => {
        const selection = window.getSelection();
        if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
            const range = selection.getRangeAt(0);
            const target = range.commonAncestorContainer;
            const targetElement = target.nodeType === Node.TEXT_NODE ? target.parentElement : target;

            // Check if the selection is within our tracked element
            if (targetElement && element.contains && element.contains(targetElement)) {
                const elementId = getElementId(targetElement, element);
                if (elementId) {
                    const selectedText = selection.toString();
                    if (selectedText && selectedText.trim().length > 0) {
                        currentSelection.value = {
                            elementId: elementId,
                            start: range.startOffset,
                            end: range.endOffset,
                            text: selectedText.substring(0, 100) // Limit text length
                        };
                        lastActivityTime.value = Date.now(); // Update activity on selection
                    } else {
                        currentSelection.value = null;
                    }
                } else {
                    currentSelection.value = null;
                }
            } else {
                currentSelection.value = null;
            }
        } else {
            currentSelection.value = null;
        }
    };

    // Text editing tracking (for input/textarea/contenteditable)
    const handleInput = (e) => {
        const target = e.target;
        // Skip if this is a sync event (to prevent infinite loops)
        if (target && target.hasAttribute('data-presence-syncing')) {
            return;
        }

        if (target && element.contains(target)) {
            const elementId = getElementId(target, element);
            if (elementId && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                const selection = window.getSelection();
                let caretPosition = null;

                if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
                    caretPosition = target.selectionStart || 0;
                } else if (selection && selection.rangeCount > 0) {
                    const range = selection.getRangeAt(0);
                    caretPosition = range.startOffset;
                }

                currentEditing.value = {
                    elementId: elementId,
                    value: target.value || target.textContent || '',
                    caretPosition: caretPosition,
                    length: (target.value || target.textContent || '').length
                };
                isLocalUserEditing.value = true;
                lastActivityTime.value = Date.now(); // Update activity on input
            }
        }
    };

    // Set up event listeners
    element.addEventListener('mousemove', handleMouseMove);
    element.addEventListener('touchmove', handleTouchMove, { passive: true });
    element.addEventListener('focusin', handleFocus, true); // Use capture to catch all focus events
    element.addEventListener('focusout', handleBlur, true);
    element.addEventListener('selectionchange', handleSelectionChange);
    element.addEventListener('input', handleInput, true);
    element.addEventListener('keyup', handleInput, true); // Also track on keyup for caret position

    // Return cleanup function
    return () => {
        element.removeEventListener('mousemove', handleMouseMove);
        element.removeEventListener('touchmove', handleTouchMove);
        element.removeEventListener('focusin', handleFocus, true);
        element.removeEventListener('focusout', handleBlur, true);
        element.removeEventListener('selectionchange', handleSelectionChange);
        element.removeEventListener('input', handleInput, true);
        element.removeEventListener('keyup', handleInput, true);
    };
}


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


/* Manifest Data Sources - Presence Visual Rendering */

// Render caret position indicator (optional visual rendering)
function renderCaret(element, caretPosition, color) {
    if (!element) return;

    // Remove existing caret for this element
    const existing = element.querySelector('.presence-caret');
    if (existing) existing.remove();

    if (caretPosition === null || caretPosition === undefined) return;

    // Create caret indicator
    const caret = document.createElement('div');
    caret.className = 'presence-caret';
    if (color) {
        caret.style.setProperty('--presence-caret-color', color);
    }

    // Calculate caret position
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        // For input/textarea, measure text width
        const text = element.value.substring(0, caretPosition);
        const measure = document.createElement('span');
        measure.style.position = 'absolute';
        measure.style.visibility = 'hidden';
        measure.style.whiteSpace = 'pre';
        measure.style.font = window.getComputedStyle(element).font;
        measure.textContent = text;
        document.body.appendChild(measure);

        const textWidth = measure.offsetWidth;
        document.body.removeChild(measure);

        const rect = element.getBoundingClientRect();
        const paddingLeft = parseInt(window.getComputedStyle(element).paddingLeft) || 0;
        const borderLeft = parseInt(window.getComputedStyle(element).borderLeftWidth) || 0;

        caret.style.left = (textWidth + paddingLeft + borderLeft) + 'px';
        caret.style.top = (paddingLeft || 2) + 'px';
    } else if (element.isContentEditable) {
        // For contenteditable, use Range API
        try {
            const range = document.createRange();
            const textNode = element.firstChild;
            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                const pos = Math.min(caretPosition, textNode.textContent.length);
                range.setStart(textNode, pos);
                range.setEnd(textNode, pos);
                const rect = range.getBoundingClientRect();
                const parentRect = element.getBoundingClientRect();
                caret.style.left = (rect.left - parentRect.left) + 'px';
                caret.style.top = (rect.top - parentRect.top) + 'px';
            }
        } catch (e) {
            console.warn('[Manifest Presence] Failed to position caret:', e);
            return;
        }
    }

    element.style.position = 'relative';
    element.appendChild(caret);
}

// Render text selection highlight (optional visual rendering)
function renderSelection(element, start, end, color) {
    if (!element) return;

    // Remove existing selection for this element
    const existing = element.querySelector('.presence-selection');
    if (existing) existing.remove();

    if (start === null || end === null || start === end) return;

    const selection = document.createElement('div');
    selection.className = 'presence-selection';
    if (color) {
        selection.style.setProperty('--presence-selection-color', color);
    }

    // Calculate selection bounds
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        const text = element.value;
        const startText = text.substring(0, start);
        const selectedText = text.substring(start, end);

        // Measure start position
        const measureStart = document.createElement('span');
        measureStart.style.position = 'absolute';
        measureStart.style.visibility = 'hidden';
        measureStart.style.whiteSpace = 'pre';
        measureStart.style.font = window.getComputedStyle(element).font;
        measureStart.textContent = startText;
        document.body.appendChild(measureStart);

        // Measure selection width
        const measureSelected = document.createElement('span');
        measureSelected.style.position = 'absolute';
        measureSelected.style.visibility = 'hidden';
        measureSelected.style.whiteSpace = 'pre';
        measureSelected.style.font = window.getComputedStyle(element).font;
        measureSelected.textContent = selectedText;
        document.body.appendChild(measureSelected);

        const startWidth = measureStart.offsetWidth;
        const selectedWidth = measureSelected.offsetWidth;
        document.body.removeChild(measureStart);
        document.body.removeChild(measureSelected);

        const rect = element.getBoundingClientRect();
        const paddingLeft = parseInt(window.getComputedStyle(element).paddingLeft) || 0;
        const borderLeft = parseInt(window.getComputedStyle(element).borderLeftWidth) || 0;
        const lineHeight = parseInt(window.getComputedStyle(element).lineHeight) || 20;

        selection.style.left = (startWidth + paddingLeft + borderLeft) + 'px';
        selection.style.top = (paddingLeft || 2) + 'px';
        selection.style.width = selectedWidth + 'px';
        selection.style.height = lineHeight + 'px';
    } else if (element.isContentEditable) {
        // For contenteditable, use Range API
        try {
            const textNode = element.firstChild;
            if (textNode && textNode.nodeType === Node.TEXT_NODE) {
                const range = document.createRange();
                const textLength = textNode.textContent.length;
                const safeStart = Math.min(start, textLength);
                const safeEnd = Math.min(end, textLength);
                range.setStart(textNode, safeStart);
                range.setEnd(textNode, safeEnd);
                const rect = range.getBoundingClientRect();
                const parentRect = element.getBoundingClientRect();
                selection.style.left = (rect.left - parentRect.left) + 'px';
                selection.style.top = (rect.top - parentRect.top) + 'px';
                selection.style.width = rect.width + 'px';
                selection.style.height = rect.height + 'px';
            }
        } catch (e) {
            console.warn('[Manifest Presence] Failed to position selection:', e);
            return;
        }
    }

    element.style.position = 'relative';
    element.appendChild(selection);
}

// Initialize optional visual rendering (caret/selection indicators)
function initializeVisualRendering() {
    // Listen for presence events
    document.addEventListener('presence:caret', (e) => {
        const { userId, caretPosition, color } = e.detail;
        const element = e.target;
        if (element && caretPosition !== null && caretPosition !== undefined) {
            renderCaret(element, caretPosition, color);
        }
    });

    document.addEventListener('presence:selection', (e) => {
        const { userId, selection, color } = e.detail;
        const element = e.target;
        if (element && selection && selection.start !== undefined && selection.end !== undefined) {
            renderSelection(element, selection.start, selection.end, color);
        }
    });

    // Update caret/selection when attributes change
    const observer = new MutationObserver((mutations) => {
        mutations.forEach((mutation) => {
            if (mutation.type === 'attributes') {
                const element = mutation.target;
                const caretUser = element.getAttribute('data-presence-caret-user');
                const caretPos = element.getAttribute('data-presence-caret-position');
                const caretColor = element.getAttribute('data-presence-caret-color');

                if (caretUser && caretPos !== null) {
                    renderCaret(element, parseInt(caretPos), caretColor || null);
                }

                const selUser = element.getAttribute('data-presence-selection-user');
                const selStart = element.getAttribute('data-presence-selection-start');
                const selEnd = element.getAttribute('data-presence-selection-end');
                const selColor = element.getAttribute('data-presence-selection-color');

                if (selUser && selStart !== null && selEnd !== null) {
                    renderSelection(element, parseInt(selStart), parseInt(selEnd), selColor || null);
                }
            }
        });
    });

    // Observe all editable elements
    function initObserver() {
        const editableElements = document.querySelectorAll('input, textarea, [contenteditable="true"]');
        editableElements.forEach(el => {
            observer.observe(el, {
                attributes: true,
                attributeFilter: [
                    'data-presence-caret-user', 'data-presence-caret-position', 'data-presence-caret-color',
                    'data-presence-selection-user', 'data-presence-selection-start', 'data-presence-selection-end', 'data-presence-selection-color'
                ]
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initObserver);
    } else {
        initObserver();
    }
}


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
