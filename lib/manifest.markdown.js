/* Manifest Markdown */

// Cache for marked.js loading
let markedPromise = null;

// Cache for fetched markdown files to prevent duplicate requests
const markdownCache = new Map();

// Invalidate the markdown fetch cache when mnfst-run signals a data file
// changed on disk. Without this, a saved .md file is re-read by the data
// plugin but x-markdown still serves the old content from cache; combined
// with the lastProcessedContent short-circuit in the directive's effect,
// the article appears blank until the user manually reloads.
if (typeof window !== 'undefined') {
    window.addEventListener('manifest:dev-reload', () => {
        markdownCache.clear();
    });
}

// DOMPurify config tuned for Manifest's markdown output. The markdown
// extensions emit <x-icon> custom elements and `x-*` directive attributes that must
// survive sanitization, so custom-element handling is enabled with a
// tag-name allowlist (x-*) and an attribute filter that rejects event
// handlers (on*). DOMPurify's defaults handle <script>, javascript: URLs,
// srcdoc, and the usual XSS vectors for standard HTML tags.
const MARKDOWN_PURIFY_CONFIG = {
    CUSTOM_ELEMENT_HANDLING: {
        tagNameCheck: /^x-[a-z][\w-]*$/,
        attributeNameCheck: /^(?!on)[a-z][\w\-:]*$/i,
        allowCustomizedBuiltInElements: false
    }
};

