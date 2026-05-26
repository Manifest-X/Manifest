// Helper methods
// Utility functions for extracting, parsing, and processing CSS and classes

// Ensure #manifest-styles is last in head so our responsive/variant rules win over Tailwind and any later-injected styles
TailwindCompiler.prototype.ensureUtilityStylesLast = function () {
    if (this.styleElement && this.styleElement.parentNode && document.head.lastElementChild !== this.styleElement) {
        document.head.appendChild(this.styleElement);
    }
};

// When any element is added to head after ours, move #manifest-styles to end. Handles CDN load order (e.g. Tailwind injecting after we run).
TailwindCompiler.prototype.setupUtilityStylesOrderObserver = function () {
    if (!document.head || !this.styleElement) return;
    const self = this;
    const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type !== 'childList' || !mutation.addedNodes.length) continue;
            for (const node of mutation.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE || node === self.styleElement) continue;
                self.ensureUtilityStylesLast();
                break;
            }
        }
    });
    observer.observe(document.head, { childList: true, subtree: false });
};

// Schedule ensureUtilityStylesLast at 0ms, 100ms, 500ms so we win when Tailwind (or other scripts) inject styles later (e.g. CDN).
TailwindCompiler.prototype.scheduleEnsureUtilityStylesLast = function () {
    const self = this;
    [0, 100, 500].forEach((ms) => {
        setTimeout(() => self.ensureUtilityStylesLast(), ms);
    });
};

// Discover CSS files from stylesheets and imports
TailwindCompiler.prototype.discoverCssFiles = function () {
    try {
        // Get all stylesheets from the document
        const stylesheets = Array.from(document.styleSheets);

        // Process each stylesheet
        for (const sheet of stylesheets) {
            try {
                // Process local files and framework CDN files (manifestjs, mnfst)
                const isFrameworkCdn = (href) =>
                    href.includes('manifestjs') || href.includes('mnfst') ||
                    (href.includes('jsdelivr') && (href.includes('manifestjs') || href.includes('mnfst'))) ||
                    (href.includes('unpkg') && (href.includes('manifestjs') || href.includes('mnfst')));
                if (sheet.href && (
                    sheet.href.startsWith(window.location.origin) ||
                    isFrameworkCdn(sheet.href)
                )) {
                    this.cssFiles.add(sheet.href);
                }

                // Get all @import rules (local and framework CDN)
                const rules = Array.from(sheet.cssRules || []);
                for (const rule of rules) {
                    if (rule.type === CSSRule.IMPORT_RULE && rule.href && (
                        rule.href.startsWith(window.location.origin) ||
                        isFrameworkCdn(rule.href)
                    )) {
                        this.cssFiles.add(rule.href);
                    }
                }
            } catch (e) {
                // Skip stylesheets that can't be accessed (external CDN files, CORS, etc.)
            }
        }

        // Add any inline styles (exclude generated styles)
        const styleElements = document.querySelectorAll('style:not(#manifest-styles)');
        for (const style of styleElements) {
            if (style.textContent && style.textContent.trim()) {
                const id = style.id || `inline-style-${Array.from(styleElements).indexOf(style)}`;
                this.cssFiles.add('inline:' + id);
            }
        }
    } catch (error) {
        console.warn('Error discovering CSS files:', error);
    }
};

// Scan static HTML files and components for classes
TailwindCompiler.prototype.scanStaticClasses = async function () {
    if (this.staticScanPromise) {
        return this.staticScanPromise;
    }

    this.staticScanPromise = (async () => {
        try {
            const staticClasses = new Set();

            // 1. Scan index.html content
            const htmlContent = document.documentElement.outerHTML;
            this.extractClassesFromHTML(htmlContent, staticClasses);

            // 2. Scan component files from manifest
            // Wait for components registry to be ready (with timeout)
            let registry = window.ManifestComponentsRegistry;
            const maxWaitTime = 2000; // Wait up to 2 seconds for registry
            const checkInterval = 50;
            let waited = 0;
            
            while (!registry && waited < maxWaitTime) {
                await new Promise(resolve => setTimeout(resolve, checkInterval));
                registry = window.ManifestComponentsRegistry;
                waited += checkInterval;
            }
            
            const componentUrls = [];

            if (registry && registry.manifest) {
                // Get all component paths from manifest
                const allComponents = [
                    ...(registry.manifest.preloadedComponents || []),
                    ...(registry.manifest.components || [])
                ];
                componentUrls.push(...allComponents);
            }

            const componentPromises = componentUrls.map(async (url) => {
                try {
                    // Use root-relative URL first to avoid 404s on doc routes (e.g. /getting-started/...)
                    const rootRelative = url.startsWith('/') ? url : '/' + url;
                    const pathsToTry = [rootRelative, url];
                    for (const path of pathsToTry) {
                        try {
                            const response = await fetch(path);
                            if (response.ok) {
                                const html = await response.text();
                                this.extractClassesFromHTML(html, staticClasses);
                                break;
                            }
                        } catch (e) {
                            continue;
                        }
                    }
                } catch (error) {
                    // Silently ignore missing components
                }
            });

            await Promise.all(componentPromises);

            // Cache static classes
            for (const cls of staticClasses) {
                this.staticClassCache.add(cls);
            }

            this.hasScannedStatic = true;

            return staticClasses;
        } catch (error) {
            console.warn('[TailwindCompiler] Error scanning static classes:', error);
            this.hasScannedStatic = true;
            return new Set();
        }
    })();

    return this.staticScanPromise;
};

