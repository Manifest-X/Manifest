// Compilation methods
// Main compilation logic and utility generation

// Generate utilities from CSS variables
TailwindCompiler.prototype.generateUtilitiesFromVars = function (cssText, usedData) {
    try {
        const utilities = [];
        const generatedRules = new Set(); // Track generated rules to prevent duplicates
        const variables = this.extractThemeVariables(cssText);
        const { classes: usedClasses, variableSuffixes } = usedData;

        if (variables.size === 0) {
            return '';
        }

        // Helper to escape special characters in class names
        const escapeClassName = (className) => {
            return className.replace(/[^a-zA-Z0-9-]/g, '\\$&');
        };

        // Helper to generate a single utility with its variants
        const generateUtility = (baseClass, css) => {
            // Find all variants of this base class that are actually used
            const usedVariants = usedClasses
                .filter(cls => {
                    const parts = cls.split(':');
                    const basePart = parts[parts.length - 1];
                    return basePart === baseClass || (basePart.startsWith('!') && basePart.slice(1) === baseClass);
                });

            // Generate base utility if it's used directly
            if (usedClasses.includes(baseClass)) {
                const rule = `.${escapeClassName(baseClass)} { ${css} }`;
                if (!generatedRules.has(rule)) {
                    utilities.push(rule);
                    generatedRules.add(rule);
                }
            }
            // Generate important version if used
            if (usedClasses.includes('!' + baseClass)) {
                const importantCss = css.includes(';') ?
                    css.replace(/;/g, ' !important;') :
                    css + ' !important';
                const rule = `.${escapeClassName('!' + baseClass)} { ${importantCss} }`;
                if (!generatedRules.has(rule)) {
                    utilities.push(rule);
                    generatedRules.add(rule);
                }
            }

            // Generate each variant as a separate class
            for (const variantClass of usedVariants) {
                if (variantClass === baseClass) continue;

                const parsed = this.parseClassName(variantClass);

                // Check if this is an important variant
                const isImportant = parsed.important;
                // Ensure css is a string (handle cases where it might be an object)
                const cssString = typeof css === 'string' ? css : (css && typeof css === 'object' && css.css ? css.css : String(css));
                const cssContent = isImportant ?
                    (cssString.includes(';') ? cssString.replace(/;/g, ' !important;') : cssString + ' !important') :
                    cssString;

                // Build selector by applying variants
                let selector = `.${escapeClassName(variantClass)}`;
                let hasMediaQuery = false;
                let mediaQueryRule = '';

                for (const variant of parsed.variants) {
                    if (variant.isArbitrary) {
                        // Handle arbitrary selectors like [&_figure] or [&_fieldset:has(legend):not(.whatever)]
                        // For selectors starting with &, replace & with the base class and use as regular selector
                        let arbitrarySelector = variant.selector;

                        if (arbitrarySelector.startsWith('&')) {
                            // Replace & with the base class selector and convert _ to spaces
                            arbitrarySelector = arbitrarySelector.replace(/_/g, ' ').replace(/&/g, selector);
                            selector = arbitrarySelector;
                        } else {
                            // For other arbitrary selectors (like data attributes), use nested CSS
                            arbitrarySelector = arbitrarySelector.replace(/_/g, ' ');
                            selector = { baseClass: selector, arbitrarySelector };
                        }
                    } else if (variant.selector.includes('&')) {
                        // Substitute & with the current selector. This produces flat CSS that
                        // works for both ancestor patterns (`.dark &` → `.dark .X`) and
                        // self-extending patterns (`& > p` → `.X > p`).
                        selector = variant.selector.replace(/&/g, selector);
                    } else if (variant.selector.startsWith(':')) {
                        // For pseudo-classes, append to selector
                        selector = `${selector}${variant.selector}`;
                    } else if (variant.selector.startsWith('@')) {
                        // For media queries, wrap the whole rule
                        hasMediaQuery = true;
                        mediaQueryRule = variant.selector;
                    }
                }

                // Generate the final rule
                let rule;
                if (typeof selector === 'object' && selector.arbitrarySelector) {
                    // Handle arbitrary selectors with nested CSS (for non-& selectors)
                    rule = `${selector.baseClass} {\n    ${selector.arbitrarySelector} {\n        ${cssContent}\n    }\n}`;
                } else {
                    // Regular selector
                    rule = `${selector} { ${cssContent} }`;
                }

                const finalRule = hasMediaQuery ?
                    `${mediaQueryRule} { ${rule} }` :
                    rule;

                if (!generatedRules.has(finalRule)) {
                    utilities.push(finalRule);
                    generatedRules.add(finalRule);
                }
            }
        };

        // Generate utilities based on variable prefix
        for (const [varName, varValue] of variables.entries()) {
            if (!varName.match(this.regexPatterns.tailwindPrefix)) {
                continue;
            }

            const suffix = varName.split('-').slice(1).join('-');
            const value = `var(--${varName})`;
            const prefix = varName.split('-')[0] + '-';
            const generator = this.utilityGenerators[prefix];

            if (generator) {
                const utilityPairs = generator(suffix, value);
                for (const [className, css] of utilityPairs) {
                    // Check if this specific utility class is actually used (including variants and important)
                    const isUsed = usedClasses.some(cls => {
                        // Parse the class to extract the base utility name
                        const parsed = this.parseClassName(cls);
                        const baseClass = parsed.baseClass;

                        // Check both normal and important versions
                        return baseClass === className ||
                            baseClass === '!' + className ||
                            (baseClass.startsWith('!') && baseClass.slice(1) === className);
                    });
                    if (isUsed) {
                        generateUtility(className, css);
                    }

                    // Check for opacity variants of this utility
                    const opacityVariants = usedClasses.filter(cls => {
                        // Parse the class to extract the base utility name
                        const parsed = this.parseClassName(cls);
                        const baseClass = parsed.baseClass;

                        // Check if this class has an opacity modifier and matches our base class
                        if (baseClass.includes('/')) {
                            const baseWithoutOpacity = baseClass.split('/')[0];
                            if (baseWithoutOpacity === className) {
                                const opacity = baseClass.split('/')[1];
                                // Validate that the opacity is a number between 0-100
                                return !isNaN(opacity) && opacity >= 0 && opacity <= 100;
                            }
                        }
                        return false;
                    });

                    // Generate opacity utilities for each variant found
                    for (const variant of opacityVariants) {
                        const opacity = variant.split('/')[1];
                        const opacityValue = `color-mix(in oklch, ${value} ${opacity}%, transparent)`;
                        const opacityCss = css.replace(value, opacityValue);
                        generateUtility(variant, opacityCss);
                    }
                }
            }
        }

        return utilities.join('\n');
    } catch (error) {
        console.error('Error generating utilities:', error);
        return '';
    }
};

