/* Manifest Markdown */

(function () {


let markedPromise = null;

const markdownCache = new Map();

// Invalidate the fetch cache on dev-reload, else a saved .md serves stale
// cached content (and the lastProcessedContent short-circuit leaves it blank).
if (typeof window !== 'undefined') {
    window.addEventListener('manifest:dev-reload', () => {
        markdownCache.clear();
    });
}

// DOMPurify config for Manifest markdown: allow x-* custom elements and
// directive attributes to survive, but reject on* event handlers.
const MARKDOWN_PURIFY_CONFIG = {
    CUSTOM_ELEMENT_HANDLING: {
        tagNameCheck: /^x-[a-z][\w-]*$/,
        attributeNameCheck: /^(?!on)[a-z][\w\-:]*$/i,
        allowCustomizedBuiltInElements: false
    }
};

// Shared DOMPurify loader on window (svg.js or markdown, whichever loads first).
// A top-level `let purifyPromise` would collide with svg.js's identical one.
if (!window.ManifestDOMPurify) {
    window.ManifestDOMPurify = {
        _promise: null,
        load() {
            if (typeof window.DOMPurify !== 'undefined') return Promise.resolve(window.DOMPurify);
            if (this._promise) return this._promise;
            this._promise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                // Pinned + SRI (browser rejects on hash mismatch). Bump version AND integrity together.
                script.src = 'https://cdn.jsdelivr.net/npm/dompurify@3.4.10/dist/purify.min.js';
                script.integrity = 'sha384-eguRoJERj8ghOpzO//Rl7+ScQsQIR1cH+ajll7+fG+IpbNPlkZsQn9h8ccr+wPXx';
                script.crossOrigin = 'anonymous';
                script.onload = () => {
                    if (typeof window.DOMPurify !== 'undefined') {
                        resolve(window.DOMPurify);
                    } else {
                        this._promise = null;
                        reject(new Error('DOMPurify failed to load'));
                    }
                };
                script.onerror = (err) => {
                    this._promise = null;
                    reject(err);
                };
                document.head.appendChild(script);
            });
            return this._promise;
        }
    };
}

// Sanitize HTML when .safe is set; pass-through otherwise (default is
// unsanitized so custom-element extensions work). Use .safe for untrusted source.
async function maybeSanitizeMarkdownHtml(html, safe) {
    if (!safe) return html;
    try {
        const DOMPurify = await window.ManifestDOMPurify.load();
        return DOMPurify.sanitize(html, MARKDOWN_PURIFY_CONFIG);
    } catch {
        // Loader failure — escape rather than emit un-sanitized HTML (.safe was asked for).
        const escaped = String(html)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        console.warn('[Manifest Markdown] x-markdown.safe: DOMPurify unavailable — emitting escaped text.');
        return escaped;
    }
}

// Load marked.js from CDN
async function loadMarkedJS() {
    if (typeof marked !== 'undefined') {
        return marked;
    }

    // Return existing promise if already loading
    if (markedPromise) {
        return markedPromise;
    }

    markedPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        // Pinned + SRI (see DOMPurify loader above).
        script.src = 'https://cdn.jsdelivr.net/npm/marked@15.0.12/marked.min.js';
        script.integrity = 'sha384-948ahk4ZmxYVYOc+rxN1H2gM1EJ2Duhp7uHtZ4WSLkV4Vtx5MUqnV+l7u9B+jFv+';
        script.crossOrigin = 'anonymous';
        script.onload = () => {
            // Initialize marked.js
            if (typeof marked !== 'undefined') {
                resolve(marked);
            } else {
                console.error('[Manifest Markdown] Marked.js failed to load - marked is undefined');
                markedPromise = null; // Reset so we can try again
                reject(new Error('marked.js failed to load'));
            }
        };
        script.onerror = (error) => {
            console.error('[Manifest Markdown] Script failed to load:', error);
            markedPromise = null; // Reset so we can try again
            reject(error);
        };
        document.head.appendChild(script);
    });

    return markedPromise;
}

