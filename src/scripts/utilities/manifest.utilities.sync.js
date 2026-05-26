// Synchronous utility generation
// Methods for generating utilities synchronously before first paint

TailwindCompiler.prototype.addCriticalBlockingStylesSync = function () {
    if (!this.criticalStyleElement) return;

    const syncStart = performance.now();

    try {
        // Extract CSS variables synchronously from already-loaded sources
        const cssVariables = new Map();

        // 1. From inline style elements (already in DOM)
        const inlineStyles = document.querySelectorAll('style:not(#manifest-styles):not(#manifest-styles-critical)');
        for (const styleEl of inlineStyles) {
            if (styleEl.textContent) {
                const variables = this.extractThemeVariables(styleEl.textContent);
                for (const [name, value] of variables.entries()) {
                    cssVariables.set(name, value);
                }
            }
        }

        // 2. From HTML source (parse style tags in HTML)
        try {
            if (document.documentElement) {
                const htmlSource = document.documentElement.outerHTML;
                const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
                let styleMatch;
                while ((styleMatch = styleRegex.exec(htmlSource)) !== null) {
                    const cssContent = styleMatch[1];
                    const variables = this.extractThemeVariables(cssContent);
                    for (const [name, value] of variables.entries()) {
                        cssVariables.set(name, value);
                    }
                }
            }
        } catch (e) {
            // Ignore parsing errors
        }

        // 3. From loaded stylesheets (synchronously read CSS rules)
        try {
            const stylesheets = Array.from(document.styleSheets);
            for (const sheet of stylesheets) {
                try {
                    // Try to access CSS rules (may fail due to CORS)
                    const rules = Array.from(sheet.cssRules || []);
                    for (const rule of rules) {
                        if (rule.type === CSSRule.STYLE_RULE && rule.styleSheet) {
                            // Handle @import rules that have nested stylesheets
                            try {
                                const nestedRules = Array.from(rule.styleSheet.cssRules || []);
                                for (const nestedRule of nestedRules) {
                                    if (nestedRule.type === CSSRule.STYLE_RULE) {
                                        const cssText = nestedRule.cssText;
                                        const variables = this.extractThemeVariables(cssText);
                                        for (const [name, value] of variables.entries()) {
                                            cssVariables.set(name, value);
                                        }
                                    }
                                }
                            } catch (e) {
                                // Ignore nested rule errors
                            }
                        }
                        if (rule.type === CSSRule.STYLE_RULE) {
                            const cssText = rule.cssText;
                            const variables = this.extractThemeVariables(cssText);
                            for (const [name, value] of variables.entries()) {
                                cssVariables.set(name, value);
                            }
                        }
                    }
                } catch (e) {
                    // CORS or other access errors - expected for some stylesheets
                }
            }
        } catch (e) {
        }

        // 4. From computed styles (if :root is available)
        try {
            if (document.documentElement && document.readyState !== 'loading') {
                const rootStyles = getComputedStyle(document.documentElement);
                let computedVars = 0;
                for (let i = 0; i < rootStyles.length; i++) {
                    const prop = rootStyles[i];
                    if (prop.startsWith('--')) {
                        const value = rootStyles.getPropertyValue(prop);
                        if (value && value.trim()) {
                            cssVariables.set(prop.substring(2), value.trim());
                            computedVars++;
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore errors
        }

        // 5. Scan for classes that need utilities
        const classesToGenerate = new Set();
        try {
            // Method A: Scan HTML source
            if (document.documentElement) {
                const htmlSource = document.documentElement.outerHTML;
                const classRegex = /class=["']([^"']+)["']/gi;
                let classMatch;
                while ((classMatch = classRegex.exec(htmlSource)) !== null) {
                    const classes = classMatch[1].split(/\s+/).filter(Boolean);
                    for (const cls of classes) {
                        // Match utility patterns that might use CSS variables
                        if (/^(border|bg|text|ring|outline|decoration|caret|accent|fill|stroke)-[a-z0-9-]+(\/[0-9]+)?$/.test(cls)) {
                            classesToGenerate.add(cls);
                        }
                    }
                }
            }

            // Method B: Scan DOM directly (if body exists)
            if (document.body) {
                const elements = document.body.querySelectorAll('*');
                for (const el of elements) {
                    if (el.className && typeof el.className === 'string') {
                        const classes = el.className.split(/\s+/).filter(Boolean);
                        for (const cls of classes) {
                            if (/^(border|bg|text|ring|outline|decoration|caret|accent|fill|stroke)-[a-z0-9-]+(\/[0-9]+)?$/.test(cls)) {
                                classesToGenerate.add(cls);
                            }
                        }
                    }
                }
            }

        } catch (e) {
        }

        // Generate utilities synchronously if we have CSS variables

        if (cssVariables.size > 0) {
            const generateStart = performance.now();
            const cssText = Array.from(cssVariables.entries())
                .map(([name, value]) => `--${name}: ${value};`)
                .join('\n');

            const tempCss = `:root { ${cssText} }`;

            // If we have classes, use them. Otherwise, try to get classes from cache
            let usedData = null; // Initialize to null so we can detect when it's not set
            if (classesToGenerate.size > 0) {
                usedData = {
                    classes: Array.from(classesToGenerate),
                    variableSuffixes: []
                };
            } else {
                // Try to get classes from cache (most efficient - only generate what was used before)
                const cached = localStorage.getItem('tailwind-cache');
                let cachedClasses = new Set();

                if (cached) {
                    try {
                        const parsed = JSON.parse(cached);
                        const cacheEntries = Object.values(parsed);

                        // Extract classes from cache keys (format: "class1,class2-themeHash")
                        for (const entry of cacheEntries) {
                            // Find the cache entry with the most recent timestamp
                            const mostRecent = cacheEntries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
                            if (mostRecent && mostRecent.css) {
                                // Extract class names from generated CSS
                                const classMatches = mostRecent.css.match(/\.([a-zA-Z0-9_-]+(?::[a-zA-Z0-9_-]+)*)\s*{/g);
                                if (classMatches) {
                                    for (const match of classMatches) {
                                        const className = match.replace(/^\./, '').replace(/\s*{.*$/, '');
                                        // Only include utility classes (not Tailwind native like red-500)
                                        if (/^(border|bg|text|ring|outline|decoration|caret|accent|fill|stroke)-[a-z0-9-]+(\/[0-9]+)?$/.test(className.split(':').pop())) {
                                            cachedClasses.add(className);
                                        }
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore cache parsing errors
                    }
                }

                if (cachedClasses.size > 0) {
                    usedData = {
                        classes: Array.from(cachedClasses),
                        variableSuffixes: []
                    };
                } else {
                    // Last resort: scan HTML source text directly
                    try {
                        const htmlText = document.documentElement.innerHTML || '';
                        const classMatches = htmlText.match(/class=["']([^"']+)["']/g);
                        if (classMatches) {
                            for (const match of classMatches) {
                                const classString = match.replace(/class=["']/, '').replace(/["']$/, '');
                                const classes = classString.split(/\s+/).filter(Boolean);
                                for (const cls of classes) {
                                    if (/^(border|bg|text|ring|outline|decoration|caret|accent|fill|stroke)-[a-z0-9-]+(\/[0-9]+)?$/.test(cls)) {
                                        cachedClasses.add(cls);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        // Ignore errors
                    }

                    if (cachedClasses.size > 0) {
                        usedData = {
                            classes: Array.from(cachedClasses),
                            variableSuffixes: []
                        };
                    }
                    // If still no classes, continue to generate utilities for all color variables
                }
            }

            // If no classes found, generate utilities for all color variables
            if (!usedData || !usedData.classes || usedData.classes.length === 0) {
                // Generate utilities for all color-* variables to prevent flash
                const colorVars = Array.from(cssVariables.entries())
                    .filter(([name]) => name.startsWith('color-'));

                if (colorVars.length > 0) {
                    // Create synthetic classes for all color utilities (text, bg, border)
                    const syntheticClasses = [];
                    for (const [varName] of colorVars) {
                        const suffix = varName.replace('color-', '');
                        syntheticClasses.push(`text-${suffix}`);
                        syntheticClasses.push(`bg-${suffix}`);
                        syntheticClasses.push(`border-${suffix}`);
                    }
                    usedData = {
                        classes: syntheticClasses,
                        variableSuffixes: []
                    };
                }
            }

            if (usedData && usedData.classes && usedData.classes.length > 0) {
                const generated = this.generateUtilitiesFromVars(tempCss, usedData);
                if (generated) {
                    const applyStart = performance.now();
                    this.criticalStyleElement.textContent = generated;

                    // Force a synchronous style recalculation
                    if (document.body) {
                        // Trigger a reflow to force style application
                        void document.body.offsetHeight;
                    } else {
                        // If body doesn't exist yet, force reflow on documentElement
                        void document.documentElement.offsetHeight;
                    }

                    const applyEnd = performance.now();
                }
            }
        }
    } catch (error) {
        // Silently fail - async compilation will handle it
    }
};

// Generate synchronous utilities (fallback method)
TailwindCompiler.prototype.generateSynchronousUtilities = function () {
    if (this.usesStaticPrerenderUtilities) return;
    try {
        // Always try to generate, even if cache exists, to catch any new classes
        const hasExistingStyles = this.styleElement.textContent && this.styleElement.textContent.trim();

        let cssVariables = new Map();
        const commonColorClasses = new Set();

        // Method 1: Extract from inline style elements
        const inlineStyles = document.querySelectorAll('style:not(#manifest-styles)');
        for (const styleEl of inlineStyles) {
            if (styleEl.textContent) {
                const variables = this.extractThemeVariables(styleEl.textContent);
                for (const [name, value] of variables.entries()) {
                    cssVariables.set(name, value);
                }
            }
        }

        // Method 2: Parse HTML source directly for CSS variables in <style> tags
        try {
            const htmlSource = document.documentElement.outerHTML;
            // Extract CSS from <style> tags in HTML source
            const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
            let styleMatch;
            while ((styleMatch = styleRegex.exec(htmlSource)) !== null) {
                const cssContent = styleMatch[1];
                const variables = this.extractThemeVariables(cssContent);
                for (const [name, value] of variables.entries()) {
                    cssVariables.set(name, value);
                }
            }
        } catch (e) {
            // Ignore parsing errors
        }

        // Method 3: Check computed styles from :root (if available)
        try {
            if (document.readyState !== 'loading') {
                const rootStyles = getComputedStyle(document.documentElement);
                // Extract all CSS variables, not just color ones
                const allProps = rootStyles.length;
                for (let i = 0; i < allProps; i++) {
                    const prop = rootStyles[i];
                    if (prop.startsWith('--')) {
                        const value = rootStyles.getPropertyValue(prop);
                        if (value && value.trim()) {
                            cssVariables.set(prop.substring(2), value.trim());
                        }
                    }
                }
            }
        } catch (e) {
            // Ignore errors accessing computed styles
        }

        // Method 4: Scan HTML source directly for class attributes
        try {
            const htmlSource = document.documentElement.outerHTML;
            // Extract all class attributes from HTML source
            const classRegex = /class=["']([^"']+)["']/gi;
            let classMatch;
            while ((classMatch = classRegex.exec(htmlSource)) !== null) {
                const classString = classMatch[1];
                const classes = classString.split(/\s+/).filter(Boolean);
                for (const cls of classes) {
                    // Match common color utility patterns (more comprehensive)
                    if (/^(border|bg|text|ring|outline|decoration|caret|accent|fill|stroke)-[a-z0-9-]+(\/[0-9]+)?$/.test(cls)) {
                        commonColorClasses.add(cls);
                    }
                }
            }
        } catch (e) {
            // Fallback: scan DOM if HTML parsing fails
            const elements = document.querySelectorAll('*');
            for (const el of elements) {
                if (el.className && typeof el.className === 'string') {
                    const classes = el.className.split(/\s+/);
                    for (const cls of classes) {
                        if (/^(border|bg|text|ring|outline|decoration|caret|accent|fill|stroke)-[a-z0-9-]+(\/[0-9]+)?$/.test(cls)) {
                            commonColorClasses.add(cls);
                        }
                    }
                }
            }
        }

        // If we have variables and classes, generate utilities
        if (cssVariables.size > 0 && commonColorClasses.size > 0) {
            const cssText = Array.from(cssVariables.entries())
                .map(([name, value]) => `--${name}: ${value};`)
                .join('\n');

            const tempCss = `:root { ${cssText} }`;
            const usedData = {
                classes: Array.from(commonColorClasses),
                variableSuffixes: []
            };

            const generated = this.generateUtilitiesFromVars(tempCss, usedData);
            if (generated) {
                const finalCss = `@layer utilities {\n${generated}\n}`;
                // Apply styles - append to existing if cache exists, replace if not
                if (hasExistingStyles) {
                    // Append new utilities to existing cache (they'll be deduplicated by CSS)
                    this.styleElement.textContent += '\n\n' + finalCss;
                } else {
                    this.styleElement.textContent = finalCss;
                }
                this.ensureUtilityStylesLast();

                // Clear critical styles once we have generated utilities
                if (this.criticalStyleElement && generated.trim()) {
                    this.criticalStyleElement.textContent = '';
                }
            }
        }
    } catch (error) {
        // Silently fail - async compilation will handle it
    }
};

