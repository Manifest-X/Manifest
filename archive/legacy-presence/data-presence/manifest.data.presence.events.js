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
