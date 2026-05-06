/*  Manifest Code
/*  By Andrew Matlock under MIT license
/*  https://github.com/andrewmatlock/Manifest
/*
/*  With reference to:
/*  - highlight.js (https://highlightjs.org)
/*  - Marked JS (https://marked.js.org)
/*
/*  Requires Alpine JS (alpinejs.dev) to operate.
*/

// Cache for highlight.js loading
let hljsPromise = null;

// Load highlight.js from CDN
async function loadHighlightJS() {
    if (typeof hljs !== 'undefined') {
        return hljs;
    }

    // Return existing promise if already loading
    if (hljsPromise) {
        return hljsPromise;
    }

    hljsPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.11.1/build/highlight.min.js';
        script.onload = () => {
            // Initialize highlight.js
            if (typeof hljs !== 'undefined') {
                resolve(hljs);
            } else {
                console.error('[Manifest Code] Highlight.js failed to load - hljs is undefined');
                hljsPromise = null; // Reset so we can try again
                reject(new Error('highlight.js failed to load'));
            }
        };
        script.onerror = (error) => {
            console.error('[Manifest Code] Script failed to load:', error);
            hljsPromise = null; // Reset so we can try again
            reject(error);
        };
        document.head.appendChild(script);
    });

    return hljsPromise;
}

// Optional optimization: Configure utilities plugin if present
if (window.ManifestUtilities) {
    // Tell utilities plugin to ignore code-related DOM changes and classes
    window.ManifestUtilities.addIgnoredClassPattern(/^hljs/);
    window.ManifestUtilities.addIgnoredClassPattern(/^language-/);
    window.ManifestUtilities.addIgnoredClassPattern(/^copy$/);
    window.ManifestUtilities.addIgnoredClassPattern(/^copied$/);
    window.ManifestUtilities.addIgnoredClassPattern(/^lines$/);
    window.ManifestUtilities.addIgnoredClassPattern(/^selected$/);

    window.ManifestUtilities.addIgnoredElementSelector('pre');
    window.ManifestUtilities.addIgnoredElementSelector('code');
    window.ManifestUtilities.addIgnoredElementSelector('x-code');
    window.ManifestUtilities.addIgnoredElementSelector('x-code-group');
}

// Process existing pre/code blocks
async function processExistingCodeBlocks() {
    try {
        const hljs = await loadHighlightJS();

        // Find all pre > code blocks that aren't already processed
        // Exclude elements with frame class but allow those inside asides (frames)
        const codeBlocks = document.querySelectorAll('pre > code:not(.hljs):not([data-highlighted="yes"]):not(.frame)');

        for (const codeBlock of codeBlocks) {
            try {

                // Skip if the element contains HTML (has child elements)
                if (codeBlock.children.length > 0) {
                    continue;
                }

                // Skip if the content looks like HTML (contains tags)
                let content = codeBlock.textContent || '';
                if (content.includes('<') && content.includes('>') && content.includes('</')) {
                    // This looks like HTML content, skip highlighting to avoid security warnings
                    continue;
                }

                // Special handling for frames - clean up content
                const isInsideFrame = codeBlock.closest('aside');
                if (isInsideFrame) {
                    // Remove leading empty lines and whitespace
                    content = content.replace(/^\s*\n+/, '');
                    // Remove trailing empty lines and whitespace
                    content = content.replace(/\n+\s*$/, '');
                    // Also trim any remaining leading/trailing whitespace
                    content = content.trim();
                    // Update the code block content
                    codeBlock.textContent = content;
                }

                const pre = codeBlock.parentElement;

                // Add title if present
                if (pre.hasAttribute('name') || pre.hasAttribute('title')) {
                    const title = pre.getAttribute('name') || pre.getAttribute('title');
                    const header = document.createElement('header');

                    const titleElement = document.createElement('div');
                    titleElement.textContent = title;
                    header.appendChild(titleElement);

                    pre.insertBefore(header, codeBlock);
                }

                // Add line numbers if requested
                if (pre.hasAttribute('numbers')) {
                    const codeText = codeBlock.textContent;
                    const lines = codeText.split('\n');

                    const linesContainer = document.createElement('div');
                    linesContainer.className = 'lines';

                    for (let i = 0; i < lines.length; i++) {
                        const lineSpan = document.createElement('span');
                        lineSpan.textContent = (i + 1).toString();
                        linesContainer.appendChild(lineSpan);
                    }

                    pre.insertBefore(linesContainer, codeBlock);
                }

                // Check if element has a supported language class
                const languageMatch = codeBlock.className.match(/language-(\w+)/);
                if (languageMatch) {
                    const language = languageMatch[1];

                    // Skip non-programming languages
                    if (language === 'frame') {
                        continue;
                    }

                    const supportedLanguages = hljs.listLanguages();
                    const languageAliases = {
                        'js': 'javascript',
                        'ts': 'typescript',
                        'py': 'python',
                        'rb': 'ruby',
                        'sh': 'bash',
                        'yml': 'yaml'
                    };

                    let actualLanguage = language;
                    if (languageAliases[language]) {
                        actualLanguage = languageAliases[language];
                        // Update the class name to use the correct language
                        codeBlock.className = codeBlock.className.replace(`language-${language}`, `language-${actualLanguage}`);
                    }

                    // Only highlight if the language is supported
                    if (!supportedLanguages.includes(actualLanguage)) {
                        // Skip unsupported languages instead of warning
                        continue;
                    }
                } else {
                    // Add default language class if not present
                    codeBlock.className += ' language-css'; // Default to CSS for the example
                }

                // Highlight the code block
                hljs.highlightElement(codeBlock);

            } catch (error) {
                console.warn('[Manifest] Failed to process code block:', error);
            }
        }
    } catch (error) {
        console.warn('[Manifest] Failed to process existing code blocks:', error);
    }
}

