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
