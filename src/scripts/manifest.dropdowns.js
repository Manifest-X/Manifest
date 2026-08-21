/* Manifest Dropdowns */

(function () {


// Most recent input modality, so we only move focus into a menu for keyboard opens.
// Capture-phase so no handler can stop it first.
let lastInputModality = 'mouse';
// Also the last pressed node: the router claims internal link clicks with
// stopImmediatePropagation, so pointerdown is our only view of which row a
// navigating item came from.
let lastPointerTarget = null;
document.addEventListener('keydown', () => { lastInputModality = 'keyboard'; }, true);
document.addEventListener('pointerdown', (e) => { lastInputModality = 'mouse'; lastPointerTarget = e.target; }, true);

function initializeDropdownPlugin() {
    // Ensure an Alpine context exists. Keep the scope empty — seeding properties
    // collides with author state and the tabs plugin's `tab` property.
    function ensureAlpineContext() {
        const body = document.body;
        if (!body.hasAttribute('x-data')) {
            body.setAttribute('x-data', '{}');
        }
    }

    // Helper to register directives
    function registerDirective(name, handler) {
        Alpine.directive(name, handler);
    }

    // Check if a menu element is nested (triggered from within another menu)
    const isNestedMenu = (menu) => {
        // Find all buttons/elements that target this menu
        const menuId = menu.id;
        const triggers = document.querySelectorAll(`[popovertarget="${menuId}"], [x-dropdown="${menuId}"], [x-dropdown*="${menuId}"]`);

        // Check if any trigger is inside another popover menu
        for (const trigger of triggers) {
            let parent = trigger.parentElement;
            while (parent) {
                if (parent.tagName === 'MENU' && parent.hasAttribute('popover')) {
                    return true;
                }
                parent = parent.parentElement;
            }
        }
        return false;
    };

    // Ensure Alpine.js context exists
    ensureAlpineContext();

    // Register dropdown directive
    registerDirective('dropdown', (el, { modifiers, expression }, { effect, evaluateLater }) => {
        let menu;

        // Shared hover state for all dropdown types
        let hoverTimeout;
        let autoCloseTimeout;
        let startAutoCloseTimer;

        effect(() => {

            // Defer processing to ensure Alpine is fully ready
            setTimeout(() => {
                if (!window.Alpine) {
                    console.warn('[Manifest] Alpine not available for dropdown processing');
                    return;
                }

                // Generate a unique anchor code for positioning
                const anchorCode = Math.random().toString(36).substr(2, 9);

                // Evaluate the expression to get the actual menu ID
                let dropdownId;
                if (expression) {
                    // Check if expression contains template literals or is a static string
                    if (expression.includes('${') || expression.includes('`')) {
                        // Use evaluateLater for dynamic expressions
                        const evaluator = evaluateLater(expression);
                        evaluator(value => {
                            dropdownId = value;
                        });
                    } else {
                        // Static string - use as-is
                        dropdownId = expression;
                    }
                } else {
                    dropdownId = `dropdown-${anchorCode}`;
                }

                // Check if expression refers to a template ID
                if (dropdownId && document.getElementById(dropdownId)?.tagName === 'TEMPLATE') {
                    // Clone template content and generate unique ID
                    const template = document.getElementById(dropdownId);
                    menu = template.content.cloneNode(true).firstElementChild;
                    const uniqueDropdownId = `dropdown-${anchorCode}`;
                    menu.setAttribute('id', uniqueDropdownId);
                    document.body.appendChild(menu);
                    if (!modifiers.includes('context')) el.setAttribute('popovertarget', uniqueDropdownId);

                    // Initialize Alpine on the cloned menu
                    Alpine.initTree(menu);
                } else {
                    // Original behavior for static dropdowns
                    menu = document.getElementById(dropdownId);
                    if (!menu) {
                        // Check if this might be a component-based dropdown
                        if (window.ManifestComponentsRegistry && window.ManifestComponentsLoader) {
                            // Try to find the menu in components
                            const componentName = dropdownId; // Assume the dropdownId is the component name
                            const registry = window.ManifestComponentsRegistry;

                            if (registry.registered.has(componentName)) {
                                // Component exists, wait for it to be loaded
                                const waitForComponent = async () => {
                                    const loader = window.ManifestComponentsLoader;
                                    const content = await loader.loadComponent(componentName);
                                    if (content) {
                                        // Create a temporary container to parse the component
                                        const tempDiv = document.createElement('div');
                                        tempDiv.innerHTML = content.trim();
                                        const menuElement = tempDiv.querySelector(`#${dropdownId}`);

                                        if (menuElement) {
                                            // Clone the menu and append to body
                                            menu = menuElement.cloneNode(true);
                                            menu.setAttribute('id', dropdownId);
                                            document.body.appendChild(menu);
                                            if (!modifiers.includes('context')) el.setAttribute('popovertarget', dropdownId);

                                            // Initialize Alpine on the menu
                                            Alpine.initTree(menu);

                                            // Set up the dropdown after menu is ready
                                            setupDropdown();
                                        } else {
                                            console.warn(`[Manifest] Menu with id "${dropdownId}" not found in component "${componentName}"`);
                                        }
                                    } else {
                                        console.warn(`[Manifest] Failed to load component "${componentName}" for dropdown`);
                                    }
                                };

                                // Wait for components to be ready, then try to load
                                if (window.__manifestComponentsInitialized) {
                                    waitForComponent();
                                } else {
                                    window.addEventListener('manifest:components-ready', waitForComponent);
                                }
                                return; // Exit early, setup will happen in waitForComponent
                            }
                        }

                        // Silently skip if the trigger was detached from the DOM before init
                        // (common during rapid library re-renders). The init is no longer
                        // meaningful for a node that's no longer wired up.
                        if (!el.isConnected) return;
                        console.warn(`[Manifest] Dropdown menu with id "${dropdownId}" not found`);
                        return;
                    }
                    if (!modifiers.includes('context')) el.setAttribute('popovertarget', dropdownId);
                }

                // Set up the dropdown
                setupDropdown();

                function setupDropdown() {
                    if (!menu) return;

                    // Context menus use manual popover (no light-dismiss) to avoid
                    // conflicts with multi-touch trackpad right-click
                    menu.setAttribute('popover', modifiers.includes('context') ? 'manual' : '');

                    // Anchor positioning ( --trigger-anchor is the reuse slot )
                    const anchorName = `--dropdown-${anchorCode}`;
                    el.style.setProperty('anchor-name', `${anchorName}, var(--co-anchor, --no-anchor)`);
                    el.style.setProperty('--trigger-anchor', anchorName);
                    menu.style.setProperty('position-anchor', anchorName);

                    // Re-point the shared menu at whichever trigger opens it (multi-trigger)
                    const pointMenuHere = () => {
                        menu.__mnfstTrigger = el;
                        const a = el.style.getPropertyValue('--trigger-anchor');
                        if (a) menu.style.setProperty('position-anchor', a);
                    };
                    if (!modifiers.includes('context') && !el.__mnfstAnchorSwapBound) {
                        el.__mnfstAnchorSwapBound = true;
                        el.addEventListener('pointerdown', pointMenuHere);
                        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') pointMenuHere(); });
                    }

                    // A11y wiring (WAI-ARIA Menu Button): trigger gets aria-haspopup/
                    // controls/expanded, menu gets role=menu, items role=menuitem. Skipped
                    // for .context (right-click) — not button-triggered popups per APG.
                    if (!modifiers.includes('context')) {
                        if (!menu.id) menu.id = 'mnfst-dropdown-' + Math.random().toString(36).slice(2, 9);
                        el.setAttribute('aria-haspopup', 'menu');
                        el.setAttribute('aria-controls', menu.id);
                        el.setAttribute('aria-expanded', menu.matches(':popover-open') ? 'true' : 'false');
                        if (!menu.hasAttribute('role')) menu.setAttribute('role', 'menu');
                        menu.querySelectorAll('li').forEach((li) => {
                            if (!li.hasAttribute('role')) li.setAttribute('role', 'menuitem');
                        });
                        // Keep aria-expanded in sync across every trigger of this menu.
                        if (!menu.__mnfstAriaToggleBound) {
                            menu.__mnfstAriaToggleBound = true;
                            menu.addEventListener('toggle', (e) => {
                                const expanded = e.newState === 'open' ? 'true' : 'false';
                                document.querySelectorAll(`[aria-controls="${menu.id}"]`).forEach(t => t.setAttribute('aria-expanded', expanded));
                            });
                        }
                    }

                    // Set up hover functionality after menu is ready
                    if (modifiers.includes('hover')) {
                        const handleShowPopover = () => {
                            if (menu && !menu.matches(':popover-open')) {
                                clearTimeout(hoverTimeout);
                                clearTimeout(autoCloseTimeout);

                                pointMenuHere();
                                // A hover open never runs the trigger's activation behaviour, so
                                // popovertarget alone doesn't register it as the invoker — say so
                                // here, or the menu light-dismisses whatever contains its trigger.
                                menu.showPopover({ source: el });
                            }
                        };

                        // True when pointer is over an open Manifest tooltip (hint popover), e.g. after leaving the menu
                        const isOverOpenHintTooltip = () =>
                            Array.from(document.querySelectorAll('.tooltip:popover-open')).some((t) =>
                                t.matches(':hover')
                            );

                        // Enhanced auto-close when mouse leaves both trigger and menu
                        startAutoCloseTimer = () => {
                            clearTimeout(autoCloseTimeout);
                            autoCloseTimeout = setTimeout(() => {
                                if (menu?.matches(':popover-open')) {
                                    const isOverButton = el.matches(':hover');
                                    const isOverMenu = menu.matches(':hover');

                                    if (!isOverButton && !isOverMenu && !isOverOpenHintTooltip()) {
                                        menu.hidePopover();
                                    }
                                }
                            }, 300); // Small delay to prevent accidental closes
                        };

                        el.addEventListener('mouseenter', handleShowPopover);
                        el.addEventListener('mouseleave', startAutoCloseTimer);
                    }

                    // Set up context menu (right-click) functionality
                    // Uses popover="manual" — we handle dismiss ourselves
                    if (modifiers.includes('context')) {
                        const closeContext = () => {
                            if (menu.matches(':popover-open')) menu.hidePopover();
                        };

                        // Bind once per element (reprocessing would stack duplicates).
                        if (!el.__mnfstContextTriggerBound) {
                            el.__mnfstContextTriggerBound = true;
                            el.addEventListener('contextmenu', (e) => {
                                e.preventDefault();
                                e.stopPropagation();

                                // Stash the actual right-clicked element so menu items can act on it.
                                // (e.target is the deepest hit; el is the directive-bearing ancestor.)
                                menu._triggerEl = e.target.closest('[data-cp-value], [x-data]') || el;
                                menu._triggerHost = el;

                                // Position at cursor, overriding anchor positioning
                                menu.style.position = 'fixed';
                                menu.style.positionAnchor = 'unset';
                                menu.style.positionArea = 'unset';
                                menu.style.inset = 'auto';
                                menu.style.left = e.clientX + 'px';
                                menu.style.top = e.clientY + 'px';
                                menu.style.margin = '0';

                                if (!menu.matches(':popover-open')) menu.showPopover();

                                // Adjust if menu overflows viewport
                                requestAnimationFrame(() => {
                                    const rect = menu.getBoundingClientRect();
                                    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width) + 'px';
                                    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height) + 'px';
                                });
                            });
                        }

                        // Document-level dismiss listeners are global — bind once per
                        // menu via an AbortController so reprocessing can't leak them.
                        if (!menu.__mnfstContextDismissBound) {
                            menu.__mnfstContextDismissBound = true;
                            const ctxAbort = new AbortController();
                            menu.__mnfstContextAbort = ctxAbort;
                            const { signal } = ctxAbort;

                            // Manual dismiss: click outside or Escape
                            document.addEventListener('pointerdown', (e) => {
                                if (menu.matches(':popover-open') && !menu.contains(e.target)) closeContext();
                            }, { signal });
                            document.addEventListener('keydown', (e) => {
                                if (e.key === 'Escape' && menu.matches(':popover-open')) { closeContext(); el.focus(); }
                            }, { signal });
                        }
                    }

                    // Auto-close on selection: `close` per item, .close for every row
                    // that isn't an embedded control, `keep-open` to opt back out.
                    // Context menus auto-close by nature, so .close is implied.
                    if (modifiers.includes('close') || modifiers.includes('context')) menu.__mnfstAutoClose = true;

                    if (!menu.__mnfstCloseBound) {
                        menu.__mnfstCloseBound = true;

                        const ROW = 'li, a, button, label, [role=menuitem], [role=option]';
                        const CONTROL = 'input, select, textarea, [contenteditable]:not([contenteditable=false]), [role=switch], .combobox, [x-dropdown], [popovertarget], [keep-open]';

                        // Close the item's menu plus any menus it was nested in. The owned
                        // popover isn't always a <menu> (e.g. .dropdown-menu on a div), so
                        // fall back to it rather than relying on the ancestor lookup.
                        const closeFrom = (node) => {
                            let m = node.closest('menu[popover]') || menu;
                            while (m) {
                                if (m.matches(':popover-open')) m.hidePopover();
                                m = m.parentElement?.closest('menu[popover]');
                            }
                            if (lastInputModality === 'keyboard') (menu.__mnfstTrigger || el).focus?.();
                        };

                        menu.addEventListener('click', (e) => {
                            // Explicit opt-in wins over every exclusion below
                            const opted = e.target.closest('[close]');
                            if (opted && menu.contains(opted)) return closeFrom(opted);
                            if (!menu.__mnfstAutoClose) return;

                            // Outermost row between the click target and the menu
                            let row = null;
                            for (let n = e.target; n && n !== menu; n = n.parentElement) {
                                if (n.matches?.(ROW)) row = n;
                            }
                            if (!row) return;

                            // A control that *is* the row is a menu item; one nested
                            // inside it is embedded UI, so leave the menu open
                            const hit = e.target.closest(CONTROL);
                            if (hit && hit !== row && row.contains(hit)) return;
                            if (row.querySelector(CONTROL)) return;
                            if (row.matches('[role=switch], [x-dropdown], [popovertarget], [keep-open]')) return;

                            closeFrom(row);
                        });
                    }

                    // Add keyboard navigation handling
                    menu.addEventListener('keydown', (e) => {
                        // Get all navigable elements (traditional focusable + li elements)
                        const allElements = menu.querySelectorAll(
                            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"]), li'
                        );
                        const currentIndex = Array.from(allElements).indexOf(e.target);

                        if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            const nextIndex = (currentIndex + 1) % allElements.length;
                            const nextElement = allElements[nextIndex];
                            if (nextElement.tagName === 'LI') {
                                nextElement.setAttribute('tabindex', '0');
                            }
                            nextElement.focus();
                        } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            const prevIndex = (currentIndex - 1 + allElements.length) % allElements.length;
                            const prevElement = allElements[prevIndex];
                            if (prevElement.tagName === 'LI') {
                                prevElement.setAttribute('tabindex', '0');
                            }
                            prevElement.focus();
                        } else if (e.key === 'Tab') {
                            // Get only traditional focusable elements for tab navigation
                            const focusable = menu.querySelectorAll(
                                'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                            );

                            // If we're on the last focusable element and tabbing forward
                            if (!e.shiftKey && e.target === focusable[focusable.length - 1]) {
                                e.preventDefault();
                                menu.hidePopover();
                                // Focus the next focusable element after the dropdown trigger
                                const allFocusable = document.querySelectorAll(
                                    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
                                );
                                const triggerIndex = Array.from(allFocusable).indexOf(el);
                                const nextElement = allFocusable[triggerIndex + 1];
                                if (nextElement) nextElement.focus();
                            }

                            // If we're on the first element and tabbing backward
                            if (e.shiftKey && e.target === focusable[0]) {
                                menu.hidePopover();
                            }
                        } else if (e.key === 'Escape') {
                            menu.hidePopover();
                            el.focus();
                        } else if (e.key === 'Enter' || e.key === ' ') {
                            // Allow Enter/Space to activate li elements or follow links
                            if (e.target.tagName === 'LI') {
                                e.preventDefault();
                                (e.target.querySelector('a') || e.target).click();
                            }
                        }
                    });

                    // Make li elements focusable when menu opens
                    menu.addEventListener('toggle', (e) => {
                        if (e.newState === 'open') {
                            // Set up li elements for keyboard navigation
                            const liElements = menu.querySelectorAll('li');
                            liElements.forEach((li) => {
                                if (!li.hasAttribute('tabindex')) {
                                    li.setAttribute('tabindex', '-1');
                                }
                            });
                            // When the menu has no natively focusable control, make the
                            // first item the keyboard entry point.
                            const firstLi = liElements[0];
                            if (firstLi && !menu.querySelector('button, [href], input, select, textarea, [tabindex="0"]')) {
                                firstLi.setAttribute('tabindex', '0');
                                if (lastInputModality === 'keyboard') {
                                    // Keyboard open: focus the first item (rings correctly).
                                    firstLi.focus();
                                } else {
                                    // Pointer open: park focus on the menu so arrow keys enter
                                    // the list without ringing an item the user didn't reach.
                                    if (!menu.hasAttribute('tabindex')) menu.setAttribute('tabindex', '-1');
                                    menu.focus();
                                }
                            }
                        }
                    });

                    // Add hover functionality for menu
                    if (modifiers.includes('hover')) {
                        // Simple approach: any mouse activity in the menu area cancels close timer
                        menu.addEventListener('mouseenter', () => {
                            clearTimeout(autoCloseTimeout);
                            clearTimeout(hoverTimeout);
                        });

                        menu.addEventListener('mouseleave', () => {
                            // Always start timer when leaving menu bounds
                            if (startAutoCloseTimer) {
                                startAutoCloseTimer();
                            }
                        });

                        // Add event listeners to all interactive elements inside menu to cancel timers
                        const cancelCloseTimer = () => {
                            clearTimeout(autoCloseTimeout);
                        };

                        // Set up listeners on existing menu items
                        const setupMenuItemListeners = () => {
                            const menuItems = menu.querySelectorAll('li, button, a, [role="menuitem"]');
                            menuItems.forEach(item => {
                                item.addEventListener('mouseenter', cancelCloseTimer);
                            });
                        };

                        // Setup listeners after a brief delay to ensure menu is rendered
                        setTimeout(setupMenuItemListeners, 10);
                    }
                } // End of setupDropdown function
            });
        });
    });
}

