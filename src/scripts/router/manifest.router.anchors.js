// Router anchors

// Parse pipeline syntax: 'scope | targets' (shared for directive and route-change handler)
function parseAnchorsExpression(expr) {
    if (!expr || expr.trim() === '') {
        return { scope: '', targets: 'h1, h2, h3, h4, h5, h6' };
    }
    if (expr.includes('|')) {
        const parts = expr.split('|').map(p => p.trim());
        return {
            scope: parts[0] || '',
            targets: parts[1] || 'h1, h2, h3, h4, h5, h6'
        };
    }
    return { scope: '', targets: expr };
}

function isVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

// Anchors functionality
function initializeAnchors() {

    // Register anchors directive
    Alpine.directive('anchors', (el, { expression, modifiers }, { effect, evaluateLater, Alpine }) => {


        try {
            const parseExpression = parseAnchorsExpression;

            // Apply an Alpine-style :class binding to the cloned link. Goes
            // through Alpine.evaluate so the expression runs in Alpine's
            // sandboxed evaluator (no eval()) and gets anchor as a real scope
            // variable — not interpolated into source. Supports the three
            // standard :class shapes: object ({foo: cond}), string, array.
            const applyClassBinding = (linkElement, classBinding, anchor) => {
                try {
                    const result = Alpine.evaluate(linkElement, classBinding, { scope: { anchor } });
                    if (result && typeof result === 'object' && !Array.isArray(result)) {
                        Object.entries(result).forEach(([className, active]) => {
                            if (active) linkElement.classList.add(className);
                        });
                    } else if (typeof result === 'string') {
                        result.split(/\s+/).filter(Boolean).forEach(c => linkElement.classList.add(c));
                    } else if (Array.isArray(result)) {
                        result.filter(c => typeof c === 'string').forEach(c => linkElement.classList.add(c));
                    }
                } catch (error) {
                    console.warn('[Manifest Anchors] Could not evaluate class binding:', classBinding, error);
                }
            };

            // Extract anchors function (only from visible scope containers to avoid prior-route content)
            const extractAnchors = (expr) => {
                const parsed = parseExpression(expr);

                let containers = [];
                if (!parsed.scope) {
                    containers = [document.body];
                } else {
                    const all = Array.from(document.querySelectorAll(parsed.scope));
                    containers = all.filter(isVisible);
                }

                let elements = [];
                const targets = parsed.targets.split(',').map(t => t.trim());

                containers.forEach(container => {
                    // Query all targets at once, then filter and sort by DOM order
                    const allMatches = [];
                    targets.forEach(target => {
                        const matches = container.querySelectorAll(target);
                        allMatches.push(...Array.from(matches));
                    });

                    // Remove duplicates and sort by DOM order
                    const uniqueMatches = [...new Set(allMatches)];
                    uniqueMatches.sort((a, b) => {
                        const position = a.compareDocumentPosition(b);
                        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
                        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
                        return 0;
                    });

                    elements.push(...uniqueMatches);
                });

                return elements.map((element, index) => {
                    // Generate simple ID
                    let id = element.id;
                    if (!id) {
                        id = element.textContent.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
                        if (id) element.id = id;
                    }

                    // Selected state will be managed by intersection observer

                    return {
                        id: id,
                        text: element.textContent,
                        link: `#${id}`,
                        tag: element.tagName.toLowerCase(),
                        class: element.className.split(' ')[0] || '',
                        classes: Array.from(element.classList),
                        index: index,
                        element: element,

                    };
                });
            };

            // Track rendered elements to prevent duplicates
            let renderedElements = [];

            // Update Alpine data with anchors
            const updateAnchors = (anchors) => {
                // Remove existing rendered elements if they exist
                renderedElements.forEach(element => {
                    if (element.parentElement) {
                        element.remove();
                    }
                });
                renderedElements = [];

                // Set Alpine reactive property for anchor count
                Alpine.store('anchors', { count: anchors.length });

                // Render using the template element's structure and classes
                if (anchors.length > 0) {
                    // Find the container div inside the template
                    const templateContent = el.content || el;
                    const containerTemplate = templateContent.querySelector('div') || el.querySelector('div');

                    if (containerTemplate) {
                        // Clone the container div from the template
                        const containerElement = containerTemplate.cloneNode(false); // Don't clone children

                        // Remove Alpine directives from the container
                        containerElement.removeAttribute('x-show');

                        anchors.forEach(anchor => {
                            // Find the <a> element inside the template
                            const anchorTemplate = templateContent.querySelector('a') || el.querySelector('a');

                            if (anchorTemplate) {
                                // Clone the <a> element from inside the template
                                const linkElement = anchorTemplate.cloneNode(true);

                                // Remove Alpine directives
                                linkElement.removeAttribute('x-text');
                                linkElement.removeAttribute(':href');

                                // Set the actual href and text content
                                linkElement.href = anchor.link;
                                linkElement.textContent = anchor.text;

                                // Evaluate :class binding if present
                                if (linkElement.hasAttribute(':class')) {
                                    const classBinding = linkElement.getAttribute(':class');
                                    linkElement.removeAttribute(':class');
                                    applyClassBinding(linkElement, classBinding, anchor);
                                }

                                containerElement.appendChild(linkElement);
                            }
                        });

                        // Insert the container before the template element
                        el.parentElement.insertBefore(containerElement, el);
                        renderedElements.push(containerElement);
                    } else {
                        // Fallback: insert links directly if no container found
                        anchors.forEach(anchor => {
                            const templateContent = el.content || el;
                            const anchorTemplate = templateContent.querySelector('a') || el.querySelector('a');

                            if (anchorTemplate) {
                                const linkElement = anchorTemplate.cloneNode(true);
                                linkElement.removeAttribute('x-text');
                                linkElement.removeAttribute(':href');
                                linkElement.href = anchor.link;
                                linkElement.textContent = anchor.text;

                                // Evaluate :class binding if present
                                if (linkElement.hasAttribute(':class')) {
                                    const classBinding = linkElement.getAttribute(':class');
                                    linkElement.removeAttribute(':class');
                                    applyClassBinding(linkElement, classBinding, anchor);
                                }

                                el.parentElement.insertBefore(linkElement, el);
                                renderedElements.push(linkElement);
                            }
                        });
                    }

                    el.style.display = 'none'; // Hide template
                } else {
                    // No anchors - ensure template is visible and elements are cleared
                    el.style.display = '';
                }
            };

            // Try extraction and update data
            const tryExtraction = () => {
                const anchors = extractAnchors(expression);
                updateAnchors(anchors);
                return anchors;
            };

            // Try extraction with progressive delays and content detection
            const attemptExtraction = (attempt = 1, maxAttempts = 10) => {
                const anchors = extractAnchors(expression);

                if (anchors.length > 0) {
                    updateAnchors(anchors);
                    return true;
                } else if (attempt < maxAttempts) {
                    setTimeout(() => {
                        attemptExtraction(attempt + 1, maxAttempts);
                    }, attempt * 200); // Progressive delay: 200ms, 400ms, 600ms, etc.
                } else {
                    // No anchors found after all attempts, update store to clear previous state
                    updateAnchors([]);
                }
                return false;
            };

            // Store refresh function on element for route changes
            el._x_anchorRefresh = () => {
                attemptExtraction();
            };

            // Start extraction attempts
            attemptExtraction();


        } catch (error) {
            console.error('[Manifest Anchors] Error in directive:', error);
        }
    });
}

