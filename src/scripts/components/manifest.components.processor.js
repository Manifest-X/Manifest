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

// Classic JS or module; anything else (JSON, templates) is a data block
function isExecutableScript(el) {
    const type = (el.getAttribute('type') || '').split(';')[0].trim().toLowerCase();
    return type === '' || type === 'module' || /^(text|application)\/(x-)?(javascript|ecmascript)$/.test(type) ||
        /^text\/(javascript1\.[0-5]|jscript|livescript)$/.test(type);
}

// The <template x-if>/<template x-for> whose tracked clone is `el`, if any.
function findOwningTemplate(el) {
    if (!el._x_dataStack) return null;
    for (let n = el.previousElementSibling; n; n = n.previousElementSibling) {
        if (n.tagName !== 'TEMPLATE') continue;
        if (n._x_currentIfEl === el) return { tpl: n, type: 'if' };
        const lookup = el._x_refreshXForScope && n._x_lookup;
        if (lookup) {
            // Map since Alpine 3.16, plain object before
            const entries = lookup instanceof Map ? lookup : Object.entries(lookup);
            for (const [key, value] of entries) if (value === el) return { tpl: n, type: 'for', key };
        }
    }
    return null;
}

// Point Alpine's clone bookkeeping at the swapped-in node.
function repointTemplateClone(owner, placeholder, node) {
    const { tpl } = owner;
    if (owner.type === 'if') {
        const undo = tpl._x_undoIf;
        tpl._x_currentIfEl = node;
        tpl._x_lastRenderedEl = node;
        tpl._x_undoIf = () => {
            const A = window.Alpine;
            const teardown = () => {
                if (A && A.destroyTree) A.destroyTree(node);
                node.remove();
            };
            A && A.mutateDom ? A.mutateDom(teardown) : teardown();
            if (undo) undo();
        };
    } else {
        if (tpl._x_lookup instanceof Map) tpl._x_lookup.set(owner.key, node);
        else tpl._x_lookup[owner.key] = node;
        node._x_refreshXForScope = placeholder._x_refreshXForScope;
        if (tpl._x_lastRenderedEl === placeholder) tpl._x_lastRenderedEl = node;
    }
}

// Markup parsed once per component source; each instance works on a clone
const parsedComponents = new Map();
function componentContainer(name, content) {
    let entry = parsedComponents.get(name);
    if (!entry || entry.content !== content) {
        const container = document.createElement('div');
        container.innerHTML = content.trim();
        entry = { content, container };
        parsedComponents.set(name, entry);
    }
    return entry.container.cloneNode(true);
}