let dropdownPluginInitialized = false;

// True once Alpine finished its initial walk. Bound at load so we never miss it.
let alpineHasWalked = false;
document.addEventListener('alpine:initialized', () => { alpineHasWalked = true; });

function ensureDropdownPluginInitialized() {
    if (dropdownPluginInitialized) {
        return;
    }
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') {
        return;
    }

    dropdownPluginInitialized = true;
    initializeDropdownPlugin();

    // Walk existing [x-dropdown] subtrees only if Alpine already finished its boot
    // walk (late load). During boot, let Alpine's own walk handle them with all
    // sibling directives registered — walking here would drop nested plugin content
    // (e.g. a trailing x-icon in a menu button).
    if (alpineHasWalked && typeof window.Alpine.initTree === 'function') {
        document.querySelectorAll('[x-dropdown]').forEach(el => {
            if (!el.__x) {
                window.Alpine.initTree(el);
            }
        });
    }
}

// Expose on window for loader to call if needed
window.ensureDropdownPluginInitialized = ensureDropdownPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureDropdownPluginInitialized);
}

document.addEventListener('alpine:init', ensureDropdownPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureDropdownPluginInitialized, 0);
} else {
    // If document is already loaded but Alpine isn't ready yet, wait for it
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureDropdownPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}