// Initialize plugin when either DOM is ready or Alpine is ready
function initializeCodePlugin() {
    // Configuration object for the code plugin
    const config = {
        // Auto-highlight all code blocks
        autoHighlight: true,
        // Enable line numbers by default
        lineNumbers: false,
        // Show titles by default
        showTitles: true
    };

    // X-Code-Group custom element for tabbed code blocks
    class XCodeGroupElement extends HTMLElement {
        constructor() {
            super();
        }

        static get observedAttributes() {
            return ['numbers', 'copy'];
        }

        get numbers() {
            return this.hasAttribute('numbers');
        }

        get copy() {
            return this.hasAttribute('copy');
        }

        connectedCallback() {
            // Small delay to ensure x-code elements are initialized
            setTimeout(() => {
                this.setupCodeGroup();
            }, 0);
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue !== newValue) {
                if (name === 'numbers' || name === 'copy') {
                    this.updateAttributes();
                }
            }
        }

        setupCodeGroup() {
            // Idempotency: if a tab header is already present (from prerender output
            // or a previous connection), skip rebuilding it.  Otherwise the DOM ends
            // up with a doubled tab row when the static page rehydrates.
            if (this.querySelector(':scope > header[aria-label="Code examples"]')) {
                return;
            }

            // Find all x-code elements within this group
            const codeElements = this.querySelectorAll('x-code');

            if (codeElements.length === 0) {
                return;
            }

            // Set default tab to first named code element
            // Always initialize codeTabs to prevent "codeTabs is not defined" errors
            const firstNamedCode = Array.from(codeElements).find(code => code.getAttribute('name'));
            if (firstNamedCode) {
                const defaultTab = firstNamedCode.getAttribute('name');
                this.setAttribute('x-data', `{ codeTabs: '${defaultTab}' }`);
            } else {
                // Initialize with empty string if no named code blocks exist
                // This prevents errors when buttons reference codeTabs
                this.setAttribute('x-data', `{ codeTabs: '' }`);
            }

            // Create header for tabs
            const header = document.createElement('header');

            // Process each code element
            codeElements.forEach((codeElement, index) => {
                const name = codeElement.getAttribute('name');

                if (!name) {
                    return; // Skip if no name attribute
                }

                // Create tab button
                const tabButton = document.createElement('button');
                tabButton.setAttribute('x-on:click', `codeTabs = '${name}'`);
                tabButton.setAttribute('x-bind:class', `codeTabs === '${name}' ? 'selected' : ''`);
                tabButton.setAttribute('role', 'tab');
                tabButton.setAttribute('aria-controls', `code-${name.replace(/\s+/g, '-').toLowerCase()}`);
                tabButton.setAttribute('x-bind:aria-selected', `codeTabs === '${name}' ? 'true' : 'false'`);
                tabButton.textContent = name;

                // Add keyboard navigation
                tabButton.addEventListener('keydown', (e) => {
                    const tabs = header.querySelectorAll('button[role="tab"]');
                    const currentIndex = Array.from(tabs).indexOf(tabButton);

                    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                        e.preventDefault();
                        const nextIndex = e.key === 'ArrowRight'
                            ? (currentIndex + 1) % tabs.length
                            : (currentIndex - 1 + tabs.length) % tabs.length;
                        tabs[nextIndex].focus();
                        tabs[nextIndex].click();
                    }
                });

                header.appendChild(tabButton);

                // Set up the code element for tabs
                codeElement.setAttribute('x-show', `codeTabs === '${name}'`);
                codeElement.setAttribute('id', `code-${name.replace(/\s+/g, '-').toLowerCase()}`);
                codeElement.setAttribute('role', 'tabpanel');
                codeElement.setAttribute('aria-labelledby', `tab-${name.replace(/\s+/g, '-').toLowerCase()}`);

                // Apply numbers and copy attributes from group if present
                if (this.numbers && !codeElement.hasAttribute('numbers')) {
                    codeElement.setAttribute('numbers', '');
                }
                if (this.copy && !codeElement.hasAttribute('copy')) {
                    codeElement.setAttribute('copy', '');
                }
            });

            // Set up header with proper ARIA attributes
            header.setAttribute('aria-label', 'Code examples');

            // Insert header at the beginning
            this.insertBefore(header, this.firstChild);

            // Set initial tab IDs after header is added
            const tabs = header.querySelectorAll('button[role="tab"]');
            tabs.forEach((tab, index) => {
                const name = tab.textContent.replace(/\s+/g, '-').toLowerCase();
                tab.setAttribute('id', `tab-${name}`);
            });
        }

        updateAttributes() {
            const codeElements = this.querySelectorAll('x-code');
            codeElements.forEach(codeElement => {
                if (this.numbers) {
                    codeElement.setAttribute('numbers', '');
                } else {
                    codeElement.removeAttribute('numbers');
                }
                if (this.copy) {
                    codeElement.setAttribute('copy', '');
                } else {
                    codeElement.removeAttribute('copy');
                }
            });
        }
    }

    // X-Code custom element
    class XCodeElement extends HTMLElement {
        constructor() {
            super();
        }

        static get observedAttributes() {
            return ['language', 'numbers', 'title', 'copy'];
        }

        get language() {
            return this.getAttribute('language') || 'auto';
        }

        get numbers() {
            return this.hasAttribute('numbers');
        }

        get title() {
            return this.getAttribute('name') || this.getAttribute('title');
        }

        get copy() {
            return this.hasAttribute('copy');
        }

        get contentElement() {
            return this.querySelector('code') || this;
        }

        connectedCallback() {
            // Idempotency: if the element already has a fully-rendered structure
            // (a <pre><code> child from prerender output), skip the rebuild.
            // Reading innerHTML and re-setting it as textContent (extractContent
            // line ~524) treats the prerendered hljs <span> markup as code
            // source, producing nested highlight-of-highlight output.
            const alreadyRendered =
                this.querySelector(':scope > pre > code') &&
                (this.hasAttribute('data-pre-rendered') ||
                 this.querySelector(':scope > pre > code.hljs, :scope > pre > code[data-highlighted="yes"]'));
            if (!alreadyRendered) {
                this.setupElement();
                this.highlightCode();
            }
        }

        attributeChangedCallback(name, oldValue, newValue) {
            if (oldValue !== newValue) {
                if (name === 'language') {
                    this.highlightCode();
                } else if (name === 'numbers') {
                    this.updateLineNumbers();
                } else if (name === 'title') {
                    this.updateTitle();
                } else if (name === 'copy' && typeof this.updateCopyButton === 'function') {
                    this.updateCopyButton();
                }
            }
        }

        setupElement() {
            // Extract content BEFORE adding any UI elements
            let content = this.extractContent();

            // Check if we have preserved original content for complete HTML documents
            const originalContent = this.getAttribute('data-original-content');
            if (originalContent) {
                // Use the preserved original content that includes document-level tags
                content = originalContent;
                // Remove the data attribute as we no longer need it
                this.removeAttribute('data-original-content');
            }

            // Create semantically correct structure: pre > code
            const pre = document.createElement('pre');
            const code = document.createElement('code');

            // Use textContent to preserve HTML tags as literal text
            // This ensures highlight.js treats the content as code, not HTML
            code.textContent = content;
            pre.appendChild(code);
            this.textContent = '';
            this.appendChild(pre);

            // Create title if present (after pre element is created) - but only if not in a code group
            if (this.title && !this.closest('x-code-group')) {
                const header = document.createElement('header');

                const title = document.createElement('div');
                title.textContent = this.title;
                header.appendChild(title);

                this.insertBefore(header, pre);
            }

            // Add line numbers if enabled
            if (this.numbers) {
                this.setupLineNumbers();
            }

            // Add copy button if enabled (after content extraction)
            if (this.copy) {
                this.setupCopyButton();
            }

            // If this is in a code group, ensure copy button comes after title in tab order
            const codeGroup = this.closest('x-code-group');
            if (codeGroup && this.copy) {
                const copyButton = this.querySelector('.copy');
                if (copyButton) {
                    // Set tabindex to ensure it comes after header buttons in tab order
                    copyButton.setAttribute('tabindex', '0');
                }
            }
        }

        extractContent() {
            // Get the content and preserve original formatting
            let content = this.textContent;

            // Preserve intentional line breaks at the beginning and end
            // Only trim if there are no intentional line breaks
            const hasLeadingLineBreak = content.startsWith('\n');
            const hasTrailingLineBreak = content.endsWith('\n');

            // Trim but preserve intentional line breaks
            if (hasLeadingLineBreak) {
                content = '\n' + content.trimStart();
            } else {
                content = content.trimStart();
            }

            if (hasTrailingLineBreak) {
                content = content.trimEnd() + '\n';
            } else {
                content = content.trimEnd();
            }

            // Check if this is markdown-generated content (has preserved indentation)
            // Also check if this is inside a frame (aside element)
            const isInsideFrame = this.closest('aside');
            const hasPreservedIndentation = content.includes('\n    ') || content.includes('\n\t');

            // Special handling for frames - remove leading and trailing empty lines
            if (isInsideFrame) {
                // If we have a title and the content starts with it, remove it
                if (this.title && content.startsWith(this.title)) {
                    content = content.substring(this.title.length);
                    // Remove any leading newline after removing title
                    content = content.replace(/^\n+/, '');
                }

                // Remove leading empty lines and whitespace
                content = content.replace(/^\s*\n+/, '');
                // Remove trailing empty lines and whitespace
                content = content.replace(/\n+\s*$/, '');
                // Also trim any remaining leading/trailing whitespace
                content = content.trim();
            }

            if (!hasPreservedIndentation && content.includes('\n') && !isInsideFrame) {
                // Only normalize indentation for non-markdown content
                const hasTrailingLineBreakText = content.endsWith('\n');
                const lines = content.split('\n');

                // Find the minimum indentation (excluding empty lines and lines with no indentation)
                let minIndent = Infinity;
                for (const line of lines) {
                    if (line.trim() !== '') {
                        const indent = line.length - line.trimStart().length;
                        if (indent > 0) { // Only consider lines that actually have indentation
                            minIndent = Math.min(minIndent, indent);
                        }
                    }
                }

                // Remove the common indentation from all lines
                if (minIndent < Infinity) {
                    content = lines.map(line => {
                        if (line.trim() === '') return '';
                        const indent = line.length - line.trimStart().length;
                        // Only remove indentation if the line has enough spaces
                        return indent >= minIndent ? line.slice(minIndent) : line;
                    }).join('\n');

                    // Preserve trailing line break if it was originally there
                    if (hasTrailingLineBreakText) {
                        content += '\n';
                    }
                }
            }

            // Check if the content was interpreted as HTML (has child nodes)
            if (this.children.length > 0) {
                // Extract the original HTML from the child nodes
                content = this.innerHTML;

                // Preserve intentional line breaks at the beginning and end
                const hasLeadingLineBreak = content.startsWith('\n');
                const hasTrailingLineBreak = content.endsWith('\n');

                // Trim but preserve intentional line breaks
                if (hasLeadingLineBreak) {
                    content = '\n' + content.trimStart();
                } else {
                    content = content.trimStart();
                }

                if (hasTrailingLineBreak) {
                    content = content.trimEnd() + '\n';
                } else {
                    content = content.trimEnd();
                }

                // Remove any copy button that might have been included
                content = content.replace(/<button[^>]*class="copy"[^>]*>.*?<\/button>/g, '');

                // Clean up empty attribute values (data-head="" -> data-head)
                content = content.replace(/(\w+)=""/g, '$1');

                // For HTML content, normalize indentation (but not for frames)
                const isInsideFrame = this.closest('aside');
                const hasTrailingLineBreakHtml = content.endsWith('\n');
                const lines = content.split('\n');
                if (lines.length > 1 && !isInsideFrame) {
                    // Find the minimum indentation
                    let minIndent = Infinity;
                    for (const line of lines) {
                        if (line.trim() !== '') {
                            const indent = line.length - line.trimStart().length;
                            if (indent > 0) {
                                minIndent = Math.min(minIndent, indent);
                            }
                        }
                    }

                    // Remove the common indentation from all lines
                    if (minIndent < Infinity) {
                        content = lines.map(line => {
                            if (line.trim() === '') return '';
                            const indent = line.length - line.trimStart().length;
                            return indent >= minIndent ? line.slice(minIndent) : line;
                        }).join('\n');

                        // Preserve trailing line break if it was originally there
                        if (hasTrailingLineBreakHtml) {
                            content += '\n';
                        }
                    }
                }
            }

            return content;
        }

        async setupLineNumbers() {
            try {
                // Ensure the pre element exists and has content
                const pre = this.querySelector('pre');

                if (pre && !this.querySelector('.lines')) {
                    // Make sure the pre element is properly set up first
                    if (!pre.querySelector('code')) {
                        const code = document.createElement('code');
                        code.textContent = pre.textContent;
                        pre.textContent = '';
                        pre.appendChild(code);
                    }

                    // Count the lines using the actual DOM content
                    const codeText = pre.textContent;
                    const lines = codeText.split('\n');

                    // Create the lines container
                    const linesContainer = document.createElement('div');
                    linesContainer.className = 'lines';

                    // Add line number items for all lines (including empty ones)
                    for (let i = 0; i < lines.length; i++) {
                        const lineSpan = document.createElement('span');
                        lineSpan.textContent = (i + 1).toString();
                        linesContainer.appendChild(lineSpan);
                    }

                    // Insert line numbers before the pre element
                    this.insertBefore(linesContainer, pre);
                }
            } catch (error) {
                console.warn('[Manifest] Failed to setup line numbers:', error);
            }
        }

        async setupCopyButton() {
            try {
                const copyButton = document.createElement('button');
                copyButton.className = 'copy';
                copyButton.setAttribute('aria-label', 'Copy code to clipboard');
                copyButton.setAttribute('type', 'button');

                copyButton.addEventListener('click', () => {
                    this.copyCodeToClipboard();
                });

                // Add keyboard support
                copyButton.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        this.copyCodeToClipboard();
                    }
                });

                this.appendChild(copyButton);
            } catch (error) {
                console.warn('[Manifest] Failed to setup copy button:', error);
            }
        }

        async copyCodeToClipboard() {
            try {
                const codeElement = this.contentElement;
                const codeText = codeElement.textContent;

                await navigator.clipboard.writeText(codeText);

                // Show copied state using CSS classes
                const copyButton = this.querySelector('.copy');
                if (copyButton) {
                    copyButton.classList.add('copied');
                    setTimeout(() => {
                        copyButton.classList.remove('copied');
                    }, 2000);
                }
            } catch (error) {
                console.warn('[Manifest] Failed to copy code:', error);
            }
        }

        updateLineNumbers() {
            if (this.numbers) {
                this.setupLineNumbers();
            } else {
                // Remove line numbers if disabled
                const lines = this.querySelector('.lines');
                if (lines) {
                    lines.remove();
                }
            }
        }

        async highlightCode() {
            try {
                // Ensure highlight.js is loaded
                const hljs = await loadHighlightJS();

                const codeElement = this.contentElement;

                // Skip if this element contains HTML (has child elements)
                if (codeElement.children.length > 0) {
                    return;
                }

                // Only skip HTML content for auto-detection, not when language is explicitly specified
                const content = codeElement.textContent || '';

                // Reset highlighting if already highlighted
                if (codeElement.dataset.highlighted === 'yes') {
                    delete codeElement.dataset.highlighted;
                    // Clear all highlight.js related classes
                    codeElement.className = codeElement.className.replace(/\bhljs\b|\blanguage-\w+\b/g, '').trim();
                }

                // Set language class if specified
                if (this.language && this.language !== 'auto') {
                    // Skip non-programming languages
                    if (this.language === 'frame') {
                        return;
                    }

                    // Check if the language is supported by highlight.js
                    const supportedLanguages = hljs.listLanguages();
                    const languageAliases = {
                        'js': 'javascript',
                        'ts': 'typescript',
                        'py': 'python',
                        'rb': 'ruby',
                        'sh': 'bash',
                        'yml': 'yaml',
                        'html': 'xml'
                    };

                    let actualLanguage = this.language;
                    if (languageAliases[this.language]) {
                        actualLanguage = languageAliases[this.language];
                    }

                    // Only highlight if language is supported, otherwise skip highlighting
                    if (supportedLanguages.includes(actualLanguage)) {
                        // Use hljs.highlight() with specific language to avoid auto-detection
                        const result = hljs.highlight(codeElement.textContent, { language: actualLanguage });
                        codeElement.innerHTML = result.value;
                        codeElement.className = `language-${actualLanguage} hljs`;
                        codeElement.dataset.highlighted = 'yes';
                    } else {
                        // Skip unsupported languages
                        return;
                    }
                } else {
                    // For auto-detection, only proceed if content doesn't look like HTML
                    if (content.includes('<') && content.includes('>') && content.includes('</')) {
                        // Skip HTML-like content to avoid security warnings during auto-detection
                        return;
                    }

                    // Remove any existing language class for auto-detection
                    codeElement.className = codeElement.className.replace(/\blanguage-\w+/g, '');

                    // Use highlightElement for auto-detection when no specific language
                    hljs.highlightElement(codeElement);
                }

            } catch (error) {
                console.warn(`[Manifest] Failed to highlight code:`, error);
            }
        }

        update() {
            this.highlightCode();
        }

        updateTitle() {
            let titleElement = this.querySelector('header div');
            if (this.title) {
                if (!titleElement) {
                    titleElement = document.createElement('div');
                    titleElement.textContent = this.title;
                    this.insertBefore(titleElement, this.firstChild);
                }
                titleElement.textContent = this.title;
            } else if (titleElement) {
                titleElement.remove();
            }
        }

        updateCopyButton() {
            const existingCopyButton = this.querySelector('.copy');

            if (this.copy) {
                if (!existingCopyButton) {
                    // Only add copy button if setupElement has already been called
                    // (i.e., if we have a pre element)
                    if (this.querySelector('pre')) {
                        this.setupCopyButton();
                    }
                    // Otherwise, the copy button will be added in setupElement()
                }
            } else {
                if (existingCopyButton) {
                    existingCopyButton.remove();
                }
            }
        }
    }

    // Initialize the plugin
    async function initialize() {
        try {
            // Register the custom element
            if (!customElements.get('x-code')) {
                customElements.define('x-code', XCodeElement);
            }
            if (!customElements.get('x-code-group')) {
                customElements.define('x-code-group', XCodeGroupElement);
            }

            // Listen for markdown plugin conversions (always process when new blocks appear)
            const runProcess = () => processExistingCodeBlocks();
            document.addEventListener('manifest:code-blocks-converted', runProcess);
            if (document.body) {
                document.body.addEventListener('manifest:code-blocks-converted', runProcess);
            }

            // Defer loading highlight.js until first code block is in view (or process immediately if none to observe)
            const codeTargets = document.querySelectorAll('pre > code:not(.hljs):not([data-highlighted="yes"]), x-code:not([data-highlighted="yes"])');
            if (codeTargets.length === 0) {
                return;
            }
            const io = new IntersectionObserver((entries) => {
                if (!entries.some(e => e.isIntersecting)) return;
                io.disconnect();
                runProcess();
            }, { rootMargin: '100px', threshold: 0 });
            codeTargets.forEach(el => io.observe(el));
        } catch (error) {
            console.error('[Manifest] Failed to initialize code plugin:', error);
        }
    }

    // Alpine.js directive for code highlighting (only if Alpine is available)
    if (typeof Alpine !== 'undefined') {
        Alpine.directive('code', (el, { expression, modifiers }, { effect, evaluateLater }) => {
            // Create x-code element
            const codeElement = document.createElement('x-code');

            // Get language from various possible sources
            let language = 'auto';

            // Check for language attribute first
            const languageAttr = el.getAttribute('language');
            if (languageAttr) {
                language = languageAttr;
            } else if (expression && typeof expression === 'string' && !expression.includes('.')) {
                // Fallback to expression if it's a simple string
                language = expression;
            } else if (modifiers.length > 0) {
                // Fallback to first modifier
                language = modifiers[0];
            }

            codeElement.setAttribute('language', language);

            // Enable line numbers if specified
            if (modifiers.includes('numbers') || modifiers.includes('line-numbers') || el.hasAttribute('numbers')) {
                codeElement.setAttribute('numbers', '');
            }

            // Set title from various possible sources
            const title = el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('data-title');
            if (title) {
                codeElement.setAttribute('name', title);
            }

            // Move content to x-code element
            const content = el.textContent.trim();
            codeElement.textContent = content;
            el.textContent = '';
            el.appendChild(codeElement);

            // Handle dynamic content updates only if expression is a variable
            if (expression && (expression.includes('.') || !['javascript', 'css', 'html', 'python', 'ruby', 'php', 'java', 'c', 'cpp', 'csharp', 'go', 'sql', 'json', 'yaml', 'markdown', 'typescript', 'jsx', 'tsx', 'scss', 'sass', 'less', 'xml', 'markup'].includes(expression))) {
                const getContent = evaluateLater(expression);
                effect(() => {
                    getContent((content) => {
                        if (content && typeof content === 'string') {
                            codeElement.textContent = content;
                            codeElement.update();
                        }
                    });
                });
            }
        });
    }

    // Handle both DOMContentLoaded and alpine:init
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize);
    } else {
        initialize();
    }

    // Listen for Alpine initialization (only if Alpine is available)
    if (typeof Alpine !== 'undefined') {
        document.addEventListener('alpine:init', initialize);
    } else {
        // If Alpine isn't available yet, listen for it to become available
        document.addEventListener('alpine:init', () => {
            // Re-register the directive when Alpine becomes available
            if (typeof Alpine !== 'undefined') {
                Alpine.directive('code', (el, { expression, modifiers }, { effect, evaluateLater }) => {
                    // Create x-code element
                    const codeElement = document.createElement('x-code');

                    // Get language from various possible sources
                    let language = 'auto';

                    // Check for language attribute first
                    const languageAttr = el.getAttribute('language');
                    if (languageAttr) {
                        language = languageAttr;
                    } else if (expression && typeof expression === 'string' && !expression.includes('.')) {
                        // Fallback to expression if it's a simple string
                        language = expression;
                    } else if (modifiers.length > 0) {
                        // Fallback to first modifier
                        language = modifiers[0];
                    }

                    codeElement.setAttribute('language', language);

                    // Enable line numbers if specified
                    if (modifiers.includes('numbers') || modifiers.includes('line-numbers') || el.hasAttribute('numbers')) {
                        codeElement.setAttribute('numbers', '');
                    }

                    // Set title from various possible sources
                    const title = el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('data-title');
                    if (title) {
                        codeElement.setAttribute('name', title);
                    }

                    // Move content to x-code element
                    const content = el.textContent.trim();
                    codeElement.textContent = content;
                    el.textContent = '';
                    el.appendChild(codeElement);

                    // Handle dynamic content updates only if expression is a variable
                    if (expression && (expression.includes('.') || !['javascript', 'css', 'html', 'python', 'ruby', 'php', 'java', 'c', 'cpp', 'csharp', 'go', 'sql', 'json', 'yaml', 'markdown', 'typescript', 'jsx', 'tsx', 'scss', 'sass', 'less', 'xml', 'markup'].includes(expression))) {
                        const getContent = evaluateLater(expression);
                        effect(() => {
                            getContent((content) => {
                                if (content && typeof content === 'string') {
                                    codeElement.textContent = content;
                                    codeElement.update();
                                }
                            });
                        });
                    }
                });
            }
        });
    }
}

// Track initialization to prevent duplicates
let codePluginInitialized = false;

async function ensureCodePluginInitialized() {
    if (codePluginInitialized) return;
    codePluginInitialized = true;
    await initializeCodePlugin();
}

// Expose on window for loader to call if needed
window.ensureCodePluginInitialized = ensureCodePluginInitialized;

// Initialize the plugin
ensureCodePluginInitialized(); 