// Router head

function isPrerenderedStaticMPA() {
    try {
        if (window.ManifestRoutingVisibility && typeof window.ManifestRoutingVisibility.isPrerenderedStaticMPA === 'function') {
            return window.ManifestRoutingVisibility.isPrerenderedStaticMPA();
        }
        return document.querySelector('meta[name="manifest:prerendered"][content="1"]') !== null;
    } catch (e) {
        return false;
    }
}

// Track injected head content to prevent duplicates
const injectedHeadContent = new Set();

// Check if an element should be visible based on route conditions
function shouldElementBeVisible(element, normalizedPath) {

    // Check if element has x-route attribute
    if (element.hasAttribute('x-route')) {
        const routeCondition = element.getAttribute('x-route');

        if (routeCondition) {
            const conditions = routeCondition.split(',').map(cond => cond.trim());
            const positiveConditions = conditions.filter(cond => !cond.startsWith('!'));
            const negativeConditions = conditions
                .filter(cond => cond.startsWith('!'))
                .map(cond => cond.slice(1));

            const hasNegativeMatch = negativeConditions.some(cond => {
                const matches = window.ManifestRouting.matchesCondition(normalizedPath, cond);
                return matches;
            });

            const hasPositiveMatch = positiveConditions.length === 0 || positiveConditions.some(cond => {
                const matches = window.ManifestRouting.matchesCondition(normalizedPath, cond);
                return matches;
            });

            const result = hasPositiveMatch && !hasNegativeMatch;
            return result;
        }
    }

    // Check parent elements for x-route
    const parentWithRoute = element.closest('[x-route]');
    if (parentWithRoute) {
        return shouldElementBeVisible(parentWithRoute, normalizedPath);
    }

    // If no route conditions, element is visible
    return true;
}

// Resolve :attr and x-bind:attr whose value is $x.path so injected meta/link have real content (SPA + prerender).
function resolveDataHeadBindings(element) {
    const x = typeof window !== 'undefined' && window.$x;
    if (!x) return;
    const toResolve = [];
    for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        const name = attr.name;
        let bindingAttr = null;
        if (name.startsWith(':')) bindingAttr = name.slice(1);
        else if (name.startsWith('x-bind:')) bindingAttr = name.slice(7);
        if (!bindingAttr) continue;
        const expr = (attr.value || '').trim();
        if (!expr.startsWith('$x.')) continue;
        const path = expr.slice(3).trim();
        if (!path) continue;
        toResolve.push({ bindingName: attr.name, attrName: bindingAttr, path });
    }
    for (const { bindingName, attrName, path } of toResolve) {
        let value;
        try {
            value = path.split('.').reduce(function (obj, key) {
                return obj != null && typeof obj === 'object' ? obj[key] : undefined;
            }, x);
        } catch (e) {
            continue;
        }
        if (value === undefined) continue;
        element.setAttribute(attrName, String(value));
        element.removeAttribute(bindingName);
    }
}

// Generate unique identifier for head content
function generateHeadId(element) {
    const position = element.getAttribute('data-order');
    const componentId = element.getAttribute('data-component-id');
    const tagName = element.tagName.toLowerCase();

    if (position) {
        return `${tagName}-${position}`;
    } else if (componentId) {
        return `${tagName}-${componentId}`;
    } else {
        return `${tagName}-${Math.random().toString(36).substr(2, 9)}`;
    }
}

// Process head content for a single element
function processElementHeadContent(element, normalizedPath) {
    let headTemplate = null;

    // Check if the element itself is a template with data-head
    if (element.tagName === 'TEMPLATE' && element.hasAttribute('data-head')) {
        headTemplate = element;
    } else {
        // Look for a template with data-head inside the element
        headTemplate = element.querySelector('template[data-head]');
    }

    if (!headTemplate) {
        return;
    }

    const headId = generateHeadId(element);
    const isVisible = shouldElementBeVisible(element, normalizedPath);

    if (isVisible) {
        // Skip if already injected (in-memory) or already present in DOM (e.g. prerendered)
        if (injectedHeadContent.has(headId)) {
            return;
        }
        if (document.head.querySelector(`[data-route-head="${headId}"]`)) {
            injectedHeadContent.add(headId);
            return;
        }

        // Add new head content
        Array.from(headTemplate.content.children).forEach(child => {
            if (child.tagName === 'SCRIPT') {
                // For scripts, create and execute directly. Preserve all source
                // attributes (src, type, async, defer, crossorigin, integrity,
                // nonce, etc.) — copying only textContent silently drops external
                // src loads and turns type="module" scripts into classic scripts.
                const script = document.createElement('script');
                for (const attr of child.attributes) {
                    script.setAttribute(attr.name, attr.value);
                }
                if (child.textContent) script.textContent = child.textContent;
                script.setAttribute('data-route-head', headId);
                document.head.appendChild(script);
            } else {
                // For other elements, clone and add (resolve $x bindings so meta/link have real values in SPA)
                const clonedChild = child.cloneNode(true);
                resolveDataHeadBindings(clonedChild);
                clonedChild.setAttribute('data-route-head', headId);
                document.head.appendChild(clonedChild);
            }
        });

        injectedHeadContent.add(headId);
    } else {
        // Element is not visible, remove any existing head content for this element
        const existingHead = document.head.querySelectorAll(`[data-route-head="${headId}"]`);
        existingHead.forEach(el => {
            el.remove();
        });
        injectedHeadContent.delete(headId);
    }
}