// Handle dialog interactions - close dropdowns when dialogs open
document.addEventListener('click', (event) => {
    const button = event.target.closest('button[popovertarget]');
    if (!button) return;

    const targetId = button.getAttribute('popovertarget');
    const target = document.getElementById(targetId);

    if (target && target.tagName === 'DIALOG' && target.hasAttribute('popover')) {
        // Close dropdowns BEFORE the dialog opens to avoid conflicts
        const openDropdowns = document.querySelectorAll('menu[popover]:popover-open');

        openDropdowns.forEach(dropdown => {
            if (!target.contains(dropdown)) {
                dropdown.hidePopover();
            }
        });
    }
});

// Auto-close for rows that navigate. The router claims internal link clicks with
// stopImmediatePropagation, so the menu's own click handler never runs — close on
// the route change it dispatches instead. Hash links aren't intercepted and still
// close via the normal path.
window.addEventListener('manifest:route-change', () => {
    const pressed = lastPointerTarget;
    document.querySelectorAll('[popover]:popover-open').forEach((menu) => {
        if (!menu.__mnfstCloseBound) return;
        const row = pressed && menu.contains(pressed) ? pressed : null;
        if (row && row.closest('[keep-open]')) return;
        if (menu.__mnfstAutoClose || (row && row.closest('[close]'))) menu.hidePopover();
    });
});

})();