// Initialize anchors when Alpine is ready
document.addEventListener('alpine:init', () => {

    try {
        initializeAnchors();

    } catch (error) {
        console.error('[Manifest Anchors] Failed to initialize:', error);
    }
});

// Refresh anchors when route changes — wait for scope DOM to update (e.g. x-markdown) to avoid showing prior page's anchors
window.addEventListener('manifest:route-change', () => {
    Alpine.store('anchors', { count: 0 });

    const runWhenScopeReady = (el) => {
        const expression = el.getAttribute('x-anchors');
        if (!expression || !el._x_anchorRefresh) return;
        const { scope } = parseAnchorsExpression(expression);
        if (!scope) {
            setTimeout(() => el._x_anchorRefresh(), 400);
            return;
        }
        const containers = Array.from(document.querySelectorAll(scope)).filter(isVisible);
        const container = containers[0];
        if (!container) {
            el._x_anchorRefresh();
            return;
        }
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            observer?.disconnect();
            clearTimeout(fallback);
            el._x_anchorRefresh();
        };
        let t = 0;
        const observer = new MutationObserver(() => {
            clearTimeout(t);
            t = setTimeout(finish, 50);
        });
        observer.observe(container, { childList: true, subtree: true });
        const fallback = setTimeout(finish, 800);
    };

    requestAnimationFrame(() => {
        document.querySelectorAll('[x-anchors]').forEach(runWhenScopeReady);
    });
});

// Refresh anchors when hash changes (for active state updates)
window.addEventListener('hashchange', () => {
    const anchorElements = document.querySelectorAll('[x-anchors]');
    anchorElements.forEach(el => {
        if (el._x_anchorRefresh) {
            el._x_anchorRefresh();
        }
    });
});

// Also refresh anchors when components are processed
window.addEventListener('manifest:components-processed', () => {
    setTimeout(() => {
        const anchorElements = document.querySelectorAll('[x-anchors]');
        anchorElements.forEach(el => {
            const expression = el.getAttribute('x-anchors');
            if (expression && el._x_anchorRefresh) {
                el._x_anchorRefresh();
            }
        });
    }, 100);
});

// Export anchors interface
window.ManifestRoutingAnchors = {
    initialize: initializeAnchors
};