// HTML-escape for safe interpolation in an attribute value — fence title/language
// strings come from source and could otherwise inject attributes onto the <pre>.
function escapeForAttribute(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Escape a literal HTML fragment to display as source text inside a <code>.
function escapeForText(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Configure marked to preserve full language strings
async function configureMarked(marked) {
    marked.use({
        renderer: {
            // Render fenced blocks as <pre x-code><code>…</code></pre>; the code
            // plugin handles highlighting/copy/collapse/lines from there.
            code(token) {
                const lang = token.lang || '';
                const text = token.text || '';

                const attrs = parseLanguageString(lang);

                let preAttrs = '';
                // x-code value = language ('' means auto-detect)
                preAttrs += ` x-code="${attrs.language ? escapeForAttribute(attrs.language) : ''}"`;
                if (attrs.title)    preAttrs += ` name="${escapeForAttribute(attrs.title)}"`;
                if (attrs.lines)    preAttrs += ' lines';
                if (attrs.copy)     preAttrs += ' copy';
                if (attrs.edit)     preAttrs += ' edit';
                if (attrs.collapse !== null) {
                    preAttrs += attrs.collapse === ''
                        ? ' collapse'
                        : ` collapse="${escapeForAttribute(attrs.collapse)}"`;
                }
                if (attrs.from) preAttrs += ` from="${escapeForAttribute(attrs.from)}"`;

                // Escape the fence body so an HTML fence stays source text, not a
                // live element (the code plugin reads textContent back to source).
                return `<pre${preAttrs}><code>${escapeForText(text)}</code></pre>\n`;
            }
        },
        // Configure marked to allow custom HTML tags
        breaks: true,
        gfm: true
    });

    // Add custom tokenizer for callout blocks
    marked.use({
        extensions: [{
            name: 'callout',
            level: 'block',
            start(src) {
                return src.match(/^:::/)?.index;
            },
            tokenizer(src) {
                // Find the opening ::: and type
                const openMatch = src.match(/^:::(.*?)(?:\n|$)/);
                if (!openMatch) return;

                // Parse the opening line for classes, icon, and an optional quoted
                // name (`::: frame "header.html"`) → `name` attr on the <aside>,
                // used to pair with a same-named fence inside an <x-code-group>.
                const openingLine = openMatch[1].trim();
                let classes = '';
                let iconValue = '';
                let nameValue = '';

                // Match icon="value" pattern
                const iconMatch = openingLine.match(/icon="([^"]+)"/);
                if (iconMatch) {
                    iconValue = iconMatch[1];
                }

                // Match the first quoted string (skipping the icon="…" pair).
                const withoutIcon = openingLine.replace(/\s*icon="[^"]+"\s*/, ' ');
                const nameMatch = withoutIcon.match(/"([^"]+)"/);
                if (nameMatch) {
                    nameValue = nameMatch[1];
                }

                // Get all class names (remove icon attribute and quoted name first)
                classes = withoutIcon.replace(/\s*"[^"]+"\s*/, ' ').replace(/\s+/g, ' ').trim();

                const startPos = openMatch[0].length;

                // Find the closing ::: from the remaining content
                const remainingContent = src.slice(startPos);
                const closeMatch = remainingContent.match(/\n:::/);

                if (closeMatch) {
                    const content = remainingContent.slice(0, closeMatch.index);
                    const raw = openMatch[0] + content + closeMatch[0];

                    return {
                        type: 'callout',
                        raw: raw,
                        classes: classes,
                        iconValue: iconValue,
                        nameValue: nameValue,
                        text: content.trim()
                    };
                }
            },
            renderer(token) {
                let classes = token.classes || '';
                const iconValue = token.iconValue || '';
                const nameValue = token.nameValue || '';

                // `::: frame demo` — render the frame live AND emit a sibling
                // <pre x-code="html"> of the same source. Strip `demo` from classes.
                const isDemo = /\bframe\b/.test(classes) && /\bdemo\b/.test(classes);
                if (isDemo) classes = classes.replace(/\bdemo\b/, '').replace(/\s+/g, ' ').trim();

                // Frame callouts keep raw HTML (parsing would wrap it in <p>).
                let parsedContent;
                if (classes.includes('frame')) {
                    parsedContent = token.text;
                } else {
                    parsedContent = marked.parse(token.text);
                }

                const iconHtml = iconValue ? `<span x-icon="${escapeForAttribute(iconValue)}"></span>` : '';

                // Count top-level elements
                const temp = document.createElement('div');
                temp.innerHTML = parsedContent;
                const elementCount = temp.children.length;

                // Wrap only when there's an icon plus 2+ elements (icon needs a sibling wrapper).
                const needsWrapper = elementCount >= 2 && iconValue;
                const wrappedContent = needsWrapper ?
                    `<div>${parsedContent}</div>` :
                    parsedContent;

                const nameAttr = nameValue ? ` name="${escapeForAttribute(nameValue)}"` : '';
                const aside = `<aside${classes ? ` class="${classes}"` : ''}${nameAttr}>${iconHtml}${wrappedContent}</aside>`;
                if (isDemo) {
                    return `${aside}\n<pre x-code="html" copy${nameAttr}><code>${escapeForText(token.text.trim())}</code></pre>\n`;
                }
                return `${aside}\n`;
            }
        }]
    });

    // Configure marked to preserve custom HTML tags
    marked.setOptions({
        headerIds: false,
        mangle: false
    });
}