// Generate custom utilities from discovered custom utility classes
TailwindCompiler.prototype.generateCustomUtilities = function (usedData) {
    try {
        const utilities = [];
        const generatedRules = new Set();
        const { classes: usedClasses } = usedData;

        // Helper to clean up [object Object] from CSS strings
        const cleanCssString = (css) => {
            if (typeof css !== 'string') return css;
            return css.replace(/\[object Object\](;?\s*)/g, '').trim();
        };

        if (this.customUtilities.size === 0) {
            return '';
        }

        // Helper to escape special characters in class names
        const escapeClassName = (className) => {
            return className.replace(/[^a-zA-Z0-9-]/g, '\\$&');
        };

        // Helper to replace & in CSS selectors (not in property values or comments)
        // IMPORTANT: For CSS nesting, we should NOT replace & in nested selectors
        // The & should remain as-is so CSS nesting works correctly
        // This function should only be used for legacy/flattened CSS, not nested CSS
        const replaceAmpersandInSelectors = (cssText, replacement) => {
            // For full blocks with nested rules, don't replace & at all - preserve CSS nesting
            // Check if this looks like nested CSS:
            // - Has & followed by :, ., [, or whitespace then { (nested selector)
            // - Has ] & (attribute selector followed by &, like [dir=rtl] &)
            // - Has & on its own line followed by :, ., or [ (common nested pattern)
            const hasNestedSelectors =
                /&\s*[:\.\[{]/.test(cssText) ||           // &:not(), &::before, &[attr], & {
                /&\s*\n\s*[:\.\[{]/.test(cssText) ||      // & on new line followed by selector
                /\]\s*&/.test(cssText) ||                 // [dir=rtl] & pattern
                /&\s*$/.test(cssText.split('\n').find(line => line.trim().startsWith('&')) || ''); // & on its own line

            if (hasNestedSelectors) {
                // This is nested CSS - don't replace &, preserve it as-is
                return cssText;
            }

            // Legacy behavior: replace & for flattened CSS (shouldn't be needed for nested CSS)
            let result = '';
            let i = 0;
            let inString = false;
            let stringChar = '';
            let inComment = false;

            while (i < cssText.length) {
                const char = cssText[i];
                const nextChar = i + 1 < cssText.length ? cssText[i + 1] : '';
                const prevChar = i > 0 ? cssText[i - 1] : '';

                // Handle strings
                if ((char === '"' || char === "'") && !inComment) {
                    if (!inString) {
                        inString = true;
                        stringChar = char;
                    } else if (char === stringChar && prevChar !== '\\') {
                        inString = false;
                        stringChar = '';
                    }
                    result += char;
                    i++;
                    continue;
                }

                if (inString) {
                    result += char;
                    i++;
                    continue;
                }

                // Handle comments
                if (char === '/' && nextChar === '*') {
                    inComment = true;
                    result += char;
                    i++;
                    continue;
                }

                if (inComment) {
                    if (char === '*' && nextChar === '/') {
                        inComment = false;
                        result += char;
                        i++;
                        continue;
                    }
                    result += char;
                    i++;
                    continue;
                }

                // Replace & when it's in a selector context (only for legacy/flattened CSS)
                if (char === '&') {
                    const lookAhead = cssText.slice(i + 1, Math.min(i + 10, cssText.length));
                    const isSelector =
                        lookAhead.match(/^[:\.\[\+\>~,)]/) ||
                        lookAhead.match(/^\s+[:\.\[\+\>~,{]/) ||
                        lookAhead === '' ||
                        lookAhead[0] === '\n' ||
                        (prevChar === '\n' && (lookAhead[0] === ':' || lookAhead[0] === '.' || lookAhead[0] === '[' || lookAhead[0] === ' '));

                    if (isSelector) {
                        result += replacement;
                        i++;
                        continue;
                    }
                }

                result += char;
                i++;
            }

            return result;
        };

        // Helper to generate a single utility with its variants
        const generateUtility = (baseClass, css, selectorInfo) => {
            // Ensure css is a string at the start
            if (typeof css !== 'string') {
                css = typeof css === 'object' && css && css.css ? css.css : String(css);
            }

            // Find all variants of this base class that are actually used
            const usedVariants = usedClasses
                .filter(cls => {
                    const parts = cls.split(':');
                    const basePart = parts[parts.length - 1];
                    const isMatch = basePart === baseClass || (basePart.startsWith('!') && basePart.slice(1) === baseClass);
                    return isMatch;
                });

            // Skip generating base utility - it already exists in the CSS
            // Only generate variants and important versions

            // Generate important version if used
            if (usedClasses.includes('!' + baseClass)) {
                // Check if CSS already has !important to avoid double !important
                const alreadyHasImportant = /\s!important/.test(css);
                const importantCss = alreadyHasImportant ? css :
                    (css.includes(';') ?
                        css.replace(/;/g, ' !important;') :
                        css + ' !important');
                let rule;
                if (selectorInfo && selectorInfo.selector) {
                    // If the original selector contains :where(), don't try to modify it
                    // Generate a separate rule for the important version
                    // This prevents :where(.row, .col) from becoming :where(.row, .!col) with !important on all
                    if (selectorInfo.selector.includes(':where(')) {
                        // For :where() selectors, generate individual class selector for important version
                        rule = `.${escapeClassName('!' + baseClass)} { ${importantCss} }`;
                    } else {
                        // For other contextual selectors, do the replacement
                        const variantSel = `.${escapeClassName('!' + baseClass)}`;
                        let contextual = selectorInfo.selector.replace(new RegExp(`\\.${baseClass}(?=[^a-zA-Z0-9_-]|$)`), variantSel);
                        if (contextual === selectorInfo.selector) {
                            // Fallback: append class to the end if base token not found
                            contextual = `${selectorInfo.selector}${variantSel}`;
                        }
                        rule = `${contextual} { ${importantCss} }`;
                    }
                } else {
                    rule = `.${escapeClassName('!' + baseClass)} { ${importantCss} }`;
                }
                if (!generatedRules.has(rule)) {
                    utilities.push(rule);
                    generatedRules.add(rule);
                }
            }

            // Generate each variant as a separate class
            for (const variantClass of usedVariants) {
                if (variantClass === baseClass) continue;

                const parsed = this.parseClassName(variantClass);

                // Check if this is an important variant
                const isImportant = parsed.important;
                // Ensure css is a string (handle cases where it might be an object)
                const cssString = typeof css === 'string' ? css : (css && typeof css === 'object' && css.css ? css.css : String(css));
                const cssContent = isImportant ?
                    (cssString.includes(';') ? cssString.replace(/;/g, ' !important;') : cssString + ' !important') :
                    cssString;

                // Build selector by applying variants
                let selector = `.${escapeClassName(variantClass)}`;
                let hasMediaQuery = false;
                let mediaQueryRule = '';
                let nestedSelector = null;

                for (const variant of parsed.variants) {
                    if (variant.isArbitrary) {
                        // Handle arbitrary selectors like [&_figure] or [&_fieldset:has(legend):not(.whatever)]
                        // For selectors starting with &, replace & with the base class and use as regular selector
                        let arbitrarySelector = variant.selector;

                        if (arbitrarySelector.startsWith('&')) {
                            // Replace & with the base class selector and convert _ to spaces
                            arbitrarySelector = arbitrarySelector.replace(/_/g, ' ').replace(/&/g, selector);
                            selector = arbitrarySelector;
                        } else {
                            // For other arbitrary selectors (like data attributes), use nested CSS
                            arbitrarySelector = arbitrarySelector.replace(/_/g, ' ');
                            selector = { baseClass: selector, arbitrarySelector };
                        }
                    } else if (variant.selector.includes('&')) {
                        // Substitute & with the current selector. This produces flat CSS that
                        // works for both ancestor patterns (`.dark &` → `.dark .X`) and
                        // self-extending patterns (`& > p` → `.X > p`).
                        selector = variant.selector.replace(/&/g, selector);
                    } else if (variant.selector.startsWith(':')) {
                        // For pseudo-classes, append to selector
                        selector = `${selector}${variant.selector}`;
                    } else if (variant.selector.startsWith('@')) {
                        // For media queries, wrap the whole rule
                        hasMediaQuery = true;
                        mediaQueryRule = variant.selector;
                    }
                }

                // Generate the final rule
                let rule;
                // Ensure cssContent is a string before using it anywhere
                let cssContentStr = typeof cssContent === 'string' ? cssContent : String(cssContent);
                // Clean up any [object Object] that might have snuck in
                cssContentStr = cssContentStr.replace(/\[object Object\](;?\s*)/g, '').trim();

                if (typeof selector === 'object' && selector.arbitrarySelector) {
                    // Handle arbitrary selectors with nested CSS (for non-& selectors)
                    rule = `${selector.baseClass} {\n    ${selector.arbitrarySelector} {\n        ${cssContentStr}\n    }\n}`;
                } else if (nestedSelector) {
                    // Handle nested selectors (variants ending with &)
                    // Check if CSS is a full block (contains nested blocks like @starting-style)
                    const isFullBlock = selectorInfo && selectorInfo.fullBlock !== undefined ? selectorInfo.fullBlock :
                        (cssContentStr.includes('@starting-style') ||
                            cssContentStr.includes('@media') ||
                            cssContentStr.includes('@supports') ||
                            (cssContentStr.includes('{') && cssContentStr.includes('}')));

                    // Regular selector or contextual replacement using original selector info
                    if (selectorInfo && selectorInfo.selector) {
                        // If the original selector contains :where(), don't try to modify it
                        if (selectorInfo.selector.includes(':where(')) {
                            // For :where() selectors, generate individual class selector
                            if (isFullBlock) {
                                const resolvedCss = replaceAmpersandInSelectors(cssContentStr, selector);
                                rule = `${selector} {\n    ${nestedSelector} {\n${resolvedCss}\n    }\n}`;
                            } else {
                                rule = `${selector} {\n    ${nestedSelector} {\n        ${cssContentStr}\n    }\n}`;
                            }
                        } else {
                            // For other contextual selectors, do the replacement
                            const contextualRe = new RegExp(`\\.${baseClass}(?=[^a-zA-Z0-9_-]|$)`);
                            let contextual = selectorInfo.selector.replace(contextualRe, selector);
                            if (contextual === selectorInfo.selector) {
                                // Fallback when base token not directly present
                                contextual = `${selectorInfo.selector}${selector}`;
                            }
                            if (isFullBlock) {
                                const resolvedCss = replaceAmpersandInSelectors(cssContentStr, contextual);
                                rule = `${contextual} {\n    ${nestedSelector} {\n${resolvedCss}\n    }\n}`;
                            } else {
                                rule = `${contextual} {\n    ${nestedSelector} {\n        ${cssContentStr}\n    }\n}`;
                            }
                        }
                    } else {
                        if (isFullBlock) {
                            const resolvedCss = replaceAmpersandInSelectors(cssContentStr, selector);
                            rule = `${selector} {\n    ${nestedSelector} {\n${resolvedCss}\n    }\n}`;
                        } else {
                            rule = `${selector} {\n    ${nestedSelector} {\n        ${cssContentStr}\n    }\n}`;
                        }
                    }
                } else {
                    // Check if CSS is a full block (contains nested blocks like @starting-style)
                    // Use selectorInfo.fullBlock if available, otherwise check CSS content
                    const isFullBlock = selectorInfo && selectorInfo.fullBlock !== undefined ? selectorInfo.fullBlock :
                        (cssContentStr.includes('@starting-style') ||
                            cssContentStr.includes('@media') ||
                            cssContentStr.includes('@supports') ||
                            (cssContentStr.includes('{') && cssContentStr.includes('}')));

                    // Regular selector or contextual replacement using original selector info
                    if (selectorInfo && selectorInfo.selector) {
                        // If the original selector contains :where(), don't try to modify it
                        // Instead, generate a separate rule for this specific class
                        // This prevents issues where :where(.row, .col) would become :where(.row, .!col)
                        // with !important applied to all classes
                        if (selectorInfo.selector.includes(':where(')) {
                            // For :where() selectors, generate individual class selector
                            // This ensures !important is only applied to the specific class
                            if (isFullBlock) {
                                // Full block CSS includes nested content with & references
                                // Replace & in selectors with the actual selector (handles all selector contexts)
                                const resolvedCss = replaceAmpersandInSelectors(cssContentStr, selector);
                                rule = `${selector} {\n${resolvedCss}\n}`;
                            } else {
                                rule = `${selector} { ${cssContentStr} }`;
                            }
                        } else {
                            // For other contextual selectors, do the replacement
                            const contextualRe = new RegExp(`\\.${baseClass}(?=[^a-zA-Z0-9_-]|$)`);
                            let contextual = selectorInfo.selector.replace(contextualRe, selector);
                            if (contextual === selectorInfo.selector) {
                                // Fallback when base token not directly present
                                contextual = `${selectorInfo.selector}${selector}`;
                            }
                            if (isFullBlock) {
                                // Replace & in selectors with the contextual selector (handles all selector contexts)
                                const resolvedCss = replaceAmpersandInSelectors(cssContentStr, contextual);
                                rule = `${contextual} {\n${resolvedCss}\n}`;
                            } else {
                                rule = `${contextual} { ${cssContentStr} }`;
                            }
                        }
                    } else {
                        if (isFullBlock) {
                            // Replace & in selectors with the actual selector (handles all selector contexts)
                            const resolvedCss = replaceAmpersandInSelectors(cssContentStr, selector);
                            rule = `${selector} {\n${resolvedCss}\n}`;
                        } else {
                            rule = `${selector} { ${cssContentStr} }`;
                        }
                    }
                }

                let finalRule;
                if (hasMediaQuery) {
                    // Wrap once for responsive variants unless the rule already contains @media
                    if (typeof rule === 'string' && rule.trim().startsWith('@media')) {
                        finalRule = rule;
                    } else {
                        finalRule = `${mediaQueryRule} { ${rule} }`;
                    }
                } else {
                    finalRule = rule;
                }

                if (!generatedRules.has(finalRule)) {
                    utilities.push(finalRule);
                    generatedRules.add(finalRule);
                }
            }
        };

        // Generate utilities for each custom class that's actually used
        for (const [className, cssOrSelector] of this.customUtilities.entries()) {
            // Normalize class name: if it starts with !, extract the base name
            const hasImportantPrefix = className.startsWith('!');
            const baseClassName = hasImportantPrefix ? className.slice(1) : className;

            // Check if this specific utility class is actually used (including variants and important)
            const isUsed = usedClasses.some(cls => {
                // Parse the class to extract the base utility name
                const parsed = this.parseClassName(cls);
                const baseClass = parsed.baseClass;

                // Check both normal and important versions
                return baseClass === className ||
                    baseClass === baseClassName ||
                    baseClass === '!' + baseClassName ||
                    (baseClass.startsWith('!') && baseClass.slice(1) === baseClassName);
            });

            if (isUsed) {
                // Normalize CSS: if className has ! prefix, the CSS should already have !important
                // But we need to pass the base class name to generateUtility
                let normalizedCss = cssOrSelector;
                if (typeof cssOrSelector === 'string') {
                    normalizedCss = cleanCssString(cssOrSelector);
                } else if (Array.isArray(cssOrSelector)) {
                    // For arrays, we'll handle each entry separately below
                } else if (cssOrSelector && cssOrSelector.css) {
                    // Ensure we extract the CSS string, not an object
                    const extracted = typeof cssOrSelector.css === 'string' ? cssOrSelector.css :
                        (cssOrSelector.css && typeof cssOrSelector.css === 'object' && cssOrSelector.css.css ? cssOrSelector.css.css :
                            String(cssOrSelector.css));
                    normalizedCss = cleanCssString(extracted);
                } else {
                    // Fallback: convert to string
                    normalizedCss = cleanCssString(String(cssOrSelector));
                }

                // Generate utility with base class name (without !)
                // The CSS already has !important if className started with !
                if (typeof cssOrSelector === 'string') {
                    generateUtility(baseClassName, normalizedCss, null);
                } else if (Array.isArray(cssOrSelector)) {
                    for (const entry of cssOrSelector) {
                        if (entry && entry.css && entry.selector) {
                            // Ensure entry.css is a string (not an object)
                            const extracted = typeof entry.css === 'string' ? entry.css :
                                (entry.css && typeof entry.css === 'object' && entry.css.css ? entry.css.css :
                                    String(entry.css));
                            const entryCss = cleanCssString(extracted);

                            generateUtility(baseClassName, entryCss, {
                                selector: entry.selector,
                                fullBlock: entry.fullBlock || false
                            });
                        }
                    }
                } else if (cssOrSelector && cssOrSelector.css && cssOrSelector.selector) {
                    // Ensure cssOrSelector.css is a string (not an object)
                    const extracted = typeof cssOrSelector.css === 'string' ? cssOrSelector.css :
                        (cssOrSelector.css && typeof cssOrSelector.css === 'object' && cssOrSelector.css.css ? cssOrSelector.css.css :
                            String(cssOrSelector.css));
                    const selectorCss = cleanCssString(extracted);

                    generateUtility(baseClassName, selectorCss, {
                        selector: cssOrSelector.selector,
                        fullBlock: cssOrSelector.fullBlock || false
                    });
                }
            }
        }

        return utilities.join('\n');
    } catch (error) {
        console.error('Error generating custom utilities:', error);
        return '';
    }
};

// Helper function to sort utilities so base classes come before variants
TailwindCompiler.prototype.sortUtilities = function(utilitiesText) {
    if (!utilitiesText) return '';
    
    // Split into individual rules (each rule starts with . or @media)
    const rules = [];
    let currentRule = '';
    const lines = utilitiesText.split('\n');
    
    for (const line of lines) {
        // Check if this line starts a new rule
        if (line.trim().match(/^(\.|@media|@layer|@supports)/)) {
            // Save previous rule if exists
            if (currentRule.trim()) {
                rules.push(currentRule.trim());
            }
            currentRule = line;
        } else {
            // Continue current rule
            currentRule += '\n' + line;
        }
    }
    // Add last rule
    if (currentRule.trim()) {
        rules.push(currentRule.trim());
    }
    
    // Sort: base utilities (no @media) come before variants (with @media)
    rules.sort((a, b) => {
        const aHasMedia = a.startsWith('@media');
        const bHasMedia = b.startsWith('@media');
        
        // Base utilities come before variants
        if (!aHasMedia && bHasMedia) return -1;
        if (aHasMedia && !bHasMedia) return 1;
        
        // Same type, maintain order
        return 0;
    });
    
    return rules.join('\n\n');
};

// Helper function to filter critical utilities that are already in layer utilities
TailwindCompiler.prototype.filterCriticalUtilities = function(criticalText, layerUtilities) {
    if (!criticalText || !layerUtilities) return '';
    
    // Extract base class names from layer utilities (including variants)
    const layerClassMatches = layerUtilities.match(/\.([a-zA-Z0-9_:!\\-]+)\s*{/g) || [];
    const layerClasses = new Set();
    
    for (const match of layerClassMatches) {
        // Remove escaping and extract class name
        const className = match.replace(/^\./, '').replace(/\s*{.*$/, '').replace(/\\/g, '');
        // Extract base class name (last part after colons for variants)
        const parts = className.split(':');
        const baseClass = parts.length > 1 ? parts[parts.length - 1] : className;
        // Remove ! prefix if present
        const cleanBase = baseClass.startsWith('!') ? baseClass.slice(1) : baseClass;
        layerClasses.add(cleanBase);
    }
    
    // Filter critical CSS to exclude utilities already in layer
    const criticalLines = criticalText.split('\n');
    const filteredCritical = [];
    let inRule = false;
    let currentRule = '';
    let ruleClass = '';
    
    for (const line of criticalLines) {
        // Check if line starts a new rule
        const ruleMatch = line.match(/^\.([a-zA-Z0-9_:!\\-]+)\s*{/);
        if (ruleMatch) {
            // Save previous rule if it wasn't filtered
            if (currentRule) {
                const prevBaseClass = ruleClass.replace(/\\/g, '').split(':').pop().replace(/^!/, '');
                if (!layerClasses.has(prevBaseClass)) {
                    filteredCritical.push(currentRule);
                }
            }
            // Start new rule
            ruleClass = ruleMatch[1];
            currentRule = line;
            inRule = true;
        } else if (inRule) {
            currentRule += '\n' + line;
            if (line.trim() === '}') {
                // End of rule - check if we should keep it
                const baseClass = ruleClass.replace(/\\/g, '').split(':').pop().replace(/^!/, '');
                if (!layerClasses.has(baseClass)) {
                    filteredCritical.push(currentRule);
                }
                currentRule = '';
                ruleClass = '';
                inRule = false;
            }
        } else {
            // Not in a rule, keep as-is (comments, etc.)
            filteredCritical.push(line);
        }
    }
    
    // Add any remaining rule
    if (currentRule) {
        const baseClass = ruleClass.replace(/\\/g, '').split(':').pop().replace(/^!/, '');
        if (!layerClasses.has(baseClass)) {
            filteredCritical.push(currentRule);
        }
    }
    
    return filteredCritical.join('\n').trim();
};

// Main compilation method
TailwindCompiler.prototype.compile = async function () {
    if (this.usesStaticPrerenderUtilities) return;

    const compileStart = performance.now();

    try {
        // Prevent too frequent compilations
        const now = Date.now();
        if (now - this.lastCompileTime < this.minCompileInterval) {
            return;
        }
        this.lastCompileTime = now;

        if (this.isCompiling) {
            return;
        }
        this.isCompiling = true;

        // On first run, scan static classes and CSS variables
        if (!this.hasScannedStatic) {
            await this.scanStaticClasses();

            // Fetch CSS content once for initial compilation
            const themeCss = await this.fetchThemeContent();
            if (themeCss && themeCss.all) {
                // Extract custom utility classes from non-framework CSS only.
                // Framework semantic classes (.brand, .row, .col, etc.) already
                // live in the compiled manifest.css; re-emitting them here would
                // duplicate rules in #manifest-styles.
                const discoveredCustomUtilities = this.extractCustomUtilities(themeCss.userScannable);
                for (const [name, value] of discoveredCustomUtilities.entries()) {
                    this.customUtilities.set(name, value);
                }

                // CSS variables can live in any stylesheet — scan everything.
                const variables = this.extractThemeVariables(themeCss.all);
                for (const [name, value] of variables.entries()) {
                    this.currentThemeVars.set(name, value);
                }

                // Generate utilities for all static classes
                const staticUsedData = {
                    classes: Array.from(this.staticClassCache),
                    variableSuffixes: []
                };
                // Process static classes for variable suffixes
                for (const cls of this.staticClassCache) {
                    const parts = cls.split(':');
                    const baseClass = parts[parts.length - 1];
                    const classParts = baseClass.split('-');
                    if (classParts.length > 1) {
                        staticUsedData.variableSuffixes.push(classParts.slice(1).join('-'));
                    }
                }

                // Generate both variable-based and custom utilities
                const varUtilities = this.generateUtilitiesFromVars(themeCss.all, staticUsedData);
                const customUtilitiesGenerated = this.generateCustomUtilities(staticUsedData);

                let allUtilities = [varUtilities, customUtilitiesGenerated].filter(Boolean).join('\n\n');
                // Sort utilities so base classes come before variants
                allUtilities = this.sortUtilities(allUtilities);
                
                if (allUtilities) {
                    const finalCss = `@layer utilities {\n${allUtilities}\n}`;

                    this.styleElement.textContent = finalCss;
                    this.ensureUtilityStylesLast();
                    this.scheduleEnsureUtilityStylesLast();

                    // Remove critical style element entirely after compilation
                    // Use requestAnimationFrame to ensure styles are painted before removing
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            // Double RAF ensures paint has occurred
                            if (this.criticalStyleElement && this.criticalStyleElement.parentNode) {
                                this.criticalStyleElement.parentNode.removeChild(this.criticalStyleElement);
                                this.criticalStyleElement = null;
                            }
                            this.ensureUtilityStylesLast();
                        });
                    });
                    this.lastClassesHash = staticUsedData.classes.sort().join(',');

                    // Save to cache for next page load
                    const themeHash = this.generateThemeHash(themeCss.all);
                    const cacheKey = `${this.lastClassesHash}-${themeHash}`;
                    this.cache.set(cacheKey, {
                        css: finalCss,
                        timestamp: Date.now(),
                        themeHash: themeHash
                    });
                    this.savePersistentCache();
                }
            }

            this.hasInitialized = true;
            this.isCompiling = false;
            return;
        }

        // For subsequent compilations, check for new dynamic classes
        const usedData = this.getUsedClasses();
        const dynamicClasses = Array.from(this.dynamicClassCache);

        // Create a hash of current dynamic classes to detect changes
        const dynamicClassesHash = dynamicClasses.sort().join(',');

        // Check if dynamic classes have actually changed
        if (dynamicClassesHash !== this.lastClassesHash || !this.hasInitialized) {
            // Fetch CSS content for dynamic compilation
            const themeCss = await this.fetchThemeContent();
            if (!themeCss || !themeCss.all) {
                this.isCompiling = false;
                return;
            }

            // Update custom utilities cache from non-framework CSS only — see
            // first compile path for rationale.
            const discoveredCustomUtilities = this.extractCustomUtilities(themeCss.userScannable);
            for (const [name, value] of discoveredCustomUtilities.entries()) {
                this.customUtilities.set(name, value);
            }

            // Check for variable changes
            const variables = this.extractThemeVariables(themeCss.all);
            let hasVariableChanges = false;
            for (const [name, value] of variables.entries()) {
                const currentValue = this.currentThemeVars.get(name);
                if (currentValue !== value) {
                    hasVariableChanges = true;
                    this.currentThemeVars.set(name, value);
                }
            }

            // Generate utilities for all classes (static + dynamic) if needed
            if (hasVariableChanges || dynamicClassesHash !== this.lastClassesHash) {

                // Generate both variable-based and custom utilities
                const varUtilities = this.generateUtilitiesFromVars(themeCss.all, usedData);
                const customUtilitiesGenerated = this.generateCustomUtilities(usedData);

                let allUtilities = [varUtilities, customUtilitiesGenerated].filter(Boolean).join('\n\n');
                // Sort utilities so base classes come before variants
                allUtilities = this.sortUtilities(allUtilities);
                
                if (allUtilities) {
                    const finalCss = `@layer utilities {\n${allUtilities}\n}`;

                    this.styleElement.textContent = finalCss;
                    this.ensureUtilityStylesLast();
                    this.scheduleEnsureUtilityStylesLast();

                    // Remove critical style element entirely after compilation
                    // Use requestAnimationFrame to ensure styles are painted before removing
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            // Double RAF ensures paint has occurred
                            if (this.criticalStyleElement && this.criticalStyleElement.parentNode) {
                                this.criticalStyleElement.parentNode.removeChild(this.criticalStyleElement);
                                this.criticalStyleElement = null;
                            }
                            this.ensureUtilityStylesLast();
                        });
                    });
                    this.lastClassesHash = dynamicClassesHash;

                    // Save to cache for next page load
                    const themeHash = this.generateThemeHash(themeCss.all);
                    const cacheKey = `${this.lastClassesHash}-${themeHash}`;
                    this.cache.set(cacheKey, {
                        css: finalCss,
                        timestamp: Date.now(),
                        themeHash: themeHash
                    });
                    this.savePersistentCache();
                }
            }
        }

    } catch (error) {
        console.error('[Manifest Utilities] Error compiling Tailwind CSS:', error);
    } finally {
        this.isCompiling = false;
    }
};

