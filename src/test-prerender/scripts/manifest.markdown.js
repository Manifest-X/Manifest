/* Manifest Markdown */

// Cache for marked.js loading
let markedPromise = null;

// Cache for fetched markdown files to prevent duplicate requests
const markdownCache = new Map();

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

// Configure marked to preserve full language strings
async function configureMarked(marked) {
    marked.use({
        renderer: {
            code(token) {
                const lang = token.lang || '';
                const text = token.text || '';
                const escaped = token.escaped || false;

                // Parse the language string to extract attributes
                const attributes = parseLanguageString(lang);

                // Build attributes for the x-code element
                let xCodeAttributes = '';
                if (attributes.title) {
                    xCodeAttributes += ` name="${attributes.title}"`;
                }
                if (attributes.language) {
                    xCodeAttributes += ` language="${attributes.language}"`;
                }
                if (attributes.numbers) {
                    xCodeAttributes += ' numbers';
                }
                if (attributes.copy) {
                    xCodeAttributes += ' copy';
                }

                // For x-code elements, use the raw text to preserve formatting
                let code = text;
                let preserveOriginal = '';

                // For HTML language code blocks, preserve the original raw text to maintain indentation
                if (attributes.language === 'html' || text.includes('<!DOCTYPE') || (text.includes('<html') && text.includes('<head') && text.includes('<body'))) {
                    // Store the original content in a data attribute to preserve indentation
                    preserveOriginal = ` data-original-content="${text.replace(/"/g, '&quot;')}"`;
                }

                // Always create an x-code element, with or without attributes
                return `<x-code${xCodeAttributes}${preserveOriginal}>${code}</x-code>\n`;
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

                // Parse the opening line for classes and icon
                const openingLine = openMatch[1].trim();
                let classes = '';
                let iconValue = '';

                // Match icon="value" pattern
                const iconMatch = openingLine.match(/icon="([^"]+)"/);
                if (iconMatch) {
                    iconValue = iconMatch[1];
                }

                // Get all class names (remove icon attribute first)
                classes = openingLine.replace(/\s*icon="[^"]+"\s*/, '').trim();

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
                        text: content.trim()
                    };
                }
            },
            renderer(token) {
                const classes = token.classes || '';
                const iconValue = token.iconValue || '';

                // For frame callouts, don't parse as markdown to avoid wrapping HTML in <p> tags
                let parsedContent;
                if (classes.includes('frame')) {
                    // Use raw content for frame callouts to preserve HTML structure
                    parsedContent = token.text;
                } else {
                    // Parse the content as markdown to support nested markdown syntax
                    parsedContent = marked.parse(token.text);
                }

                const iconHtml = iconValue ? `<span x-icon="${iconValue}"></span>` : '';

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

                return `<aside${classes ? ` class="${classes}"` : ''}>${iconHtml}${wrappedContent}</aside>\n`;
            }
        }]
    });

    // Configure marked to preserve custom HTML tags
    marked.setOptions({
        headerIds: false,
        mangle: false
    });
}

// Custom renderer for x-code-group to handle line breaks properly
function renderXCodeGroup(markdown) {
    // Find x-code-group blocks and process them specially
    const xCodeGroupRegex = /<x-code-group[^>]*>([\s\S]*?)<\/x-code-group>/g;

    return markdown.replace(xCodeGroupRegex, (match, content) => {
        // Ensure there's a line break after the opening tag if there isn't one
        const processedContent = content.replace(/^(?!\s*\n)/, '\n');

        return `<x-code-group>${processedContent}</x-code-group>`;
    });
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

// Check if highlight.js is available
function isHighlightJsAvailable() {
    return typeof window.hljs !== 'undefined';
}





// Parse language string to extract title and attributes
function parseLanguageString(languageString) {
    if (!languageString || languageString.trim() === '') {
        return { title: null, language: null, numbers: false, copy: false };
    }

    const parts = languageString.split(/\s+/);

    const attributes = {
        title: null,
        language: null,
        numbers: false,
        copy: false
    };

    let i = 0;
    while (i < parts.length) {
        const part = parts[i];

        // Check for attributes
        if (part === 'numbers') {
            attributes.numbers = true;
            i++;
            continue;
        }

        if (part === 'copy') {
            attributes.copy = true;
            i++;
            continue;
        }

        // Check for quoted names (e.g., "Example")
        if (part.startsWith('"') && part.endsWith('"')) {
            // Single word quoted name
            attributes.title = part.slice(1, -1);
            i++;
            continue;
        } else if (part.startsWith('"')) {
            // Multi-word quoted name
            let fullName = part.slice(1);
            i++;
            while (i < parts.length) {
                const nextPart = parts[i];
                if (nextPart.endsWith('"')) {
                    fullName += ' ' + nextPart.slice(0, -1);
                    attributes.title = fullName;
                    i++;
                    break;
                } else {
                    fullName += ' ' + nextPart;
                    i++;
                }
            }
            continue;
        }

        // Store language identifiers (e.g., "css", "javascript", etc.)
        // Use the first language identifier found
        if (!attributes.language) {
            attributes.language = part;
        }
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

                    // Skip if content hasn't changed (prevents unnecessary re-renders)
                    if (markdownContent === lastProcessedContent) {
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