// Extract classes from HTML content
TailwindCompiler.prototype.extractClassesFromHTML = function (html, classSet) {
    // Match class attributes: class="..." or class='...'
    const classRegex = /class=["']([^"']+)["']/g;
    let match;

    while ((match = classRegex.exec(html)) !== null) {
        const classString = match[1];
        const classes = classString.split(/\s+/).filter(Boolean);
        for (const cls of classes) {
            if (cls && !cls.startsWith('x-') && !cls.startsWith('$')) {
                classSet.add(cls);
            }
        }
    }

    // Also check for x-data and other Alpine directives that might contain classes
    const alpineRegex = /x-(?:data|bind:class|class)=["']([^"']+)["']/g;
    while ((match = alpineRegex.exec(html)) !== null) {
        // Simple extraction - could be enhanced for complex Alpine expressions
        const content = match[1];
        const classMatches = content.match(/['"`]([^'"`\s]+)['"`]/g);
        if (classMatches) {
            for (const classMatch of classMatches) {
                const cls = classMatch.replace(/['"`]/g, '');
                if (cls && !cls.startsWith('$') && !cls.includes('(')) {
                    classSet.add(cls);
                }
            }
        }
    }
};

// Get all used classes from static and dynamic sources
TailwindCompiler.prototype.getUsedClasses = function () {
    try {
        const allClasses = new Set();
        const usedVariableSuffixes = new Set();

        // Add static classes (pre-scanned)
        for (const cls of this.staticClassCache) {
            allClasses.add(cls);
        }

        // Scan current DOM for dynamic classes only
        const elements = document.getElementsByTagName('*');
        for (const element of elements) {
            let classes = [];
            if (typeof element.className === 'string') {
                classes = element.className.split(/\s+/).filter(Boolean);
            } else if (element.classList) {
                classes = Array.from(element.classList);
            }

            for (const cls of classes) {
                if (!cls) continue;

                // Skip classes using configurable patterns
                const isIgnoredClass = this.ignoredClassPatterns.some(pattern =>
                    pattern.test(cls)
                );

                if (isIgnoredClass) {
                    continue;
                }

                // Add all classes (static + dynamic)
                allClasses.add(cls);

                // Track dynamic classes separately
                if (!this.staticClassCache.has(cls)) {
                    this.dynamicClassCache.add(cls);
                }
            }
        }

        // Process all classes for variable suffixes
        for (const cls of allClasses) {
            // Extract base class and variants
            const parts = cls.split(':');
            const baseClass = parts[parts.length - 1];

            // Extract suffix for variable matching
            const classParts = baseClass.split('-');
            if (classParts.length > 1) {
                let suffix = classParts.slice(1).join('-');

                // Handle opacity modifiers (like /90, /50)
                let baseSuffix = suffix;
                if (suffix.includes('/')) {
                    const parts = suffix.split('/');
                    baseSuffix = parts[0];
                    const opacity = parts[1];

                    // Add both the base suffix and the full suffix with opacity
                    usedVariableSuffixes.add(baseSuffix);
                    usedVariableSuffixes.add(suffix); // Keep the full suffix with opacity
                } else {
                    usedVariableSuffixes.add(suffix);
                }

                // For compound classes like text-content-subtle, also add the full suffix
                if (classParts.length > 2) {
                    const fullSuffix = classParts.slice(1).join('-');
                    if (fullSuffix.includes('/')) {
                        usedVariableSuffixes.add(fullSuffix.split('/')[0]);
                    } else {
                        usedVariableSuffixes.add(fullSuffix);
                    }
                }
            }
        }

        const result = {
            classes: Array.from(allClasses),
            variableSuffixes: Array.from(usedVariableSuffixes)
        };

        return result;
    } catch (error) {
        console.error('Error getting used classes:', error);
        return { classes: [], variableSuffixes: [] };
    }
};