// DOMPurify loader is defined on window by whichever of svg/markdown loads
// first (see manifest.svg.js). Declaring `let purifyPromise` here at top
// level collides with svg.js's identical declaration in the realm's shared
// global lexical environment, so we use the shared loader instead.
if (!window.ManifestDOMPurify) {
    window.ManifestDOMPurify = {
        _promise: null,
        load() {
            if (typeof window.DOMPurify !== 'undefined') return Promise.resolve(window.DOMPurify);
            if (this._promise) return this._promise;
            this._promise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://cdn.jsdelivr.net/npm/dompurify@latest/dist/purify.min.js';
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

// Sanitize HTML if the .safe modifier was used; pass-through otherwise.
// Manifest's default is unsanitized so authors can render arbitrary HTML and
// the markdown custom-element extensions work — but the .safe opt-in lets
// authors render data-source content (e.g. user-submitted markdown from
// Appwrite) without an XSS sink.
async function maybeSanitizeMarkdownHtml(html, safe) {
    if (!safe) return html;
    try {
        const DOMPurify = await window.ManifestDOMPurify.load();
        return DOMPurify.sanitize(html, MARKDOWN_PURIFY_CONFIG);
    } catch {
        // Loader failure — fall back to escaping rather than silently emitting
        // un-sanitized HTML. The author asked for safe; honour that.
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
        script.src = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
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

// HTML-escape a string for safe interpolation inside an attribute value.
// Used by the code-fence renderer below — title/language strings come from
// the markdown source, so without escaping a fence like ```js " onclick=alert(1) x="
// could inject arbitrary attributes onto the <pre> element.
function escapeForAttribute(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Escape a literal HTML fragment so it displays as source text when placed
// inside a <code> element. Used for the ::: frame demo modifier, where the
// same content is rendered live AND shown below as its own source.
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
            // Render fenced code blocks as <pre x-code="…"><code>…</code></pre>.
            // The code plugin's directive then handles highlighting, copy
            // buttons, collapse, line numbers, etc. — same code path whether
            // the block was authored in HTML or markdown.
            code(token) {
                const lang = token.lang || '';
                const text = token.text || '';

                const attrs = parseLanguageString(lang);

                let preAttrs = '';
                // x-code carries the language as its value (empty string for
                // "no explicit language; auto-detect")
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

                // Escape the fence body before injection. Newer marked versions
                // pass `token.text` raw, and if we leave it unescaped an HTML
                // fence like ```html <script>…</script>``` becomes a live
                // element in the document instead of source text. Escaping
                // here keeps the <code> body as pure text — the code plugin's
                // resolveSource reads textContent which decodes the entities
                // back to the original source.
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

                // Parse the opening line for classes, icon, and an optional
                // quoted name. The name follows the same convention as the
                // fenced-code info-string (`::: frame "header.html"`) — it
                // becomes the `name` attribute on the rendered <aside>, which
                // lets the code plugin pair the frame with a fenced block
                // sharing the same name inside an <x-code-group>.
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

                // `::: frame demo` — render the frame contents live AND emit
                // a sibling <pre x-code="html"> showing the same source. Lets
                // authors write the example once and have it both rendered
                // and documented. Strip `demo` from the class list so the
                // resulting <aside> has just `frame`.
                const isDemo = /\bframe\b/.test(classes) && /\bdemo\b/.test(classes);
                if (isDemo) classes = classes.replace(/\bdemo\b/, '').replace(/\s+/g, ' ').trim();

                // For frame callouts, don't parse as markdown to avoid wrapping HTML in <p> tags
                let parsedContent;
                if (classes.includes('frame')) {
                    // Use raw content for frame callouts to preserve HTML structure
                    parsedContent = token.text;
                } else {
                    // Parse the content as markdown to support nested markdown syntax
                    parsedContent = marked.parse(token.text);
                }

                const iconHtml = iconValue ? `<span x-icon="${escapeForAttribute(iconValue)}"></span>` : '';

                // Create a temporary div to count top-level elements
                const temp = document.createElement('div');
                temp.innerHTML = parsedContent;
                const elementCount = temp.children.length;

                // Only wrap in a div if:
                // 1. There are 2 or more elements AND
                // 2. There's an icon (which needs the content to be wrapped as a sibling)
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

// Markdown preprocessor: ensure that block-level HTML containers (the
// wrappers authors use to group fenced code blocks into tabs, frames, etc.)
// have a blank line after their opening tag so marked treats the contents
// as block-level markdown rather than raw inline HTML. Without this, a
// fenced ```js immediately after `<div x-code-group>` is treated as text.
function renderXCodeGroup(markdown) {
    return markdown.replace(
        /(<(?:div|section|article|aside)[^>]*\bx-code-group\b[^>]*>)(?!\s*\n)/g,
        '$1\n'
    );
}

// Post-process HTML to enable checkboxes by removing disabled attribute
function enableCheckboxes(html) {
    // Create a temporary DOM element to parse the HTML
    const temp = document.createElement('div');
    temp.innerHTML = html;

    // Find all checkbox inputs and remove disabled attribute
    const checkboxes = temp.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach(checkbox => {
        checkbox.removeAttribute('disabled');
    });

    return temp.innerHTML;
}

// Apply trailing `{…}` attribute lists to inline `<code>` elements emitted
// by marked. Authors write ``` `npm i mnfst`{copy} ``` or ``` `code`{bash copy} ```
// in markdown; marked's default codespan handling drops the trailing brace
// block as literal text. We rewrite it post-parse so the code plugin's
// directive sees the attributes and wires copy / syntax highlighting.
//
// Supported tokens inside the braces:
//   copy                        → adds the `copy` attribute (click-to-copy)
//   <language>                  → bareword like `bash`, `js`, `html` becomes
//                                 the `x-code="…"` value (drives highlighting)
//   .class                      → appended to the element's class list
//   key=value, key="quoted"     → arbitrary attribute (rarely needed)
//
// Multiple tokens separate by whitespace: `cmd`{bash copy} works.
function applyInlineCodeAttributes(html) {
    // marked emits `<code>…</code>` for codespans (no attributes). When we see
    // `<code>X</code>{tokens}` we rewrite into `<code x-code[=lang] tokens>X</code>`.
    // Be conservative: only rewrite when the brace block immediately follows
    // a `<code>` close tag (no whitespace), so prose like "foo `bar` {note}" is
    // untouched.
    return html.replace(
        /<code>([\s\S]*?)<\/code>\{([^}\n]+)\}/g,
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
            let attrs = ` x-code="${escapeForAttribute(language)}"`;
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

        // Detect whether this page was produced by the prerender.  On
        // prerendered pages, x-markdown elements arrive with their content
        // already rendered to HTML — we must NOT hide them on init or the
        // user sees a flash of empty content while the plugin re-fetches.
        const isPrerenderedPage = !!(
            document.querySelector('meta[name="manifest:prerendered"]') &&
            document.querySelector('meta[name="manifest:prerendered"]').getAttribute('content') !== '0'
        );

        // Register markdown directive
        Alpine.directive('markdown', (el, { expression, modifiers }, { effect, evaluateLater }) => {

            // Handle null/undefined expressions gracefully
            if (!expression) {
                return;
            }

            // Opt-in sanitization. When `.safe` is on the directive
            // (`x-markdown.safe="$x.user.bio"`), parsed HTML is run through
            // DOMPurify before injection. Default is unsanitized — Manifest's
            // design lets authors render raw HTML and custom-element extensions
            // (x-icon, callouts) and directive attributes (x-code, etc.) freely.
            // Use .safe when the markdown
            // source can contain content from untrusted parties (Appwrite
            // collections, API responses, crowdsourced translations, etc.).
            const safe = Array.isArray(modifiers) && modifiers.includes('safe');

            // Prerender idempotency: if the page is a prerendered MPA and this
            // element already has rendered HTML children, the content was baked
            // at build time and is authoritative for SEO + no-JS users.  Skip
            // the initial hide-and-re-render step entirely.  We still register
            // the reactive effect below so the content can update if its
            // expression is dynamic and later changes (e.g. via $route).
            const hasBakedContent = isPrerenderedPage && el.innerHTML && el.innerHTML.trim() !== '';
            if (!hasBakedContent) {
                // Hide element initially to prevent flicker (live SPA behaviour)
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

                    // Promote inline code attribute blocks (`foo`{copy}) to
                    // real attributes so the code plugin can wire copy/highlight.
                    html = applyInlineCodeAttributes(html);

                    // Apply opt-in DOMPurify sanitization for x-markdown.safe
                    html = await maybeSanitizeMarkdownHtml(html, safe);

                    // Only update if content has changed and isn't empty
                    if (element.innerHTML !== html && html.trim() !== '') {
                        // Create a temporary container to hold the HTML
                        const temp = document.createElement('div');
                        temp.innerHTML = html;

                        // Replace the content
                        element.innerHTML = '';
                        while (temp.firstChild) {
                            element.appendChild(temp.firstChild);
                        }

                        // Notify the code plugin to scan the new subtree —
                        // fenced blocks and `inline`{copy} elements are added
                        // outside Alpine's initial walk and won't otherwise
                        // be picked up by the IntersectionObserver.
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

            // Prerender idempotency: on prerendered MPA pages with baked content,
            // the x-markdown element is already correct — skip the reactive effect
            // entirely.  Navigation on MPA is full page loads, so there's no
            // dynamic re-resolution to handle; each route serves its own prerendered
            // HTML with the right baked content.
            if (hasBakedContent) {
                return;
            }

            // Handle expressions (file paths, inline strings, content references)
            // Check if this is a simple string literal that needs to be quoted
            let processedExpression = expression;
            if (!expression.includes('+') && !expression.includes('`') && !expression.includes('${') &&
                !expression.startsWith('$') && !expression.startsWith("'") && !expression.startsWith('"')) {
                // Wrap simple string literals in quotes to prevent Alpine from treating them as expressions
                processedExpression = `'${expression.replace(/'/g, "\\'")}'`;
            }
            const getMarkdownContent = evaluateLater(processedExpression);

            // Track last processed content to prevent unnecessary re-renders
            let lastProcessedContent = null;

            effect(() => {
                getMarkdownContent(async (pathOrContent) => {
                    // Reset visibility if content is empty/undefined
                    if (!pathOrContent || pathOrContent === undefined || pathOrContent === '') {
                        el.style.opacity = '0';
                        hasContent = false;
                        return;
                    }

                    if (pathOrContent === undefined) {
                        pathOrContent = expression;
                    }

                    // Check if this looks like a file path (contains .md, .markdown, or starts with /)
                    const isFilePath = typeof pathOrContent === 'string' &&
                        (pathOrContent.includes('.md') ||
                            pathOrContent.includes('.markdown') ||
                            pathOrContent.startsWith('/') ||
                            pathOrContent.includes('/'));

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

                    // Skip re-render if content hasn't changed, but still restore
                    // visibility — during a dev-reload the data plugin briefly
                    // clears its source cache, which makes the expression
                    // resolve to undefined and pushes opacity to 0; if we
                    // early-return here without restoring it, the article stays
                    // hidden even though innerHTML is intact.
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

                    // Promote inline code attribute blocks (`foo`{copy}) to
                    // real attributes so the code plugin can wire copy/highlight.
                    html = applyInlineCodeAttributes(html);

                    // Apply opt-in DOMPurify sanitization for x-markdown.safe
                    html = await maybeSanitizeMarkdownHtml(html, safe);

                    // Only update DOM if HTML actually changed
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

                        // Ensure Alpine processes the newly inserted HTML
                        // This is critical for data source expressions like $x.projects
                        // Try to wait for magic methods, but proceed anyway if not ready
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
                    // For complex expressions, we need to force Alpine to re-process this element

                    // Remove and re-add the attribute to force Alpine to re-process it
                    const originalExpression = expression;
                    el.removeAttribute('x-markdown');

                    // Use a small delay to ensure the directive is registered
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

async function ensureMarkdownPluginInitialized() {
    if (markdownPluginInitialized) {
        return;
    }
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') {
        return;
    }

    markdownPluginInitialized = true;
    await initializeMarkdownPlugin();

    // If elements with x-markdown already exist, process them
    // This handles the case where the plugin loads after components are swapped in
    if (window.Alpine && typeof window.Alpine.initTree === 'function') {
        const existingMarkdownElements = document.querySelectorAll('[x-markdown]');
        existingMarkdownElements.forEach(el => {
            // Only process if not already processed by Alpine
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