window.ManifestComponentsProcessor = {
    async processComponent(element, instanceId) {
        const name = element.tagName.toLowerCase().replace('x-', '');
        const registry = window.ManifestComponentsRegistry;
        const loader = window.ManifestComponentsLoader;
        if (!registry || !loader) {
            console.debug('[Manifest Components] skipped: registry or loader unavailable', element);
            return;
        }
        if (loader.frameworkTags?.has(name)) return;
        if (element.hasAttribute('data-pre-rendered') || element.hasAttribute('data-processed')) {
            // Pre-rendered content skips re-fetch but still needs Alpine init.
            if (element.hasAttribute('data-pre-rendered') && window.Alpine && typeof window.Alpine.initTree === 'function') {
                try { window.Alpine.initTree(element); } catch (e) { /* graceful */ }
            }
            console.debug('[Manifest Components] skipped: already pre-rendered/processed', element);
            return;
        }
        // Unregistered names still try the loader's components/<name>.html
        // convention; a miss leaves the element alone (it may be someone else's).
        const wasRegistered = registry.registered.has(name);
        const content = await loader.loadComponent(name);
        if (!content) {
            if (!wasRegistered) {
                console.debug('[Manifest Components] skipped: component not registered', element);
                return;
            }
            console.debug('[Manifest Components] skipped: failed to load component', element);
            element.replaceWith(document.createComment(` Failed to load component: ${name} `));
            return;
        }
        const container = componentContainer(name, content);
        let topLevelElements = Array.from(container.children);
        if (topLevelElements.length === 0) {
            console.debug('[Manifest Components] skipped: empty component template', element);
            element.replaceWith(document.createComment(` Empty component: ${name} `));
            return;
        }

        // Extract and prepare scripts for execution
        const scripts = [];
        const processScripts = (el) => {
            if (el.tagName.toLowerCase() === 'script') {
                // Data blocks (JSON, templates) are dropped, never run
                if (!isExecutableScript(el)) { el.remove(); return; }
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
        topLevelElements = Array.from(container.children);
        // Props come only from attribute text the author wrote. An attribute
        // Alpine wrote from a binding (:foo, x-bind:foo, x-bind="{...}") holds
        // data, so it never becomes expression source.
        const BOUND = /^(?::|x-bind:)([^.]+)((?:\.[^.]+)*)$/;
        const camel = (s) => s.toLowerCase().replace(/-(\w)/g, (_, c) => c.toUpperCase());
        const written = new Set(Object.keys(element._x_bindings || {}).map(k => k.toLowerCase()));
        Array.from(element.attributes).forEach(attr => {
            const m = attr.name.match(BOUND);
            if (!m) return;
            written.add(m[1].toLowerCase());
            if (m[2].split('.').includes('camel')) written.add(camel(m[1]).toLowerCase());
        });
        const isWritten = (attrName) => written.has(attrName.toLowerCase());
        const props = {};
        const setProp = (key, entry) => {
            props[key] = entry;
            props[key.toLowerCase()] = entry;
        };
        Array.from(element.attributes).forEach(attr => {
            if (attr.name === name || attr.name === 'class' || attr.name.startsWith('data-')) return;
            const m = attr.name.match(BOUND);
            if (m) {
                const entry = { text: attr.value, bound: true };
                setProp(attr.name, entry);
                setProp(m[1], entry);
                if (m[2].split('.').includes('camel')) setProp(camel(m[1]), entry);
                return;
            }
            if (isWritten(attr.name)) return;
            setProp(attr.name, { text: attr.value, bound: false });
        });
        // x-bind="{...}" keys: a lookup into the author's object expression
        const bindObject = element.getAttribute('x-bind');
        if (bindObject && bindObject.trim() && element._x_bindings) {
            Object.keys(element._x_bindings).forEach(key => {
                if (props[key.toLowerCase()] && props[key.toLowerCase()].bound) return;
                setProp(key, { text: `(${bindObject})[${JSON.stringify(key)}]`, bound: true });
            });
        }
        const isBlank = (v) => !v || v.trim() === '';
        // Bound prop as a value, for sinks that aren't expressions (class, plain attributes)
        const valueOf = (prop) => {
            if (!prop) return '';
            if (!prop.bound) return prop.text;
            if (isBlank(prop.text) || !window.Alpine || typeof window.Alpine.evaluate !== 'function') return '';
            try {
                const v = window.Alpine.evaluate(element, prop.text);
                return v == null || v === false ? '' : String(v);
            } catch (e) {
                return '';
            }
        };
        // $x paths on x-for/if/show: optional-chain + fallback until the source loads
        const guardX = (expr, directive) => {
            if ((directive === 'x-for' || directive === 'x-if' || directive === 'x-show') && expr.startsWith('$x') && !expr.includes('??')) {
                return `${expr.replace(/\./g, '?.')} ?? ${directive === 'x-for' ? '[]' : 'false'}`;
            }
            return expr;
        };
        const MODIFY = /\$modify\(['"]([^'"]+)['"]\)/g;
        const refsBound = (value) => Array.from(value.matchAll(MODIFY)).some(([, n]) => {
            const p = props[n.toLowerCase()];
            return p && p.bound && !isBlank(p.text);
        });
        // Attribute text with $modify() calls as one string expression
        const toExpression = (value) => {
            const parts = [];
            let last = 0;
            for (const m of value.matchAll(MODIFY)) {
                if (m.index > last) parts.push(`'${escapeForSingleQuotedJsString(value.slice(last, m.index))}'`);
                const p = props[m[1].toLowerCase()];
                if (p && p.bound && !isBlank(p.text)) parts.push(`((${p.text.trim()}) ?? '')`);
                else parts.push(`'${escapeForSingleQuotedJsString(p ? p.text : '')}'`);
                last = m.index + m[0].length;
            }
            if (last < value.length) parts.push(`'${escapeForSingleQuotedJsString(value.slice(last))}'`);
            return parts.join(' + ');
        };
        // Process $modify usage in all elements
        const processElementProps = (el) => {
            Array.from(el.attributes).forEach(attr => {
                const value = attr.value.trim();
                if (!value.includes('$modify(')) return;
                const propMatch = value.match(/\$modify\(['"]([^'"]+)['"]\)/);
                if (!propMatch) return;
                const propName = propMatch[1].toLowerCase();
                const prop = props[propName];
                const simple = value === `$modify('${propName}')`;
                if (attr.name === 'class') {
                    const newClasses = value
                        .replace(MODIFY, (_, n) => valueOf(props[n.toLowerCase()]))
                        .split(' ')
                        .filter(Boolean)
                        .join(' ');
                    el.setAttribute('class', newClasses);
                } else if (attr.name === 'x-icon') {
                    // x-icon takes a raw icon name or an expression
                    el.setAttribute(attr.name, prop ? prop.text : '');
                } else if (attr.name === 'x-show' || attr.name === 'x-if') {
                    // Static props test presence; bound props test their value
                    const test = (p) => p && p.bound && !isBlank(p.text)
                        ? guardX(p.text.trim(), attr.name)
                        : (p && !isBlank(p.text) ? 'true' : 'false');
                    if (simple) {
                        el.setAttribute(attr.name, test(prop));
                    } else {
                        el.setAttribute(attr.name, value.replace(MODIFY, (_, n) => {
                            const p = props[n.toLowerCase()];
                            return p && p.bound && !isBlank(p.text) ? `(${test(p)})` : test(p);
                        }));
                    }
                } else if (
                    attr.name.startsWith('x-') ||
                    attr.name.startsWith(':') ||
                    attr.name.startsWith('@')
                ) {
                    if (!simple) {
                        el.setAttribute(attr.name, value.replace(MODIFY, (_, n) => {
                            const p = props[n.toLowerCase()];
                            const val = p ? p.text : '';
                            // Empty: null where a || fallback follows
                            if (isBlank(val)) return value.includes('||') ? 'null' : "''";
                            // Bound: the author's expression, evaluated in the instance's scope
                            if (p.bound) return `(${guardX(val.trim(), attr.name)})`;
                            // Static $-prefixed values are expressions the author wrote
                            if (val.startsWith('$')) return guardX(val, attr.name);
                            // x-for can hold an author expression (e.g. "[1, 2]")
                            if (attr.name === 'x-for') return val;
                            return `'${escapeForSingleQuotedJsString(val)}'`;
                        }));
                    } else if (!prop || isBlank(prop.text)) {
                        el.removeAttribute(attr.name);
                    } else if (prop.bound || prop.text.startsWith('$')) {
                        el.setAttribute(attr.name, prop.text);
                    } else {
                        el.setAttribute(attr.name, `'${escapeForSingleQuotedJsString(prop.text)}'`);
                    }
                } else if (refsBound(value)) {
                    // Bound props stay expressions (a nested placeholder must never see data as author text)
                    el.removeAttribute(attr.name);
                    el.setAttribute(`:${attr.name}`, simple ? prop.text.trim() : toExpression(value));
                } else {
                    el.setAttribute(attr.name, simple ? valueOf(prop) : value.replace(MODIFY, (_, n) => valueOf(props[n.toLowerCase()])));
                }
            });
            Array.from(el.children).forEach(processElementProps);
        };
        topLevelElements.forEach(processElementProps);
        // Apply attributes from placeholder to root elements
        const host = { roots: topLevelElements };
        topLevelElements.forEach(rootElement => {
            Array.from(element.attributes).forEach(attr => {
                // Binding output is re-created by the copied directive
                if (attr.name !== 'class' && attr.name !== 'style' && isWritten(attr.name)) return;
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
            // The file this markup came from (Edit writes regions authored in it back there)
            rootElement._manifestComponent = name;
            rootElement._manifestHost = host;
            // The router's hide record travels with the copied inline display
            if (element.__manifestRouteDisplay) rootElement.__manifestRouteDisplay = { ...element.__manifestRouteDisplay };
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
                if (attr.name === 'class' || attr.name === 'style' || isWritten(attr.name)) {
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
            console.debug('[Manifest Components] skipped: element detached before swap', element);
            return;
        }
        // Replace the placeholder element with the component content
        const fragment = document.createDocumentFragment();
        topLevelElements.forEach(el => fragment.appendChild(el));

        // Sole child of x-if/x-for: Alpine tracks one node per clone, so a
        // multi-root component keeps a host; the clone's scope carries over.
        const owner = findOwningTemplate(element);
        let swapped = fragment;
        if (owner && topLevelElements.length) {
            swapped = topLevelElements[0];
            if (topLevelElements.length > 1) {
                swapped = document.createElement(element.tagName.toLowerCase());
                swapped.setAttribute('data-processed', '');
                swapped.style.display = 'contents';
                swapped.appendChild(fragment);
            }
            swapped._x_dataStack = element.hasAttribute('x-data') ? element._x_dataStack.slice(1) : element._x_dataStack;
            repointTemplateClone(owner, element, swapped);
        }

        parent.replaceChild(swapped, element);

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
                    } else if (script.content && script.type.trim().toLowerCase() === 'module') {
                        // Once per page, like an external module
                        const seen = Array.from(document.head.querySelectorAll('script[data-component-module]'));
                        if (seen.some(s => s.textContent === script.content)) return;
                        const scriptEl = document.createElement('script');
                        scriptEl.setAttribute('data-component-module', name);
                        scriptEl.type = 'module';
                        scriptEl.textContent = script.content;
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