// Insert a newline after block HTML containers (x-code-group wrappers) so marked
// treats their contents as block markdown rather than raw inline HTML.
function renderXCodeGroup(markdown) {
    return markdown.replace(
        /(<(?:div|section|article|aside)[^>]*\bx-code-group\b[^>]*>)(?!\s*\n)/g,
        '$1\n'
    );
}

// Enable task-list checkboxes by removing marked's disabled attribute.
function enableCheckboxes(html) {
    const temp = document.createElement('div');
    temp.innerHTML = html;

    const checkboxes = temp.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
        checkbox.removeAttribute('disabled');
    });

    return temp.innerHTML;
}

// Rewrite marked codespans with a trailing `{…}` attribute list into real
// attributes (`` `cmd`{bash copy} `` → `<code x-code="bash" copy>`), so the code
// plugin wires copy / highlighting. Tokens: `copy`/`lines`/`edit` flags, a bare
// language word, `.class`, and `key=value`.
function applyInlineCodeAttributes(html) {
    // Only rewrite when `{…}` immediately follows a `</code>` (no whitespace).
    // Body capture is `[^<]*` (not `[\s\S]*?`) so it can't span `<` — without this
    // an unmatched codespan could be swallowed into a later match (notably in
    // tables). Marked escapes literal `<` in codespans, so this is safe.
    return html.replace(
        /<code>([^<]*)<\/code>\{([^}\n]+)\}/g,
        (_, body, attrString) => {
            const tokens = attrString.trim().split(/\s+/).filter(Boolean);
            let language = '';
            const classes = [];
            const flags = new Set();
            const kv = [];
            for (const tok of tokens) {
                if (tok === 'copy' || tok === 'lines' || tok === 'edit') {
                    flags.add(tok);
                } else if (tok.startsWith('.')) {
                    classes.push(tok.slice(1));
                } else if (tok.includes('=')) {
                    const [k, ...rest] = tok.split('=');
                    const v = rest.join('=').replace(/^["']|["']$/g, '');
                    kv.push([k, v]);
                } else if (/^[a-z][\w-]*$/i.test(tok) && !language) {
                    language = tok;
                }
            }
            // Only emit x-code when a language was given — `foo`{copy} is copy-only,
            // not a highlight request (an empty x-code would auto-detect and mis-colour).
            let attrs = '';
            if (language) attrs += ` x-code="${escapeForAttribute(language)}"`;
            for (const flag of flags) attrs += ` ${flag}`;
            if (classes.length) attrs += ` class="${escapeForAttribute(classes.join(' '))}"`;
            for (const [k, v] of kv) attrs += ` ${k}="${escapeForAttribute(v)}"`;
            return `<code${attrs}>${body}</code>`;
        }
    );
}

// Check if highlight.js is available
function isHighlightJsAvailable() {
    return typeof window.hljs !== 'undefined';
}





// Parse a fence's info-string into an attributes bag. Supported tokens:
//   javascript            language (first non-flag bareword)
//   "Tab name"            quoted name → name attribute (tabs / title bar)
//   lines                 line numbers gutter
//   copy                  copy button
//   edit                  CodeJar editor
//   collapse              collapse with default threshold (20 lines)
//   collapse=10           collapse to first 10 lines
//   from=#demo            pull source from referenced element
function parseLanguageString(languageString) {
    const attributes = {
        title: null,
        language: null,
        lines: false,
        copy: false,
        edit: false,
        collapse: null,   // null = not collapsible; '' = default threshold; '10' = explicit
        from: null
    };
    if (!languageString || languageString.trim() === '') return attributes;

    const parts = languageString.split(/\s+/);
    let i = 0;
    while (i < parts.length) {
        const part = parts[i];

        if (part === 'lines')   { attributes.lines = true;   i++; continue; }
        if (part === 'copy')    { attributes.copy = true;    i++; continue; }
        if (part === 'edit')    { attributes.edit = true;    i++; continue; }
        if (part === 'collapse') { attributes.collapse = ''; i++; continue; }
        if (part.startsWith('collapse=')) {
            attributes.collapse = part.slice('collapse='.length).replace(/^"|"$/g, '');
            i++; continue;
        }
        if (part.startsWith('from=')) {
            attributes.from = part.slice('from='.length).replace(/^"|"$/g, '');
            i++; continue;
        }

        // Quoted name handling — single-word "Foo" or multi-word "Foo Bar Baz"
        if (part.startsWith('"') && part.endsWith('"') && part.length > 1) {
            attributes.title = part.slice(1, -1);
            i++; continue;
        }
        if (part.startsWith('"')) {
            let fullName = part.slice(1);
            i++;
            while (i < parts.length) {
                const next = parts[i];
                if (next.endsWith('"')) {
                    fullName += ' ' + next.slice(0, -1);
                    attributes.title = fullName;
                    i++;
                    break;
                }
                fullName += ' ' + next;
                i++;
            }
            continue;
        }

        // Unrecognized bareword → treat as language (first one wins)
        if (!attributes.language) attributes.language = part;
        i++;
    }

    return attributes;
}

// Preload marked.js as soon as script loads
loadMarkedJS().catch(() => {
    // Silently ignore errors during preload
});

// Initialize plugin when either DOM is ready or Alpine is ready
async function initializeMarkdownPlugin() {
    try {
        // Load marked.js
        const marked = await loadMarkedJS();

        // Configure marked with all our custom settings
        await configureMarked(marked);

        // Configure marked to generate heading IDs
        marked.use({
            renderer: {
                heading(token) {
                    // Extract text and level from the token
                    const text = token.text || '';
                    const level = token.depth || 1;
                    const escapedText = text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '');
                    return `<h${level} id="${escapedText}">${text}</h${level}>`;
                }
            }
        });

        // Check if there are any elements with x-markdown already on the page
        const existingMarkdownElements = document.querySelectorAll('[x-markdown]');

        // Prerendered pages arrive with x-markdown content already rendered —
        // don't hide on init or the user sees a flash of empty content.
        const isPrerenderedPage = !!(
            document.querySelector('meta[name="manifest:prerendered"]') &&
            document.querySelector('meta[name="manifest:prerendered"]').getAttribute('content') !== '0'
        );

        // Register markdown directive
        // Live count of in-flight renders for the manifest:ready coordinator.
        const mdTrack = () => {
            window.__manifestMarkdownPending = (window.__manifestMarkdownPending || 0) + 1;
            return () => {
                window.__manifestMarkdownPending = Math.max(0, (window.__manifestMarkdownPending || 1) - 1);
                if (window.__manifestMarkdownPending === 0) {
                    window.dispatchEvent(new CustomEvent('manifest:markdown-idle'));
                }
            };
        };

        Alpine.directive('markdown', (el, { expression, modifiers }, { effect, evaluateLater }) => {

            // Handle null/undefined expressions gracefully
            if (!expression) {
                return;
            }

            // `.safe` runs parsed HTML through DOMPurify before injection. Default
            // is unsanitized (raw HTML + custom-element extensions); use .safe for
            // untrusted source (Appwrite, API responses, crowdsourced translations).
            const safe = Array.isArray(modifiers) && modifiers.includes('safe');

            // Prerender idempotency: baked HTML children are build-time authoritative
            // — skip the initial hide-and-re-render, but still register the effect
            // below so a dynamic expression can still update.
            const hasBakedContent = isPrerenderedPage && el.innerHTML && el.innerHTML.trim() !== '';
            if (!hasBakedContent) {
                // Hide initially to prevent flicker (live SPA)
                el.style.opacity = '0';
                el.style.transition = 'opacity 0.15s ease-in-out';
            }

            // Store original markdown content
            let markdownSource = '';
            let isUpdating = false;
            let hasContent = hasBakedContent;

            const normalizeContent = (content) => {
                const lines = content.split('\n');
                const commonIndent = lines
                    .filter(line => line.trim())
                    .reduce((min, line) => {
                        const indent = line.match(/^\s*/)[0].length;
                        return Math.min(min, indent);
                    }, Infinity);

                return lines
                    .map(line => line.slice(commonIndent))
                    .join('\n')
                    .trim();
            };

            const updateContent = async (element, newContent = null) => {
                if (isUpdating) return;
                isUpdating = true;
                const mdDone = mdTrack();

                try {
                    // Update source if new content provided
                    if (newContent !== null && newContent.trim() !== '') {
                        markdownSource = normalizeContent(newContent);
                    }

                    // Skip if no content
                    if (!markdownSource || markdownSource.trim() === '') {
                        element.style.opacity = '0';
                        return;
                    }

                    // Load marked.js and parse markdown
                    const marked = await loadMarkedJS();
                    const processedMarkdown = renderXCodeGroup(markdownSource);
                    let html = marked.parse(processedMarkdown);

                    // Post-process HTML to enable checkboxes (remove disabled attribute)
                    html = enableCheckboxes(html);

                    // Promote inline `foo`{copy} blocks to real attributes.
                    html = applyInlineCodeAttributes(html);

                    html = await maybeSanitizeMarkdownHtml(html, safe);

                    if (element.innerHTML !== html && html.trim() !== '') {
                        const temp = document.createElement('div');
                        temp.innerHTML = html;

                        // Replace the content
                        element.innerHTML = '';
                        while (temp.firstChild) {
                            element.appendChild(temp.firstChild);
                        }

                        // Notify the code plugin to scan the new subtree (added
                        // outside Alpine's initial walk).
                        if (window.ManifestCode?.observeAll) {
                            window.ManifestCode.observeAll(element);
                        }
                        document.dispatchEvent(new CustomEvent('manifest:code-blocks-converted', {
                            bubbles: true,
                            detail: { root: element }
                        }));

                        // Show element with content
                        hasContent = true;
                        element.style.opacity = '1';
                    } else if (!hasContent) {
                        // Keep hidden if no valid content
                        element.style.opacity = '0';
                    }
                } finally {
                    isUpdating = false;
                    mdDone();
                }
            };

            // Handle inline markdown content (no expression or 'inline')
            if (!expression || expression === 'inline') {
                // Initial parse
                markdownSource = normalizeContent(el.textContent);
                updateContent(el);

                // Set up mutation observer for streaming content
                const observer = new MutationObserver((mutations) => {
                    let newContent = null;

                    for (const mutation of mutations) {
                        if (mutation.type === 'childList') {
                            const textNodes = Array.from(el.childNodes)
                                .filter(node => node.nodeType === Node.TEXT_NODE);
                            if (textNodes.length > 0) {
                                newContent = textNodes.map(node => node.textContent).join('');
                                break;
                            }
                        } else if (mutation.type === 'characterData') {
                            newContent = mutation.target.textContent;
                            break;
                        }
                    }

                    if (newContent && newContent.trim() !== '') {
                        updateContent(el, newContent);
                    }
                });

                observer.observe(el, {
                    characterData: true,
                    childList: true,
                    subtree: true,
                    characterDataOldValue: true
                });

                return;
            }

            // Prerendered MPA pages with baked content are already correct — skip
            // the effect (MPA navigation is full page loads).
            if (hasBakedContent) {
                return;
            }

            // Classify the source: real expressions evaluate; bare markdown/paths
            // are quoted so Alpine doesn't choke on them.
            const trimmed = expression.trim();
            const isExplicitExpression = trimmed.includes('+') || trimmed.includes('`') || trimmed.includes('${') ||
                trimmed.startsWith('$') || trimmed.startsWith("'") || trimmed.startsWith('"');
            const looksLikePath = /\.(md|markdown)([?#]|$)/i.test(trimmed) || /^[\w./-]*\/[\w./-]*$/.test(trimmed);
            const isMemberChain = !looksLikePath &&
                /^[A-Za-z_$][\w$]*(\s*(\?\.|\.)\s*[A-Za-z_$][\w$]*|\s*\[[^\]]*\]|\s*\([^()]*\))+$/.test(trimmed);
            const isBareIdentifier = !looksLikePath && /^[A-Za-z_$][\w$]*$/.test(trimmed);

            let processedExpression = expression;
            if (!isExplicitExpression) {
                if (isMemberChain) {
                    // e.g. m.body.text — evaluate; undefined mid-chain (data still
                    // loading) resolves to undefined instead of throwing.
                    processedExpression = `(() => { try { return ${trimmed} } catch (_) { return undefined } })()`;
                } else if (isBareIdentifier) {
                    // e.g. t — scope variable if defined, else literal one-word markdown
                    processedExpression = `(typeof ${trimmed} === 'undefined' ? '${trimmed}' : ${trimmed})`;
                } else {
                    // inline markdown or file path — quote as literal
                    processedExpression = `'${expression.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
                }
            }
            const getMarkdownContent = evaluateLater(processedExpression);

            // Track last processed content to prevent unnecessary re-renders
            let lastProcessedContent = null;

            effect(() => {
                getMarkdownContent(async (pathOrContent) => {
                    const mdDone = mdTrack();
                    try {
                    // Reset visibility if content is empty/undefined
                    if (!pathOrContent || pathOrContent === undefined || pathOrContent === '') {
                        el.style.opacity = '0';
                        hasContent = false;
                        return;
                    }

                    if (pathOrContent === undefined) {
                        pathOrContent = expression;
                    }

                    // Path = single whitespace-free token: .md/.markdown file, or a
                    // slash path of plain word chars. Evaluated content (chat
                    // messages etc.) with slashes or extensions inside prose stays prose.
                    const isFilePath = typeof pathOrContent === 'string' &&
                        !/\s/.test(pathOrContent) &&
                        (/\.(md|markdown)([?#]|$)/i.test(pathOrContent) ||
                            /^[\w./-]*\/[\w./-]*$/.test(pathOrContent));

                    let markdownContent = pathOrContent;

                    // If it's a file path, fetch the content (with caching)
                    if (isFilePath) {
                        try {
                            // Resolve path: relative paths are relative to manifest base (project root), not document root
                            let resolvedPath = pathOrContent;
                            if (!pathOrContent.startsWith('/')) {
                                const base = (typeof window.getManifestBase === 'function' ? window.getManifestBase() : '') || '';
                                const basePath = base.replace(/\/$/, '') || '';
                                resolvedPath = (basePath ? basePath + '/' : '/') + pathOrContent;
                            }

                            // Check cache first
                            if (markdownCache.has(resolvedPath)) {
                                markdownContent = markdownCache.get(resolvedPath);
                            } else {
                                const response = await fetch(resolvedPath);
                                if (response.ok) {
                                    markdownContent = await response.text();
                                    // Cache the content
                                    markdownCache.set(resolvedPath, markdownContent);
                                } else {
                                    console.warn(`[Manifest] Failed to fetch markdown file: ${resolvedPath}`);
                                    markdownContent = `# Error Loading Content\n\nCould not load: ${resolvedPath}`;
                                    // Cache error content too to prevent repeated failed requests
                                    markdownCache.set(resolvedPath, markdownContent);
                                }
                            }
                        } catch (error) {
                            console.error(`[Manifest] Error fetching markdown file: ${pathOrContent}`, error);
                            markdownContent = `# Error Loading Content\n\nCould not load: ${pathOrContent}\n\nError: ${error.message}`;
                            // Cache error content to prevent repeated failed requests
                            if (resolvedPath) {
                                markdownCache.set(resolvedPath, markdownContent);
                            }
                        }
                    }

                    // Content unchanged: skip re-render but restore visibility — a
                    // dev-reload can transiently push opacity to 0 while innerHTML is intact.
                    if (markdownContent === lastProcessedContent) {
                        if (el.innerHTML && el.innerHTML.trim() !== '') {
                            hasContent = true;
                            el.style.opacity = '1';
                        }
                        return;
                    }
                    lastProcessedContent = markdownContent;

                    // Ensure we have a string (e.g. $route('path')?.content can be a proxy while loading)
                    const contentStr = typeof markdownContent === 'string' ? markdownContent : '';
                    if (!contentStr || contentStr.trim() === '') {
                        el.style.opacity = '0';
                        hasContent = false;
                        return;
                    }

                    const marked = await loadMarkedJS();
                    let html = marked.parse(contentStr);

                    // Post-process HTML to enable checkboxes (remove disabled attribute)
                    html = enableCheckboxes(html);

                    // Promote inline `foo`{copy} blocks to real attributes.
                    html = applyInlineCodeAttributes(html);

                    html = await maybeSanitizeMarkdownHtml(html, safe);

                    if (el.innerHTML !== html) {
                        // Create temporary container
                        const temp = document.createElement('div');
                        temp.innerHTML = html;

                        el.innerHTML = '';
                        while (temp.firstChild) {
                            el.appendChild(temp.firstChild);
                        }

                        // Ensure Alpine processes the newly inserted HTML
                        if (window.Alpine && typeof window.Alpine.initTree === 'function') {
                            if (window.Alpine.nextTick) {
                                window.Alpine.nextTick(() => {
                                    window.Alpine.initTree(el);
                                });
                            } else {
                                setTimeout(() => {
                                    window.Alpine.initTree(el);
                                }, 0);
                            }
                        }
                    }

                    // Code highlighting is handled by manifest.code.js plugin

                    // Show content with fade-in
                    hasContent = true;
                    el.style.opacity = '1';

                    // Extract headings for anchor links
                    const headings = [];
                    const headingElements = el.querySelectorAll('h1, h2, h3');
                    headingElements.forEach(heading => {
                        headings.push({
                            id: heading.id,
                            text: heading.textContent,
                            level: parseInt(heading.tagName.charAt(1))
                        });
                    });

                    // Store headings in Alpine data if 'headings' modifier is used
                    if (modifiers.includes('headings')) {
                        // Generate a unique ID for this markdown section
                        const sectionId = 'markdown-' + Math.random().toString(36).substr(2, 9);
                        el.setAttribute('data-headings-section', sectionId);

                        // Store headings in a global registry
                        if (!window._manifestHeadings) {
                            window._manifestHeadings = {};
                        }
                        window._manifestHeadings[sectionId] = headings;
                    }
                    } finally {
                        mdDone();
                    }
                });
            });
        });

        // If there are existing elements with x-markdown, manually process them with proper Alpine context
        if (existingMarkdownElements.length > 0) {

            existingMarkdownElements.forEach(el => {
                const expression = el.getAttribute('x-markdown');

                // Create a temporary Alpine component context for this element
                const tempComponent = Alpine.$data(el) || {};

                // Use Alpine's evaluation system within the component context
                const updateContent = async (element, newContent = null) => {
                    try {
                        if (!newContent) {
                            return;
                        }

                        // Load marked.js and parse markdown
                        const marked = await loadMarkedJS();
                        const processedMarkdown = renderXCodeGroup(newContent);
                        let html = marked.parse(processedMarkdown);

                        // Post-process HTML to enable checkboxes (remove disabled attribute)
                        html = html.replace(/<input type="checkbox"([^>]*?)disabled([^>]*?)>/g, '<input type="checkbox"$1$2>');

                        // Apply opt-in DOMPurify sanitization for x-markdown.safe
                        html = await maybeSanitizeMarkdownHtml(html, safe);

                        // Create temporary container
                        const temp = document.createElement('div');
                        temp.innerHTML = html;

                        element.innerHTML = '';
                        while (temp.firstChild) {
                            element.appendChild(temp.firstChild);
                        }

                        // Let Alpine process the inserted HTML (needed for $x.* exprs);
                        // wait briefly for magic methods, but proceed if not ready.
                        const initAlpine = (retryCount = 0) => {
                            if (!window.Alpine || typeof window.Alpine.initTree !== 'function') {
                                if (retryCount < 5) {
                                    setTimeout(() => initAlpine(retryCount + 1), 50);
                                }
                                return;
                            }

                            // Check if $x magic method is available
                            const xMagic = window.Alpine?.magic?.('x');
                            const hasXMagic = typeof xMagic === 'function';

                            // If magic method isn't ready, wait briefly but don't block forever
                            if (!hasXMagic && retryCount < 5) {
                                setTimeout(() => initAlpine(retryCount + 1), 50);
                                return;
                            }

                            // Use Alpine.nextTick if available, otherwise setTimeout
                            const scheduleInit = (fn) => {
                                if (window.Alpine?.nextTick) {
                                    window.Alpine.nextTick(fn);
                                } else {
                                    setTimeout(fn, 0);
                                }
                            };

                            scheduleInit(() => {
                                try {
                                    window.Alpine.initTree(element);
                                } catch (e) {
                                    console.error('[Manifest Markdown] Error initializing Alpine tree (updateContent):', e);
                                }
                            });
                        };

                        // Start initialization
                        initAlpine();

                        // Re-highlight code blocks after content update
                        // Code highlighting is handled by manifest.code.js plugin
                    } catch (error) {
                        console.error('[Manifest Markdown] Failed to process element:', error);
                    }
                };

                // Handle simple string expressions
                if (expression.startsWith("'") && expression.endsWith("'")) {
                    const content = expression.slice(1, -1);
                    updateContent(el, content);
                } else {
                    // Complex expressions: remove + re-add the attribute to force
                    // Alpine to re-process once the directive is registered.
                    const originalExpression = expression;
                    el.removeAttribute('x-markdown');

                    setTimeout(() => {
                        el.setAttribute('x-markdown', originalExpression);
                    }, 50);
                }
            });
        }

    } catch (error) {
        console.error('[Manifest] Failed to initialize markdown plugin:', error);
    }
}

// Track initialization to prevent duplicates
let markdownPluginInitialized = false;

// True once Alpine finished its initial DOM walk; listener bound at module load.
let markdownAlpineHasWalked = false;
document.addEventListener('alpine:initialized', () => { markdownAlpineHasWalked = true; });

async function ensureMarkdownPluginInitialized() {
    if (markdownPluginInitialized) {
        return;
    }
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') {
        return;
    }

    markdownPluginInitialized = true;
    await initializeMarkdownPlugin();

    // Only walk existing subtrees ourselves when Alpine already finished its boot
    // walk (late load). Walking during boot would drop nested plugin content.
    if (markdownAlpineHasWalked && typeof window.Alpine.initTree === 'function') {
        const existingMarkdownElements = document.querySelectorAll('[x-markdown]');
        existingMarkdownElements.forEach(el => {
            if (!el.__x) {
                window.Alpine.initTree(el);
            }
        });
    }
}

// Expose on window for loader to call if needed
window.ensureMarkdownPluginInitialized = ensureMarkdownPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureMarkdownPluginInitialized);
}

document.addEventListener('alpine:init', ensureMarkdownPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    ensureMarkdownPluginInitialized();
} 

})();
