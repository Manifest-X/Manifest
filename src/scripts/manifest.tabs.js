/* Manifest Tabs */

// Simple tabs plugin that acts as a proxy for Alpine's native functionality
function initializeTabsPlugin() {
    // Process all tab elements
    function processTabs() {
        // Find all x-tab elements
        const tabButtons = document.querySelectorAll('[x-tab]');
        const tabPanels = document.querySelectorAll('[x-tabpanel]');

        if (tabButtons.length === 0 && tabPanels.length === 0) {
            return;
        }

        // Group panels by their x-tabpanel value
        const panelGroups = {};
        tabPanels.forEach(panel => {
            const panelSet = panel.getAttribute('x-tabpanel') || '';
            // Get identifier - prefer ID, fallback to first class name
            const panelId = panel.id || (panel.className ? panel.className.split(' ')[0] : null);
            if (panelId) {
                if (!panelGroups[panelSet]) panelGroups[panelSet] = [];
                // Store both the element and its identifier (could be ID or class name)
                panelGroups[panelSet].push({
                    element: panel,
                    id: panelId,
                    isId: !!panel.id // Track if it's an ID or class name
                });
            }
        });

        // Process each panel group
        Object.entries(panelGroups).forEach(([panelSet, panels]) => {
            // Sanitize property name: replace hyphens and other invalid JS identifier chars with underscores
            // This ensures property names like "group-a" become "group_a" which is valid JavaScript
            const sanitizedPanelSet = panelSet ? panelSet.replace(/[^a-zA-Z0-9_$]/g, '_') : '';
            const tabProp = sanitizedPanelSet ? `tab_${sanitizedPanelSet}` : 'tab';

            // Find buttons that target this panel group
            const relevantButtons = Array.from(tabButtons).filter(button => {
                const tabValue = button.getAttribute('x-tab');
                if (!tabValue) return false;
                return panels.some(panel => {
                    if (panel.id === tabValue) return true;
                    if (panel.element.id === tabValue) return true;
                    const classList = panel.element.className.split(' ').filter(c => c.trim());
                    return classList.includes(tabValue);
                });
            });

            // Find the common parent - look for closest common ancestor of panels and buttons
            let commonParent = document.body;
            if (panels.length > 0) {
                // Start with first panel's parent
                commonParent = panels[0].element.parentElement || document.body;

                // Find the closest common ancestor that contains all panels and buttons
                const allElements = [...panels.map(p => p.element), ...relevantButtons];
                let currentParent = commonParent;

                while (currentParent && currentParent !== document.body) {
                    const containsAll = allElements.every(el => currentParent.contains(el));
                    if (containsAll) {
                        commonParent = currentParent;
                        break;
                    }
                    currentParent = currentParent.parentElement;
                }

                // Prefer an element with x-data if it contains everything
                const xDataParent = commonParent.closest('[x-data]');
                if (xDataParent && allElements.every(el => xDataParent.contains(el))) {
                    commonParent = xDataParent;
                }
            }

            // Ensure x-data exists
            if (!commonParent.hasAttribute('x-data')) {
                commonParent.setAttribute('x-data', '{}');
            }

            // Set up x-data with default value
            const existingXData = commonParent.getAttribute('x-data') || '{}';
            let newXData = existingXData;

            // Check if the tab property already exists
            // Escape special regex characters in tabProp
            const escapedTabProp = tabProp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const propertyRegex = new RegExp(`${escapedTabProp}\\s*:\\s*'[^']*'`, 'g');
            if (!propertyRegex.test(newXData)) {
                // Add the tab property with default value (first panel's id)
                const defaultValue = panels.length > 0 ? panels[0].id : 'a';
                const tabProperty = `${tabProp}: '${defaultValue}'`;

                if (newXData === '{}') {
                    newXData = `{ ${tabProperty} }`;
                } else {
                    const lastBraceIndex = newXData.lastIndexOf('}');
                    if (lastBraceIndex > 0) {
                        const beforeBrace = newXData.substring(0, lastBraceIndex);
                        const afterBrace = newXData.substring(lastBraceIndex);
                        const separator = beforeBrace.trim().endsWith(',') ? '' : ', ';
                        newXData = beforeBrace + separator + tabProperty + afterBrace;
                    }
                }

                if (newXData !== existingXData) {
                    commonParent.setAttribute('x-data', newXData);
                }
            }

            // ----- Accessibility wiring (WAI-ARIA Tabs pattern) -----
            //
            // Per the ARIA APG, a tabs widget needs:
            //   - role="tablist" on the tab container (parent of buttons)
            //   - role="tab" + aria-selected + aria-controls + tabindex on each button
            //   - role="tabpanel" + aria-labelledby + tabindex="0" on each panel
            //   - arrow-key navigation between tabs (with roving tabindex)
            //
            // We compute the tab-container element as the closest common ancestor of
            // the relevant buttons (often a <nav> or <div>). Each button is assigned
            // a stable id if it doesn't have one, so panels can reference it.

            // Assign ids where missing.
            const buttonIdByTabValue = {};
            relevantButtons.forEach((button, i) => {
                const tabValue = button.getAttribute('x-tab');
                if (!tabValue) return;
                if (!button.id) {
                    button.id = `mnfst-tab-${sanitizedPanelSet || 'g'}-${tabValue.replace(/[^a-zA-Z0-9_-]/g, '-')}-${i}`;
                }
                buttonIdByTabValue[tabValue] = button.id;
            });

            // Process panels for this group - add x-show + a11y attributes
            panels.forEach(panel => {
                // Create condition that checks if tab property matches this panel's identifier
                const showCondition = `${tabProp} === '${panel.id}'`;
                panel.element.setAttribute('x-show', showCondition);

                // Ensure panel has an id (Alpine needs one for aria-labelledby on buttons)
                if (!panel.element.id) panel.element.id = panel.id;

                // ARIA: role + label + focusable
                panel.element.setAttribute('role', 'tabpanel');
                if (!panel.element.hasAttribute('tabindex')) {
                    panel.element.setAttribute('tabindex', '0');
                }
                const labelledBy = buttonIdByTabValue[panel.id];
                if (labelledBy) panel.element.setAttribute('aria-labelledby', labelledBy);

                // Remove x-tabpanel attribute since we've converted it
                panel.element.removeAttribute('x-tabpanel');
            });

            // Process tab buttons for this panel set (use the filtered list)
            relevantButtons.forEach(button => {
                const tabValue = button.getAttribute('x-tab');
                if (!tabValue) return;

                // Set up click handler - use bracket notation if property name contains invalid chars
                // But since we sanitized tabProp, we can use dot notation
                const clickHandler = `${tabProp} = '${tabValue}'`;
                button.setAttribute('x-on:click', clickHandler);

                // ARIA: role, selection state (reactive via :aria-selected), controls
                button.setAttribute('role', 'tab');
                button.setAttribute(':aria-selected', `String(${tabProp} === '${tabValue}')`);
                // Roving tabindex: -1 when not active so arrow keys, not Tab, move between tabs.
                button.setAttribute(':tabindex', `${tabProp} === '${tabValue}' ? '0' : '-1'`);
                const panel = panels.find((p) => p.id === tabValue);
                if (panel && panel.element.id) {
                    button.setAttribute('aria-controls', panel.element.id);
                }

                // Remove x-tab attribute since we've converted it
                button.removeAttribute('x-tab');
            });

            // Find the tablist container — closest common ancestor of all relevant
            // buttons. If they share a direct parent that's the tablist; otherwise
            // walk up until one wraps them all. Set role="tablist" + a keydown
            // handler that walks the focusable tabs on Left/Right/Home/End.
            if (relevantButtons.length > 0) {
                let tablistEl = relevantButtons[0].parentElement;
                while (tablistEl && tablistEl !== document.body) {
                    if (relevantButtons.every((b) => tablistEl.contains(b))) break;
                    tablistEl = tablistEl.parentElement;
                }
                if (tablistEl) {
                    tablistEl.setAttribute('role', 'tablist');
                    if (!tablistEl.__mnfstTabsKeydown) {
                        tablistEl.__mnfstTabsKeydown = (e) => {
                            const target = e.target;
                            if (!target || target.getAttribute('role') !== 'tab') return;
                            const tabs = Array.from(tablistEl.querySelectorAll('[role="tab"]'));
                            const idx = tabs.indexOf(target);
                            if (idx === -1) return;
                            let nextIdx = null;
                            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (idx + 1) % tabs.length;
                            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (idx - 1 + tabs.length) % tabs.length;
                            else if (e.key === 'Home') nextIdx = 0;
                            else if (e.key === 'End') nextIdx = tabs.length - 1;
                            if (nextIdx == null) return;
                            e.preventDefault();
                            // Automatic activation: focusing a tab selects it. This matches
                            // the most common APG variant and Manifest's existing click-to-
                            // activate semantics.
                            tabs[nextIdx].focus();
                            tabs[nextIdx].click();
                        };
                        tablistEl.addEventListener('keydown', tablistEl.__mnfstTabsKeydown);
                    }
                }
            }

            // Ensure Alpine processes the updated x-data and x-show attributes
            if (window.Alpine && typeof window.Alpine.initTree === 'function') {
                // If the parent already has Alpine initialized, we need to update it
                if (commonParent.__x) {
                    // Update the x-data by destroying and re-initializing
                    // This ensures the new tab property is available
                    try {
                        window.Alpine.destroyTree(commonParent);
                    } catch (e) {
                        // Ignore errors if destroy fails
                    }
                }

                // Initialize Alpine on the common parent
                // This will process all x-show and x-on:click attributes we just added
                try {
                    window.Alpine.initTree(commonParent);
                } catch (e) {
                }
            }
        });
    }

    // Function to process tabs when Alpine is ready
    const processTabsWhenReady = () => {
        // Wait for Alpine to be available
        if (!window.Alpine || typeof window.Alpine.initTree !== 'function') {
            setTimeout(processTabsWhenReady, 50);
            return;
        }
        processTabs();
    };

    // Debounce function to avoid processing too frequently
    let processTimeout = null;
    const debouncedProcessTabs = () => {
        if (processTimeout) clearTimeout(processTimeout);
        processTimeout = setTimeout(processTabsWhenReady, 150);
    };

    // Wait for components to be ready first
    document.addEventListener('manifest:components-ready', () => {
        debouncedProcessTabs();
    });

    // Also listen for components-processed event
    document.addEventListener('manifest:components-processed', () => {
        debouncedProcessTabs();
    });

    // Also run on DOMContentLoaded as a fallback for non-component pages
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            debouncedProcessTabs();
        });
    } else {
        // DOM already loaded
        debouncedProcessTabs();
    }

    // Listen for Alpine initialization
    document.addEventListener('alpine:init', () => {
        debouncedProcessTabs();
    });

    // Watch for dynamically added tab elements (e.g., from markdown or components)
    const setupObserver = () => {
        if (!document.body) {
            // Body doesn't exist yet, wait for it
            setTimeout(setupObserver, 50);
            return;
        }

        const observer = new MutationObserver((mutations) => {
            let shouldProcess = false;
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // Element node
                        // Check if the added node or its children contain tabs
                        if (node.hasAttribute && (node.hasAttribute('x-tab') || node.hasAttribute('x-tabpanel'))) {
                            shouldProcess = true;
                        } else if (node.querySelectorAll) {
                            const hasTabs = node.querySelectorAll('[x-tab], [x-tabpanel]').length > 0;
                            if (hasTabs) {
                                shouldProcess = true;
                            }
                        }
                    }
                });
            });
            if (shouldProcess) {
                debouncedProcessTabs();
            }
        });

        // Start observing the document for changes
        try {
            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        } catch (e) {
            console.warn('[Manifest Tabs] Failed to setup MutationObserver:', e);
        }
    };

    // Setup observer when body is available
    if (document.body) {
        setupObserver();
    } else {
        // Wait for body to be available
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupObserver);
        } else {
            setTimeout(setupObserver, 50);
        }
    }

    // Add a fallback timer to catch cases where events don't fire
    setTimeout(() => {
        processTabsWhenReady();
    }, 2000);
}

// Track initialization to prevent duplicates
let tabsPluginInitialized = false;

function ensureTabsPluginInitialized() {
    if (tabsPluginInitialized) return;
    tabsPluginInitialized = true;
    initializeTabsPlugin();
}

// Expose on window for loader to call if needed
window.ensureTabsPluginInitialized = ensureTabsPluginInitialized;

// Initialize immediately (tabs doesn't require Alpine)
ensureTabsPluginInitialized();