// Process all head content in the DOM
function processAllHeadContent(normalizedPath) {
    if (isPrerenderedStaticMPA()) return;

    // Find all elements with head templates
    const elementsWithHead = document.querySelectorAll('template[data-head]');

    // Debug: Let's see what's actually in the DOM
    const allTemplates = document.querySelectorAll('template');
    allTemplates.forEach((template, index) => {
        if (template.hasAttribute('data-head')) {
        } else {
            // Check if this might be the about template
            if (template.getAttribute('x-route') === 'about') {
            }
        }
    });

    // Also try a more specific selector to see if we can find the about template
    const aboutTemplate = document.querySelector('template[x-route="about"]');
    if (aboutTemplate) {
    }

    // Process each element's head content
    elementsWithHead.forEach((template, index) => {

        // For component templates, we need to check if the component should be visible
        // based on the current route, not just the template's own attributes
        let element = template;
        let shouldProcess = true;

        // If this is a component template (has data-component), check if the component
        // should be visible for the current route
        if (template.hasAttribute('data-component')) {
            const componentId = template.getAttribute('data-component');
            const componentRoute = template.getAttribute('x-route');

            // Check if this component should be visible for the current route
            if (componentRoute) {
                const isVisible = window.ManifestRouting.matchesCondition(normalizedPath, componentRoute);
                shouldProcess = isVisible;
            } else {
                shouldProcess = false;
            }
        } else {
            // For non-component templates, use the existing logic
            element = template.closest('[data-order], [data-component-id], [x-route]');

            // If the template itself has the attributes we need, use it directly
            if (!element || element === template) {
                if (template.hasAttribute('data-order') || template.hasAttribute('data-component') || template.hasAttribute('x-route')) {
                    element = template;
                } else {
                    element = template.parentElement;
                }
            }

            if (element) {
                const isVisible = shouldElementBeVisible(element, normalizedPath);
                shouldProcess = isVisible;
            }
        }

        if (shouldProcess) {
            // For component templates, process them directly since we've already determined visibility
            if (template.hasAttribute('data-component')) {
                processElementHeadContent(template, normalizedPath);
            } else {
                // For non-component templates, use the existing logic
                processElementHeadContent(element, normalizedPath);
            }
        }
    });
}

// Initialize head content management
function initializeHeadContent() {
    // Wait for components to be ready before processing head content
    function processHeadContentAfterComponentsReady() {
        // Process initial head content after a longer delay to let components settle
        setTimeout(() => {
            if (isPrerenderedStaticMPA()) return;
            const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
            const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');

            // Debug: Check if about component exists
            const aboutComponent = document.querySelector('[data-component="about-1"]');
            if (aboutComponent) {
            }

            // Debug: Check what placeholders exist
            const placeholders = document.querySelectorAll('x-about, x-home, x-ui');
            placeholders.forEach((placeholder, index) => {
            });

            processAllHeadContent(normalizedPath);
        }, 200);
    }

    // Function to process head content immediately (for projects without components)
    function processHeadContentImmediately() {
        if (isPrerenderedStaticMPA()) return;
        const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
        const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');
        processAllHeadContent(normalizedPath);
    }

    // Check if components system exists
    if (window.ManifestComponents) {
        // Components system exists - wait for it to be fully processed
        if (window.__manifestComponentsInitialized) {
            // Components are initialized, but we need to wait for them to be processed
            // Check if components have already been processed
            if (document.querySelector('[data-component]')) {
                processHeadContentAfterComponentsReady();
            } else {
                // Wait for components to be processed
                window.addEventListener('manifest:components-processed', processHeadContentAfterComponentsReady);
            }
        } else {
            // Wait for components to be ready, then wait for them to be processed
            window.addEventListener('manifest:components-ready', () => {
                window.addEventListener('manifest:components-processed', processHeadContentAfterComponentsReady);
            });
        }
    } else {
        // No components system - process immediately
        processHeadContentImmediately();
    }

    // Listen for route changes - process immediately after components are ready
    window.addEventListener('manifest:route-change', (event) => {

        // Wait a bit for components to settle after route change
        setTimeout(() => {
            if (isPrerenderedStaticMPA()) return;
            // Process head content immediately to catch components before they're reverted
            const currentPath = window.ManifestRoutingNavigation?.getCurrentRoute() ?? window.location.pathname;
            const normalizedPath = currentPath === '/' ? '/' : currentPath.replace(/^\/|\/$/g, '');

            // Debug: Check if about component exists
            const aboutComponent = document.querySelector('[data-component="about-1"]');
            if (aboutComponent) {
            }

            // Debug: Check what placeholders exist
            const placeholders = document.querySelectorAll('x-about, x-home, x-ui');
            placeholders.forEach((placeholder, index) => {
            });

            processAllHeadContent(normalizedPath);
        }, 100);
    });
}

// Run immediately if DOM is ready, otherwise wait
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeHeadContent);
} else {
    initializeHeadContent();
}

// Export head content interface
window.ManifestRoutingHead = {
    initialize: initializeHeadContent,
    processElementHeadContent,
    processAllHeadContent
}; 