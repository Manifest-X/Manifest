// Components processor

// Escape a value for safe interpolation in single-quoted JS strings AND
// backtick template literals. Backslash, backtick, and ${ must be escaped or a
// bound value like `${alert(1)}` becomes code execution; escape backslash FIRST.
function escapeForSingleQuotedJsString(s) {
    return String(s)
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${')
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t');
}

window.ManifestComponentsProcessor = {
    async processComponent(element, instanceId) {
        const name = element.tagName.toLowerCase().replace('x-', '');
        const registry = window.ManifestComponentsRegistry;
        const loader = window.ManifestComponentsLoader;
        if (!registry || !loader) {
            return;
        }
        if (!registry.registered.has(name)) {
            return;
        }
        if (element.hasAttribute('data-pre-rendered') || element.hasAttribute('data-processed')) {
            // Pre-rendered content skips re-fetch but still needs Alpine init.
            if (element.hasAttribute('data-pre-rendered') && window.Alpine && typeof window.Alpine.initTree === 'function') {
                try { window.Alpine.initTree(element); } catch (e) { /* graceful */ }
            }
            return;
        }
        const content = await loader.loadComponent(name);
        if (!content) {
            element.replaceWith(document.createComment(` Failed to load component: ${name} `));
            return;
        }
        const container = document.createElement('div');
        container.innerHTML = content.trim();
        const topLevelElements = Array.from(container.children);
        if (topLevelElements.length === 0) {
            element.replaceWith(document.createComment(` Empty component: ${name} `));
            return;
        }

        // Extract and prepare scripts for execution
        const scripts = [];
        const processScripts = (el) => {
            if (el.tagName.toLowerCase() === 'script') {
                scripts.push({
                    content: el.textContent,
                    type: el.getAttribute('type') || 'text/javascript',
                    src: el.getAttribute('src'),
                    async: el.hasAttribute('async'),
                    defer: el.hasAttribute('defer')
                });
                // Remove script from DOM to avoid duplication
                el.remove();
            } else {
                Array.from(el.children).forEach(processScripts);
            }
        };
        topLevelElements.forEach(processScripts);
        // Collect properties from placeholder attributes
        const props = {};
        Array.from(element.attributes).forEach(attr => {
            if (attr.name !== name && attr.name !== 'class' && !attr.name.startsWith('data-')) {
                // Store original case and lowercase
                props[attr.name] = attr.value;
                props[attr.name.toLowerCase()] = attr.value;
                // Alpine bindings (:foo): also store without the colon
                if (attr.name.startsWith(':')) {
                    const keyWithoutColon = attr.name.substring(1);
                    props[keyWithoutColon] = attr.value;
                    props[keyWithoutColon.toLowerCase()] = attr.value;
                }
            }
        });
        // Process $modify usage in all elements
        const processElementProps = (el) => {
            Array.from(el.attributes).forEach(attr => {
                const value = attr.value.trim();
                if (value.includes('$modify(')) {
                    const propMatch = value.match(/\$modify\(['"]([^'"]+)['"]\)/);
                    if (propMatch) {
                        const propName = propMatch[1].toLowerCase();
                        const propValue = props[propName] || '';
                        if (attr.name === 'class') {
                            const existingClasses = el.getAttribute('class') || '';
                            const newClasses = existingClasses
                                .replace(new RegExp(`\$modify\(['"]${propName}['"]\)`, 'i'), propValue)
                                .split(' ')
                                .filter(Boolean)
                                .join(' ');
                            el.setAttribute('class', newClasses);
                        } else if (attr.name === 'x-icon') {
                            // x-icon should get the raw value, not wrapped for Alpine evaluation
                            el.setAttribute(attr.name, propValue);
                        } else if (attr.name === 'x-show' || attr.name === 'x-if') {
                            // x-show and x-if expect boolean expressions, convert string to boolean check
                            if (value !== `$modify('${propName}')`) {
                                const newValue = value.replace(
                                    /\$modify\(['"]([^'"]+)['"]\)/g,
                                    (_, name) => {
                                        const val = props[name.toLowerCase()] || '';
                                        // Convert to boolean check - true if value exists and is not empty
                                        return val ? 'true' : 'false';
                                    }
                                );
                                el.setAttribute(attr.name, newValue);
                            } else {
                                // Simple replacement - check if prop exists and is not empty
                                const booleanValue = propValue && propValue.trim() !== '' ? 'true' : 'false';
                                el.setAttribute(attr.name, booleanValue);
                            }
                        } else if (
                            attr.name.startsWith('x-') ||
                            attr.name.startsWith(':') ||
                            attr.name.startsWith('@') ||
                            attr.name.startsWith('x-bind:') ||
                            attr.name.startsWith('x-on:')
                        ) {
                            // For Alpine directives, properly quote string values
                            if (value !== `$modify('${propName}')`) {
                                // Handle mixed content with multiple $modify() calls
                                const newValue = value.replace(
                                    /\$modify\(['"]([^'"]+)['"]\)/g,
                                    (_, name) => {
                                        const val = props[name.toLowerCase()] || '';
                                        // For expressions with fallbacks (||), use null for empty/whitespace values
                                        if (!val || val.trim() === '' || /^[\r\n\t\s]+$/.test(val)) {
                                            return value.includes('||') ? 'null' : "''";
                                        }
                                        // $-prefixed values are Alpine expressions — don't quote.
                                        if (val.startsWith('$')) {
                                            // Guard $x data-source expressions on x-for/if/show against
                                            // errors before the source loads: optional-chain + fallback.
                                            if ((attr.name === 'x-for' || attr.name === 'x-if' || attr.name === 'x-show') && val.startsWith('$x') && !val.includes('??')) {
                                                let safeVal = val.replace(/\./g, '?.');
                                                if (attr.name === 'x-for') {
                                                    return `${safeVal} ?? []`;
                                                } else {
                                                    return `${safeVal} ?? false`;
                                                }
                                            }
                                            return val;
                                        }
                                        // x-for/if/show can hold expressions (e.g. "card in $x.data.items") — preserve as-is.
                                        if (attr.name === 'x-for' || attr.name === 'x-if' || attr.name === 'x-show') {
                                            return val;
                                        }
                                        // Quote everything else so it's treated as a string.
                                        return `'${escapeForSingleQuotedJsString(val)}'`;
                                    }
                                );
                                el.setAttribute(attr.name, newValue);
                            } else {
                                // Simple $modify() replacement
                                if (!propValue || propValue.trim() === '' || /^[\r\n\t\s]+$/.test(propValue)) {
                                    // For empty/whitespace values, remove the attribute
                                    el.removeAttribute(attr.name);
                                } else {
                                    // If value starts with $, it's an Alpine expression - don't quote
                                    if (propValue.startsWith('$')) {
                                        el.setAttribute(attr.name, propValue);
                                    } else {
                                        // Always quote string values and escape special characters
                                        const quotedValue = `'${escapeForSingleQuotedJsString(propValue)}'`;
                                        el.setAttribute(attr.name, quotedValue);
                                    }
                                }
                            }
                        } else {
                            el.setAttribute(attr.name, propValue);
                        }
                    }
                }
            });
            Array.from(el.children).forEach(processElementProps);
        };
        topLevelElements.forEach(processElementProps);
        // Apply attributes from placeholder to root elements
        topLevelElements.forEach(rootElement => {
            Array.from(element.attributes).forEach(attr => {
                if (attr.name === 'class') {
                    const existingClass = rootElement.getAttribute('class') || '';
                    const newClasses = `${existingClass} ${attr.value}`.trim();
                    rootElement.setAttribute('class', newClasses);
                } else if (attr.name.startsWith('x-') || attr.name.startsWith(':') || attr.name.startsWith('@')) {
                    rootElement.setAttribute(attr.name, attr.value);
                } else if (attr.name !== name && !attr.name.startsWith('data-')) {
                    rootElement.setAttribute(attr.name, attr.value);
                }
                // Preserve important data attributes including data-order
                else if (attr.name === 'data-order' || attr.name === 'x-route' || attr.name === 'data-head') {
                    rootElement.setAttribute(attr.name, attr.value);
                }
            });
            // Set data-component=instanceId if provided
            if (instanceId) {
                rootElement.setAttribute('data-component', instanceId);
            }
        });
        // Copy any placeholder attributes the first loop skipped onto the first
        // root element (classes already handled there, so skip them).
        if (topLevelElements.length > 0) {
            const firstRoot = topLevelElements[0];
            Array.from(element.attributes).forEach(attr => {
                if (attr.name === 'class') {
                    return;
                }

                // Routing/data attributes to preserve
                const preserveAttributes = [
                    'data-order', 'x-route', 'data-component', 'data-head',
                    'x-route-*', 'data-route-*', 'x-tabpanel'
                ];
                const shouldPreserve = preserveAttributes.some(preserveAttr =>
                    attr.name === preserveAttr || attr.name.startsWith(preserveAttr.replace('*', ''))
                );

                // Check if this attribute was already handled in the first loop
                const alreadyHandledInFirstLoop =
                    attr.name.startsWith('x-') || attr.name.startsWith(':') || attr.name.startsWith('@') ||
                    (attr.name !== name && !attr.name.startsWith('data-')) ||
                    attr.name === 'data-order' || attr.name === 'x-route' || attr.name === 'data-head';

                // Apply if unhandled or preserved, and not in the skip list.
                if ((!alreadyHandledInFirstLoop || shouldPreserve) &&
                    !['data-original-placeholder', 'data-pre-rendered', 'data-processed'].includes(attr.name)) {
                    if (attr.name.startsWith('x-') || attr.name.startsWith(':') || attr.name.startsWith('@')) {
                        // x-data: merge two object literals; otherwise replace.
                        if (attr.name === 'x-data' && firstRoot.hasAttribute('x-data')) {
                            const existing = firstRoot.getAttribute('x-data');
                            if (existing.trim().startsWith('{') && attr.value.trim().startsWith('{')) {
                                const existingContent = existing.trim().slice(1, -1).trim();
                                const newContent = attr.value.trim().slice(1, -1).trim();
                                const merged = `{ ${existingContent}${existingContent && newContent ? ', ' : ''}${newContent} }`;
                                firstRoot.setAttribute('x-data', merged);
                            } else {
                                firstRoot.setAttribute(attr.name, attr.value);
                            }
                        } else {
                            firstRoot.setAttribute(attr.name, attr.value);
                        }
                    } else {
                        firstRoot.setAttribute(attr.name, attr.value);
                    }
                }
            });
        }
        const parent = element.parentElement;
        if (!parent || !document.contains(element)) {
            return;
        }
        // Replace the placeholder element with the component content
        const fragment = document.createDocumentFragment();
        topLevelElements.forEach(el => fragment.appendChild(el));

        parent.replaceChild(fragment, element);

        // Manually init Alpine on the swapped-in elements once magic methods are
        // ready — prevents "i is not a function" errors.
        if (window.Alpine && typeof window.Alpine.initTree === 'function') {
            const initAlpine = () => {
                // Init auth convenience methods before Alpine evaluates expressions,
                // else "$auth.isCreatingTeam is not a function" after reinit.
                if (window.ManifestAppwriteAuthTeamsConvenience && window.ManifestAppwriteAuthTeamsConvenience.initialize) {
                    try {
                        const authStore = window.Alpine.store('auth');
                        if (authStore && (!authStore.isCreatingTeam || typeof authStore.isCreatingTeam !== 'function')) {
                            window.ManifestAppwriteAuthTeamsConvenience.initialize();
                        }
                    } catch (error) {
                        // Failed to reinitialize, continue anyway
                    }
                }

                topLevelElements.forEach(el => {
                    if (!el.__x) {
                        try {
                            window.Alpine.initTree(el);
                        } catch (e) {
                            console.error(`[Manifest Components] Error initializing Alpine for component "${name}":`, e);
                        }
                    }
                });
            };

            // If the data plugin is ready, wait a tick for its magic method.
            if (window.__manifestDataMagicRegistered) {
                if (window.Alpine.nextTick) {
                    window.Alpine.nextTick(initAlpine);
                } else {
                    setTimeout(initAlpine, 0);
                }
            } else {
                initAlpine();
            }
        }

        // Execute component scripts after render (small delay for the DOM swap)
        if (scripts.length > 0) {
            setTimeout(() => {
                scripts.forEach(script => {
                    if (script.src) {
                        // External script → append to head
                        const scriptEl = document.createElement('script');
                        scriptEl.src = script.src;
                        scriptEl.type = script.type;
                        if (script.async) scriptEl.async = true;
                        if (script.defer) scriptEl.defer = true;
                        document.head.appendChild(scriptEl);
                    } else if (script.content) {
                        // Inline script → run in global scope
                        try {
                            const executeScript = new Function(script.content);
                            executeScript();
                        } catch (error) {
                            console.error(`[Manifest] Error executing script in component ${name}:`, error);
                        }
                    }
                });
            }, 0);
        }
    },
    initialize() {
    }
}; 