// True for Manifest framework stylesheets (the compiled bundle and its plugin
// partials, on the CDN or self-hosted), false for the developer-overridable
// theme entry-point, inline <style> blocks, and any non-framework CSS.
//
// Used to split fetchThemeContent's output into two buckets: CSS *variables*
// are read from every sheet (developers can declare custom properties
// anywhere), but custom utility *class* declarations are only harvested from
// non-framework sheets — framework semantic classes like .brand / .row / .col
// already live in the static cascade and re-emitting them at runtime causes
// duplicate #manifest-styles entries.
TailwindCompiler.prototype.isFrameworkStylesheet = function (source) {
    if (typeof source !== 'string' || source.startsWith('inline:')) return false;
    const lower = source.toLowerCase();
    // manifest.theme.css ships with the framework but is developer-overridable —
    // always scan it for class declarations.
    if (/\/manifest\.theme\.css(?:[?#]|$)/.test(lower)) return false;
    // Framework CDN bundles (jsdelivr/unpkg/etc. publishing manifestjs or mnfst).
    if (lower.includes('manifestjs') || lower.includes('mnfst')) return true;
    // Self-hosted framework files: manifest.css, manifest.min.css,
    // manifest.<plugin>.css. Heuristic on basename — a developer who names their
    // own bundle "manifest.foo.css" will get caught by this, which is rare and
    // easy to work around by renaming.
    if (/\/manifest(?:\.[\w-]+)*\.css(?:[?#]|$)/.test(lower)) return true;
    return false;
};

// Fetch theme content from CSS files.
//
// Returns { all, userScannable }:
// - all: every loaded stylesheet, used for CSS-variable extraction.
// - userScannable: same minus framework stylesheets (see isFrameworkStylesheet).
//   Used for custom-utility class extraction.
TailwindCompiler.prototype.fetchThemeContent = async function () {
    const allContents = new Set();
    const userContents = new Set();
    const fetchPromises = [];

    // If we haven't discovered CSS files yet, do it now
    if (this.cssFiles.size === 0) {
        this.discoverCssFiles();
    }

    // Process all files concurrently
    for (const source of this.cssFiles) {
        const isFramework = this.isFrameworkStylesheet(source);
        const fetchPromise = (async () => {
            try {
                let content = '';
                let needsFetch = true;

                if (source.startsWith('inline:')) {
                    const styleId = source.replace('inline:', '');
                    const styleElement = styleId ?
                        document.getElementById(styleId) :
                        document.querySelector('style');
                    if (styleElement) {
                        content = styleElement.textContent;
                    }
                    needsFetch = false;
                } else {
                    // Smart caching: use session storage + timestamp approach
                    const cacheKey = source;
                    const cached = this.cssContentCache.get(cacheKey);
                    const now = Date.now();

                    // Different cache times based on file source
                    let cacheTime;
                    if (source.includes('manifestjs') || source.includes('mnfst') || source.includes('jsdelivr') || source.includes('unpkg')) {
                        // CDN files: cache longer (5 minutes for static, 1 minute for dynamic)
                        cacheTime = this.hasScannedStatic ? 60000 : 300000;
                    } else {
                        // Local files: shorter cache (5 seconds for dynamic, 30 seconds for static)
                        cacheTime = this.hasScannedStatic ? 5000 : 30000;
                    }

                    if (cached && (now - cached.timestamp) < cacheTime) {
                        content = cached.content;
                        needsFetch = false;
                    }

                    if (needsFetch) {
                        // Add timestamp for development cache busting, but keep it minimal
                        const timestamp = Math.floor(now / 1000); // Only changes every second
                        const url = `${source}?t=${timestamp}`;

                        const response = await fetch(url);

                        if (!response.ok) {
                            console.warn('Failed to fetch stylesheet:', url);
                            return;
                        }

                        content = await response.text();

                        // Cache the content with timestamp
                        this.cssContentCache.set(cacheKey, {
                            content: content,
                            timestamp: now
                        });
                    }
                }

                if (content) {
                    allContents.add(content);
                    if (!isFramework) {
                        userContents.add(content);
                    }
                }
            } catch (error) {
                console.warn(`Error fetching CSS from ${source}:`, error);
            }
        })();
        fetchPromises.push(fetchPromise);
    }

    // Wait for all fetches to complete
    await Promise.all(fetchPromises);

    return {
        all: Array.from(allContents).join('\n'),
        userScannable: Array.from(userContents).join('\n')
    };
};

// Extract CSS variables from CSS text
TailwindCompiler.prototype.extractThemeVariables = function (cssText) {
    const variables = new Map();

    // Extract ALL CSS custom properties from ANY declaration block
    const varRegex = /--([\w-]+):\s*([^;]+);/g;

    let varMatch;
    while ((varMatch = varRegex.exec(cssText)) !== null) {
        const name = varMatch[1];
        const value = varMatch[2].trim();
        variables.set(name, value);
    }

    return variables;
};

// Extract custom utilities from CSS text
TailwindCompiler.prototype.extractCustomUtilities = function (cssText) {
    const utilities = new Map();

    // Helper to ensure CSS is always a string
    const ensureCssString = (css) => {
        if (typeof css === 'string') {
            // Clean up any [object Object] that might have snuck in
            return css.replace(/\[object Object\](;?\s*)/g, '').trim();
        }
        if (css && typeof css === 'object' && css.css) {
            return ensureCssString(css.css);
        }
        const stringified = String(css);
        // Return empty string instead of [object Object]
        if (stringified === '[object Object]') {
            return '';
        }
        return stringified;
    };

    // Extract custom utility classes from CSS
    // Match: .classname or .!classname (where classname can contain word chars and hyphens)
    const utilityRegex = /(?:@layer\s+utilities\s*{[^}]*}|^)(?:[^{}]*?)(?:^|\s)(\.!?[\w-]+)\s*{([^}]+)}/gm;

    let match;
    while ((match = utilityRegex.exec(cssText)) !== null) {
        const className = match[1].substring(1); // Remove the leading dot
        const cssRules = match[2].trim();

        // Skip if it's a Tailwind-generated class (check base name without !)
        const baseClassName = className.startsWith('!') ? className.slice(1) : className;
        if (this.isTailwindGeneratedClass(baseClassName)) {
            continue;
        }

        // Check if CSS rules contain !important
        const hasImportant = /\s!important/.test(cssRules);
        const classHasImportantPrefix = className.startsWith('!');

        // Determine final CSS rules
        let finalCssRules = cssRules;
        if (classHasImportantPrefix) {
            // Class has ! prefix, ensure CSS has !important
            if (!hasImportant) {
                finalCssRules = cssRules.includes(';') ?
                    cssRules.replace(/;/g, ' !important;') :
                    cssRules + ' !important';
            }
        } else {
            // Class doesn't have ! prefix, remove !important if present
            if (hasImportant) {
                finalCssRules = cssRules.replace(/\s!important/g, '');
            }
        }

        // Store the utility class with its full name (including ! prefix) as the key
        // This ensures !col is stored separately from col
        // Ensure CSS is always a string
        const cssString = ensureCssString(finalCssRules);
        if (utilities.has(className)) {
            const existingRules = utilities.get(className);
            const existingCssString = ensureCssString(existingRules);
            utilities.set(className, `${existingCssString}; ${cssString}`);
        } else {
            utilities.set(className, cssString);
        }
    }

    // Also look for :where() selectors which are common in Manifest utilities
    // Handle both single class and multiple class selectors
    // Use a function to properly match braces for nested rules
    const extractWhereSelectors = (text) => {
        const matches = [];
        let i = 0;
        while (i < text.length) {
            // Find :where(
            const whereStart = text.indexOf(':where(', i);
            if (whereStart === -1) break;

            // Find matching closing paren for :where(
            let parenDepth = 1;
            let j = whereStart + 7; // Skip ':where('
            while (j < text.length && parenDepth > 0) {
                if (text[j] === '(') parenDepth++;
                else if (text[j] === ')') parenDepth--;
                j++;
            }
            if (parenDepth > 0) {
                i = whereStart + 1;
                continue; // Malformed, skip
            }

            const selectorContent = text.slice(whereStart + 7, j - 1);

            // Skip whitespace and find opening brace
            while (j < text.length && /\s/.test(text[j])) j++;
            if (j >= text.length || text[j] !== '{') {
                i = whereStart + 1;
                continue;
            }

            // Find matching closing brace (handle nested braces)
            let braceDepth = 1;
            let blockStart = j + 1;
            j++;
            while (j < text.length && braceDepth > 0) {
                if (text[j] === '{') braceDepth++;
                else if (text[j] === '}') braceDepth--;
                j++;
            }
            if (braceDepth > 0) {
                i = whereStart + 1;
                continue; // Malformed, skip
            }

            const cssRules = text.slice(blockStart, j - 1).trim();
            matches.push({ selectorContent, cssRules, fullMatch: text.slice(whereStart, j) });
            i = j;
        }
        return matches;
    };

    const whereMatches = extractWhereSelectors(cssText);
    for (const match of whereMatches) {
        const selectorContent = match.selectorContent;
        const cssRules = match.cssRules;

        // Check if CSS rules contain !important
        const hasImportant = /\s!important/.test(cssRules);

        // Extract individual class names from the selector, including those with ! prefix
        // Match: .classname or .!classname (where classname can contain word chars and hyphens)
        const classMatches = selectorContent.match(/\.(!?[\w-]+)/g);
        if (classMatches) {
            for (const classMatch of classMatches) {
                const className = classMatch.substring(1); // Remove the leading dot

                // Skip if it's a Tailwind-generated class (but check base name without !)
                const baseClassName = className.startsWith('!') ? className.slice(1) : className;
                if (this.isTailwindGeneratedClass(baseClassName)) {
                    continue;
                }

                // Determine if this class should have !important
                // Only apply !important if the class name itself starts with ! (e.g., !col)
                const classHasImportantPrefix = className.startsWith('!');
                let finalCssRules = cssRules;

                if (classHasImportantPrefix) {
                    // Class has ! prefix, ensure CSS has !important
                    if (!hasImportant) {
                        finalCssRules = cssRules.includes(';') ?
                            cssRules.replace(/;/g, ' !important;') :
                            cssRules + ' !important';
                    }
                } else {
                    // Class doesn't have ! prefix, remove !important if present
                    if (hasImportant) {
                        finalCssRules = cssRules.replace(/\s!important/g, '');
                    }
                }

                // Store the class with its full name (including ! prefix) as the key
                // This ensures !col is stored separately from col
                // Store as selector-aware object to preserve :where() context for variants
                // Mark as fullBlock since it contains nested rules
                const storageKey = className;
                const originalSelector = `:where(${selectorContent})`;
                // Ensure CSS is always a string
                const cssString = ensureCssString(finalCssRules);
                const value = {
                    selector: originalSelector,
                    css: cssString,
                    fullBlock: true // :where() blocks often contain nested rules
                };

                // Combine CSS rules if the class already exists
                if (utilities.has(storageKey)) {
                    const existing = utilities.get(storageKey);
                    // If existing is a string, convert to array format
                    if (typeof existing === 'string') {
                        const existingCssString = ensureCssString(existing);
                        utilities.set(storageKey, [
                            { selector: `.${className}`, css: existingCssString },
                            value
                        ]);
                    } else if (Array.isArray(existing)) {
                        // Check if this selector already exists in the array
                        const found = existing.find(e => e.selector === value.selector);
                        if (found) {
                            // Ensure both are strings before concatenating
                            const foundCss = ensureCssString(found.css);
                            const valueCss = ensureCssString(value.css);
                            found.css = `${foundCss}; ${valueCss}`;
                        } else {
                            existing.push(value);
                        }
                    } else if (existing && existing.selector) {
                        // Convert single object to array
                        if (existing.selector === value.selector) {
                            // Ensure both are strings before concatenating
                            const existingCss = ensureCssString(existing.css);
                            const valueCss = ensureCssString(value.css);
                            existing.css = `${existingCss}; ${valueCss}`;
                            utilities.set(storageKey, [existing]);
                        } else {
                            utilities.set(storageKey, [existing, value]);
                        }
                    }
                } else {
                    utilities.set(storageKey, [value]);
                }
            }
        }
    }

    // Fallback: detect classes inside compound selectors (e.g., aside[popover].appear-start { ... })
    // Use brace matching to handle nested rules properly
    try {
        let i = 0;
        while (i < cssText.length) {
            // Skip whitespace
            while (i < cssText.length && /\s/.test(cssText[i])) i++;
            if (i >= cssText.length) break;

            // Skip at-rules
            if (cssText[i] === '@') {
                // Skip to next line or closing brace
                while (i < cssText.length && cssText[i] !== '\n' && cssText[i] !== '}') i++;
                continue;
            }

            // Capture selector up to '{'
            let selStart = i;
            while (i < cssText.length && cssText[i] !== '{') i++;
            if (i >= cssText.length) break;
            const selector = cssText.slice(selStart, i).trim();

            // Find matching '}' with brace depth (handles nested braces)
            i++; // skip '{'
            let depth = 1;
            let blockStart = i;
            while (i < cssText.length && depth > 0) {
                if (cssText[i] === '{') depth++;
                else if (cssText[i] === '}') depth--;
                i++;
            }
            if (depth > 0) {
                // Malformed, skip
                continue;
            }
            const cssRules = cssText.slice(blockStart, i - 1).trim();

            // Skip at-rules and keyframes/selectors without classes
            if (selector.startsWith('@')) continue;

            // Match: .classname or .!classname
            const classMatches = selector.match(/\.!?[A-Za-z0-9_-]+/g);
            if (!classMatches) continue;

            // Check if CSS rules contain !important
            const hasImportant = /\s!important/.test(cssRules);

            for (const classToken of classMatches) {
                const className = classToken.substring(1); // Remove the leading dot

                // Skip Tailwind-generated or already captured classes (check base name without !)
                const baseClassName = className.startsWith('!') ? className.slice(1) : className;
                if (this.isTailwindGeneratedClass(baseClassName)) continue;

                // Determine if this class should have !important
                const classHasImportantPrefix = className.startsWith('!');
                let finalCssRules = cssRules;

                if (classHasImportantPrefix) {
                    // Class has ! prefix, ensure CSS has !important
                    if (!hasImportant) {
                        finalCssRules = cssRules.includes(';') ?
                            cssRules.replace(/;/g, ' !important;') :
                            cssRules + ' !important';
                    }
                } else {
                    // Class doesn't have ! prefix, remove !important if present
                    if (hasImportant) {
                        finalCssRules = cssRules.replace(/\s!important/g, '');
                    }
                }

                // Store the class with its full name (including ! prefix) as the key
                // Ensure CSS is always a string
                const cssString = ensureCssString(finalCssRules);
                if (utilities.has(className)) {
                    const existingRules = utilities.get(className);

                    // Handle arrays properly - don't stringify them
                    if (Array.isArray(existingRules)) {
                        // If existing is an array, add this as a new entry
                        // Create a simple selector entry for the compound selector
                        utilities.set(className, [...existingRules, {
                            selector: `.${className}`,
                            css: cssString,
                            fullBlock: true // Compound selectors often have nested rules
                        }]);
                    } else {
                        // Existing is a string or object - convert to array format
                        const existingCssString = ensureCssString(existingRules);
                        utilities.set(className, [
                            { selector: `.${className}`, css: existingCssString },
                            { selector: `.${className}`, css: cssString, fullBlock: true }
                        ]);
                    }
                } else {
                    utilities.set(className, cssString);
                }
            }
        }
    } catch (e) {
        // Be tolerant: this is a best-effort extractor
    }

    // Universal fallback with basic nesting resolution for selectors using '&'
    // Captures context like :where(aside[popover]) &.appear-start &:not(:popover-open)
    try {
        const rules = [];

        // Minimal nested CSS resolver: scans and builds combined selectors
        // Only stores top-level rules with their full block content (including nested blocks)
        const resolveNested = (text, parentSelector = '', isTopLevel = true) => {
            let i = 0;
            while (i < text.length) {
                // Skip whitespace
                while (i < text.length && /\s/.test(text[i])) i++;
                if (i >= text.length) break;

                // Capture selector up to '{'
                let selStart = i;
                while (i < text.length && text[i] !== '{') i++;
                if (i >= text.length) break;
                const rawSelector = text.slice(selStart, i).trim();

                // Find matching '}' with brace depth
                i++; // skip '{'
                let depth = 1;
                let blockStart = i;
                while (i < text.length && depth > 0) {
                    if (text[i] === '{') depth++;
                    else if (text[i] === '}') depth--;
                    i++;
                }
                const block = text.slice(blockStart, i - 1);

                // Build combined selector by replacing '&' with parentSelector
                const combinedSelector = parentSelector
                    ? rawSelector.replace(/&/g, parentSelector).trim()
                    : rawSelector.trim();

                // Only store top-level rules (not nested blocks) with their full content
                // This preserves @starting-style and other nested at-rules in the CSS
                if (isTopLevel) {
                    const fullBlock = block.trim();
                    if (fullBlock) {
                        rules.push({ selector: combinedSelector, css: fullBlock, fullBlock: true });
                    }
                }

                // Recurse into nested blocks but don't store them separately
                // They're already included in the parent block's CSS
                resolveNested(block, combinedSelector, false);
            }
        };

        resolveNested(cssText, '');

        // Map resolved rules to utilities by class token presence
        for (const rule of rules) {
            // Clean selector: strip comments and normalize whitespace
            let cleanedSelector = rule.selector.replace(/\/\*[^]*?\*\//g, '').replace(/\s+/g, ' ').trim();
            // Match: .classname or .!classname
            const classTokens = cleanedSelector.match(/\.!?[A-Za-z0-9_-]+/g);
            if (!classTokens) continue;

            // Check if CSS rules contain !important
            const hasImportant = /\s!important/.test(rule.css);

            for (const token of classTokens) {
                const className = token.slice(1); // Remove the leading dot

                // Skip Tailwind-generated classes (check base name without !)
                const baseClassName = className.startsWith('!') ? className.slice(1) : className;
                if (this.isTailwindGeneratedClass(baseClassName)) continue;

                // Determine if this class should have !important
                const classHasImportantPrefix = className.startsWith('!');
                let finalCss = rule.css;

                if (classHasImportantPrefix) {
                    // Class has ! prefix, ensure CSS has !important
                    if (!hasImportant) {
                        finalCss = rule.css.includes(';') ?
                            rule.css.replace(/;/g, ' !important;') :
                            rule.css + ' !important';
                    }
                } else {
                    // Class doesn't have ! prefix, remove !important if present
                    if (hasImportant) {
                        finalCss = rule.css.replace(/\s!important/g, '');
                    }
                }

                // Store selector-aware utility so variants preserve context and pseudos
                // Use full className (including !) as the key
                // Preserve fullBlock flag if present
                // Ensure CSS is always a string
                const cssString = ensureCssString(finalCss);
                const value = {
                    selector: cleanedSelector,
                    css: cssString,
                    fullBlock: rule.fullBlock || false
                };
                if (utilities.has(className)) {
                    const existing = utilities.get(className);
                    if (typeof existing === 'string') {
                        const existingCssString = ensureCssString(existing);
                        utilities.set(className, [{ selector: `.${className}`, css: existingCssString }, value]);
                    } else if (Array.isArray(existing)) {
                        const found = existing.find(e => e.selector === value.selector);
                        if (found) {
                            // Ensure both are strings before concatenating
                            const foundCss = ensureCssString(found.css);
                            const valueCss = ensureCssString(value.css);
                            found.css = `${foundCss}; ${valueCss}`;
                        } else {
                            existing.push(value);
                        }
                    } else if (existing && existing.selector) {
                        if (existing.selector === value.selector) {
                            // Ensure both are strings before concatenating
                            const existingCss = ensureCssString(existing.css);
                            const valueCss = ensureCssString(value.css);
                            existing.css = `${existingCss}; ${valueCss}`;
                            utilities.set(className, [existing]);
                        } else {
                            utilities.set(className, [existing, value]);
                        }
                    }
                } else {
                    utilities.set(className, [value]);
                }
            }
        }
    } catch (e) {
        // Tolerate parsing errors; this is best-effort
    }

    return utilities;
};

// Check if a class name looks like a Tailwind-generated class
TailwindCompiler.prototype.isTailwindGeneratedClass = function (className) {
    // Check if this looks like a Tailwind-generated class
    const tailwindPatterns = [
        /^[a-z]+-\d+$/, // spacing, sizing classes like p-4, w-10
        /^[a-z]+-\[/, // arbitrary values like w-[100px]
        /^(text|bg|border|ring|shadow|opacity|scale|rotate|translate|skew|origin|transform|transition|duration|delay|ease|animate|backdrop|blur|brightness|contrast|drop-shadow|grayscale|hue-rotate|invert|saturate|sepia|filter|backdrop-)/, // common Tailwind prefixes
        /^(sm|md|lg|xl|2xl):/, // responsive prefixes
        /^(hover|focus|active|disabled|group-hover|group-focus|peer-hover|peer-focus):/, // state prefixes
        /^(dark|light):/, // theme prefixes
        /^!/, // important modifier
        /^\[/, // arbitrary selectors
    ];

    return tailwindPatterns.some(pattern => pattern.test(className));
};

// Parse a class name into its components (variants, base class, important)
TailwindCompiler.prototype.parseClassName = function (className) {
    // Check cache first
    if (this.classCache.has(className)) {
        return this.classCache.get(className);
    }

    const result = {
        important: className.startsWith('!'),
        variants: [],
        baseClass: className
    };

    // Remove important modifier if present
    if (result.important) {
        className = className.slice(1);
    }

    // Split by variant separator, but preserve content within brackets
    const parts = [];
    let current = '';
    let bracketDepth = 0;

    for (let i = 0; i < className.length; i++) {
        const char = className[i];

        if (char === '[') {
            bracketDepth++;
        } else if (char === ']') {
            bracketDepth--;
        }

        if (char === ':' && bracketDepth === 0) {
            parts.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    parts.push(current); // Add the last part

    result.baseClass = parts.pop(); // Last part is always the base class

    // Process variants in order (left to right)
    result.variants = parts.map(variant => {
        // FIRST: Check for exact variant matches (most common case)
        const exactSelector = this.variants[variant];
        if (exactSelector) {
            return {
                name: variant,
                selector: exactSelector,
                isArbitrary: false
            };
        }

        // SECOND: Check for arbitrary selector variants [&_selector]
        if (variant.startsWith('[') && variant.endsWith(']')) {
            const arbitrarySelector = variant.slice(1, -1); // Remove brackets
            if (arbitrarySelector.startsWith('&')) {
                return {
                    name: variant,
                    selector: arbitrarySelector,
                    isArbitrary: true
                };
            }
            // Handle arbitrary data variants like [data-state=active]
            if (arbitrarySelector.startsWith('data-')) {
                return {
                    name: variant,
                    selector: `[${arbitrarySelector}] &`,
                    isArbitrary: true
                };
            }
        }

        // THIRD: Handle parameterized variants (only if exact match not found)

        // Handle data-[...] variants like data-[state=active] (not starting with bracket)
        // These should be regular attribute selectors, not arbitrary
        const dataMatch = variant.match(/^data-\[(.+)\]$/);
        if (dataMatch) {
            const attrValue = dataMatch[1];
            // Add quotes around the value if it contains = (e.g., state=active -> state="active")
            const quotedValue = attrValue.includes('=')
                ? attrValue.replace(/^([^=]+)=(.+)$/, '$1="$2"')
                : attrValue;
            return {
                name: variant,
                selector: `[data-${quotedValue}] &`,
                isArbitrary: false
            };
        }

        // Handle parameterized nth variants: nth-3, nth-last-2, nth-of-type-2, nth-last-of-type-2
        const nthMatch = variant.match(/^(nth|nth-last|nth-of-type|nth-last-of-type)-(\d+)$/);
        if (nthMatch) {
            const baseVariant = nthMatch[1];
            const param = nthMatch[2];
            const baseSelector = this.variants[baseVariant];
            if (baseSelector) {
                return {
                    name: variant,
                    selector: `${baseSelector}(${param})`,
                    isArbitrary: false
                };
            }
        }

        // Handle arbitrary nth variants: nth-[4n+1], nth-[2n], nth-last-[n+3], nth-of-type-[odd], etc.
        const nthArbitraryMatch = variant.match(/^(nth|nth-last|nth-of-type|nth-last-of-type)-\[(.+)\]$/);
        if (nthArbitraryMatch) {
            const baseVariant = nthArbitraryMatch[1];
            const param = nthArbitraryMatch[2];
            const baseSelector = this.variants[baseVariant];
            if (baseSelector) {
                return {
                    name: variant,
                    selector: `${baseSelector}(${param})`,
                    isArbitrary: false
                };
            }
        }

        // Handle parameterized has/not variants: has-[>p], not-\[hidden\]
        const hasMatch = variant.match(/^has-\[(.+)\]$/);
        if (hasMatch) {
            const param = hasMatch[1];
            const baseSelector = this.variants['has'];
            if (baseSelector) {
                return {
                    name: variant,
                    selector: `${baseSelector}(${param})`,
                    isArbitrary: false
                };
            }
        }

        // Handle not-\[...\] variants like not-\[hidden\]
        // The backslashes escape the brackets in the class name
        // Match: not-\[content\] where content may have escaped brackets
        const notMatch = variant.match(/^not-\\\[(.+?)\\\]$/);
        if (notMatch) {
            const param = notMatch[1];
            // The parameter is already clean (backslashes were just for escaping brackets in class name)
            const baseSelector = this.variants['not'];
            if (baseSelector) {
                return {
                    name: variant,
                    selector: `${baseSelector}([${param}])`,
                    isArbitrary: false
                };
            }
        }

        // If no match found, warn and return null
        console.warn(`Unknown variant: ${variant}`);
        return null;
    }).filter(Boolean);

    // Cache the result
    this.classCache.set(className, result);
    return result;
};

