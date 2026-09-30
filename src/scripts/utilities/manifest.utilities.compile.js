// Compilation logic and utility generation

// Generate utilities from CSS variables
TailwindCompiler.prototype.generateUtilitiesFromVars = function (cssText, usedData) {
    try {
        const utilities = [];
        const generatedRules = new Set(); // Track generated rules to prevent duplicates
        const variables = this.extractThemeVariables(cssText);
        const { classes: usedClasses, variableSuffixes } = usedData;
        // Optional: raw rules + their full-regen order keys (incremental apply places deltas by them)
        const rulesOut = usedData.rulesOut, keysOut = usedData.keysOut;
        let slot = null;
        const emit = (rule, sub) => { utilities.push(rule); if (rulesOut) { rulesOut.push(rule); keysOut.push(slot.concat(slot[3] ? 2 : sub)); } }; // opacity rules order by discovery

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
                    emit(rule, 0);
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
                    emit(rule, 1);
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
                    emit(finalRule, 2);
                    generatedRules.add(finalRule);
                }
            }
        };

        // Every generated class ends in its variable's suffix: skip variables no used class mentions
        const usedBases = usedClasses.map(cls => this.parseClassName(cls).baseClass);

        // Generate utilities based on variable prefix
        let vi = -1;
        for (const [varName, varValue] of variables.entries()) {
            vi++;
            if (!varName.match(this.regexPatterns.tailwindPrefix)) {
                continue;
            }

            const suffix = varName.split('-').slice(1).join('-');
            if (!usedBases.some(base => base.includes(suffix))) continue;
            const value = `var(--${varName})`;
            const prefix = varName.split('-')[0] + '-';
            const generator = this.utilityGenerators[prefix];

            if (generator) {
                const utilityPairs = generator(suffix, value);
                for (let pi = 0; pi < utilityPairs.length; pi++) {
                    const [className, css] = utilityPairs[pi];
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
                        slot = [0, vi, pi, 0];
                        generateUtility(className, css);
                    }

                    // Opacity variants: collect the bare base (e.g. `bg-black/10`),
                    // not the prefixed class — generateUtility discovers variant
                    // prefixes itself, so passing the bare base emits the correct
                    // selector (`.backdrop\:bg-black\/10::backdrop`).
                    const opacityBaseClasses = new Set();
                    for (const cls of usedClasses) {
                        // Parse the class to extract the base utility name
                        const parsed = this.parseClassName(cls);
                        const baseClass = parsed.baseClass;

                        // Check if this class has an opacity modifier and matches our base class
                        if (baseClass.includes('/')) {
                            const baseWithoutOpacity = baseClass.split('/')[0];
                            if (baseWithoutOpacity === className) {
                                const opacity = baseClass.split('/')[1];
                                // Validate that the opacity is a number between 0-100
                                if (!isNaN(opacity) && opacity >= 0 && opacity <= 100) {
                                    opacityBaseClasses.add(baseClass);
                                }
                            }
                        }
                    }

                    // Generate opacity utilities for each opacity value found
                    for (const opacityBaseClass of opacityBaseClasses) {
                        const opacity = opacityBaseClass.split('/')[1];
                        const opacityValue = `color-mix(in oklch, ${value} ${opacity}%, transparent)`;
                        const opacityCss = css.replace(value, opacityValue);
                        slot = [0, vi, pi, 1];
                        generateUtility(opacityBaseClass, opacityCss);
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
        const rulesOut = usedData.rulesOut, keysOut = usedData.keysOut;
        let slot = null;
        const emit = (rule, sub) => { utilities.push(rule); if (rulesOut) { rulesOut.push(rule); keysOut.push(slot.concat(sub)); } };

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

        // Replace & in selectors — legacy/flattened CSS only; nested CSS keeps &
        // as-is so native nesting works.
        const replaceAmpersandInSelectors = (cssText, replacement) => {
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
                    emit(rule, 1);
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
                    emit(finalRule, 2);
                    generatedRules.add(finalRule);
                }
            }
        };

        // Generate utilities for each custom class that's actually used
        let ci = -1;
        for (const [className, cssOrSelector] of this.customUtilities.entries()) {
            ci++;
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
                    slot = [1, ci, 0, 0];
                    generateUtility(baseClassName, normalizedCss, null);
                } else if (Array.isArray(cssOrSelector)) {
                    for (let ai = 0; ai < cssOrSelector.length; ai++) {
                        const entry = cssOrSelector[ai];
                        slot = [1, ci, ai, 0];
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

                    slot = [1, ci, 0, 0];
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

// Split generated CSS into top-level rules (each starts with . or an at-rule)
TailwindCompiler.prototype.splitUtilityRules = function (utilitiesText) {
    const rules = [];
    let currentRule = '';
    for (const line of utilitiesText.split('\n')) {
        if (line.trim().match(/^(\.|@media|@layer|@supports)/)) {
            if (currentRule.trim()) rules.push(currentRule.trim());
            currentRule = line;
        } else {
            currentRule += '\n' + line;
        }
    }
    if (currentRule.trim()) rules.push(currentRule.trim());
    return rules;
};

// Sort utilities so base classes come before variants (@media)
TailwindCompiler.prototype.sortUtilities = function (utilitiesText) {
    if (!utilitiesText) return '';
    const rules = this.splitUtilityRules(utilitiesText);
    rules.sort((a, b) => {
        const aHasMedia = a.startsWith('@media');
        const bHasMedia = b.startsWith('@media');
        if (!aHasMedia && bHasMedia) return -1;
        if (aHasMedia && !bHasMedia) return 1;
        return 0;
    });
    return rules.join('\n\n');
};

// ---- Incremental apply: new rules go in through CSSOM, never a whole-sheet rewrite ----
// Entries mirror the layer's cssRules 1:1, each keyed by where a full regen would emit it
// ([media, section, var/entry, pair/array, region, sub]); deltas are inserted at that index.

const utilitiesCssFrom = (applied) => `@layer utilities {\n${applied.entries.map(e => e.rule).join('\n\n')}\n}`;
const isMediaRule = (rule) => rule.trim().startsWith('@media');

function compareKeys(a, b) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

// Raw rules + order keys for a class set, as a full regen would emit them (base before @media, stable)
TailwindCompiler.prototype.generateKeyedUtilities = function (themeCss, classes) {
    const usedData = { classes, variableSuffixes: [], rulesOut: [], keysOut: [] };
    this.generateUtilitiesFromVars(themeCss, usedData);
    this.generateCustomUtilities(usedData);
    const out = usedData.rulesOut.map((rule, i) => {
        const media = isMediaRule(rule) ? 1 : 0;
        return { rule, key: [media].concat(usedData.keysOut[i]) };
    });
    return out.filter(e => !e.key[0]).concat(out.filter(e => e.key[0]));
};

TailwindCompiler.prototype.utilitiesLayerRule = function () {
    const sheet = this.styleElement && this.styleElement.sheet;
    if (!sheet || typeof CSSLayerBlockRule === 'undefined') return null;
    try {
        for (const rule of sheet.cssRules) {
            if (rule instanceof CSSLayerBlockRule && rule.name === 'utilities') return rule;
        }
    } catch (e) { }
    return null;
};

// Entries must match the parsed sheet rule-for-rule, or deltas could land at the wrong index
TailwindCompiler.prototype.entriesMatchSheet = function (entries) {
    const layer = this.utilitiesLayerRule();
    if (!layer || layer.cssRules.length !== entries.length) return false;
    for (let i = 0; i < entries.length; i++) {
        if ((layer.cssRules[i] instanceof CSSMediaRule) !== !!entries[i].key[0]) return false;
    }
    return true;
};

// After a full write: remember its rules so later compiles can insert beside them
TailwindCompiler.prototype.recordAppliedUtilities = function (entries, themeCss) {
    this._applied = null;
    if (window.__manifestRender === true || !this.entriesMatchSheet(entries)) return;
    this._applied = {
        themeKey: this.lastThemeKey,
        themeCss,           // keys index this exact variable order
        entries,
        rules: new Set(entries.map(e => e.rule)),
        classes: new Set(this.dynamicClassCache),
        dirty: false        // inserted rules not yet in textContent
    };
};

// Moving <style> rebuilds its sheet from textContent: write inserted rules back first
TailwindCompiler.prototype.resyncUtilitiesText = function () {
    const applied = this._applied;
    if (!applied || !applied.dirty) return;
    applied.dirty = false;
    this.styleElement.textContent = utilitiesCssFrom(applied);
    if (!this.entriesMatchSheet(applied.entries)) this._applied = null;
};

// Prerender snapshots read #manifest-styles text, so render passes always rewrite it
TailwindCompiler.prototype.canCompileDelta = function () {
    return !!this._applied && window.__manifestRender !== true && !!this.utilitiesLayerRule();
};

// Generate only never-compiled classes and insert each rule where a full regen would put it.
// Returns false when a rule's place depends on class discovery order: caller does a full compile.
TailwindCompiler.prototype.compileDelta = function (themeCss) {
    const applied = this._applied;
    const candidates = [];
    for (const cls of this.dynamicClassCache) if (!applied.classes.has(cls)) candidates.push(cls);
    const classes = this.filterStaticallyCoveredClasses(candidates);
    const fresh = classes.length ? this.generateKeyedUtilities(themeCss, classes).filter(e => !applied.rules.has(e.rule)) : [];
    const entries = applied.entries;

    // Place every rule first; bail before touching the sheet if any is ambiguous
    const plan = [];
    for (const e of fresh) {
        let lo = 0, hi = entries.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (compareKeys(entries[mid].key, e.key) <= 0) lo = mid + 1; else hi = mid; }
        // Same utility, same group, both variants: full regen orders them by discovery
        if (e.key[5] === 2) {
            const sameSlot = (x) => x && compareKeys(x.key.slice(0, 5), e.key.slice(0, 5)) === 0 && x.key[5] === 2;
            if (sameSlot(entries[lo - 1]) || sameSlot(entries[lo]) || plan.some(q => sameSlot(q.e))) return false;
        }
        plan.push({ e, at: lo });
    }
    for (const cls of candidates) applied.classes.add(cls);
    if (!plan.length) return true;

    const layer = this.utilitiesLayerRule();
    try {
        // Insert in key order; each insert shifts later indices by one
        plan.sort((x, y) => compareKeys(x.e.key, y.e.key));
        plan.forEach((q, n) => {
            layer.insertRule(q.e.rule, q.at + n);
            entries.splice(q.at + n, 0, q.e);
            applied.rules.add(q.e.rule);
        });
    } catch (err) {
        // A rule the parser splits or drops: the planned indices no longer hold
        this._applied = null;
        return false;
    }
    applied.dirty = true;
    this.schedulePersistentSave(themeCss);
    return true;
};

// Coalesce cache writes: localStorage serialisation is too slow to run per compile
TailwindCompiler.prototype.schedulePersistentSave = function (themeCss) {
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
        if (!this._applied) return;
        const classesHash = Array.from(this.dynamicClassCache).sort().join(',');
        const themeHash = this.generateThemeHash(themeCss);
        this.cache.set(`${classesHash}-${themeHash}`, {
            css: utilitiesCssFrom(this._applied),
            timestamp: Date.now(),
            themeHash
        });
        this.savePersistentCache();
    }, 1000);
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
    if (this.usesStaticPrerenderUtilities) {
        // Static utilities shipped with the page — nothing to compile.
        if (!window.__manifestUtilitiesReady) {
            window.__manifestUtilitiesReady = true;
            window.dispatchEvent(new CustomEvent('manifest:utilities-ready'));
        }
        return;
    }

    const compileStart = performance.now();

    try {
        // Throttled or busy: don't DROP the request — queue exactly one retry
        // so late-discovered classes (md: variants on swapped-in components)
        // always get compiled. The pending counter lets manifest:ready and the
        // prerenderer's settle hold until utilities are actually current.
        const now = Date.now();
        if (now - this.lastCompileTime < this.minCompileInterval || this.isCompiling) {
            if (!this._retryQueued) {
                this._retryQueued = true;
                window.__manifestUtilitiesPending = (window.__manifestUtilitiesPending || 0) + 1;
                setTimeout(() => {
                    this._retryQueued = false;
                    window.__manifestUtilitiesPending = Math.max(0, (window.__manifestUtilitiesPending || 1) - 1);
                    this.compile();
                }, this.minCompileInterval + 50);
            }
            return;
        }
        this.lastCompileTime = now;
        this.isCompiling = true;
        this.quietClasses.clear(); // this compile covers them
        window.__manifestUtilitiesPending = (window.__manifestUtilitiesPending || 0) + 1;
        this._compileCounted = true;

        // On first run, scan static classes and CSS variables
        if (!this.hasScannedStatic) {
            await this.scanStaticClasses();

            // Wait for the static utilities sheet's covered-class read to
            // settle (capped at 2s in detectStaticUtilitiesSheet) so this
            // first compile decision isn't a guess — see static.js.
            if (this.staticUtilitiesReady) await this.staticUtilitiesReady;

            // Fetch CSS content once for initial compilation
            const themeCss = await this.fetchThemeContent();
            if (themeCss) {
                // Extract custom utilities. Framework CSS is scanned too so the
                // generator can emit variants of semantic classes (md:row,
                // hover:brand); base forms are suppressed in generateCustomUtilities.
                const discoveredCustomUtilities = this.extractCustomUtilities(themeCss);
                for (const [name, value] of discoveredCustomUtilities.entries()) {
                    this.customUtilities.set(name, value);
                }

                const variables = this.extractThemeVariables(themeCss);
                for (const [name, value] of variables.entries()) {
                    this.currentThemeVars.set(name, value);
                }

                // Generate utilities for all static classes (minus anything the
                // static utilities sheet already covers).
                const staticUsedData = {
                    classes: this.filterStaticallyCoveredClasses(Array.from(this.staticClassCache)),
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
                const varUtilities = this.generateUtilitiesFromVars(themeCss, staticUsedData);
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
                    const themeHash = this.generateThemeHash(themeCss);
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

        // Theme unchanged since the last full write: insert only the new classes
        let prefetchedTheme = null;
        if (this.canCompileDelta()) {
            prefetchedTheme = await this.fetchThemeContent();
            if (prefetchedTheme && this.lastThemeKey === this._applied.themeKey && this.compileDelta(this._applied.themeCss)) return;
        }

        // For subsequent compilations, check for new dynamic classes
        const usedData = this.getUsedClasses();
        const dynamicClasses = Array.from(this.dynamicClassCache);

        // Create a hash of current dynamic classes to detect changes
        const dynamicClassesHash = dynamicClasses.sort().join(',');

        // Check if dynamic classes have actually changed
        if (dynamicClassesHash !== this.lastClassesHash || !this.hasInitialized) {
            // Fetch CSS content for dynamic compilation
            const themeCss = prefetchedTheme || await this.fetchThemeContent();
            if (!themeCss) {
                this.isCompiling = false;
                return;
            }

            // Update custom utilities cache if needed
            const discoveredCustomUtilities = this.extractCustomUtilities(themeCss);
            for (const [name, value] of discoveredCustomUtilities.entries()) {
                this.customUtilities.set(name, value);
            }

            // Check for variable changes
            const variables = this.extractThemeVariables(themeCss);
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
                const rulesOut = [], keysOut = [];
                const keyedData = Object.assign({}, usedData, { rulesOut, keysOut });
                const varUtilities = this.generateUtilitiesFromVars(themeCss, keyedData);
                const customUtilitiesGenerated = this.generateCustomUtilities(keyedData);

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
                    const entries = rulesOut.map((rule, i) => ({ rule, key: [isMediaRule(rule) ? 1 : 0].concat(keysOut[i]) }));
                    this.recordAppliedUtilities(entries.filter(e => !e.key[0]).concat(entries.filter(e => e.key[0])), themeCss);

                    // Save to cache for next page load
                    const themeHash = this.generateThemeHash(themeCss);
                    const cacheKey = `${this.lastClassesHash}-${themeHash}`;
                    this.cache.set(cacheKey, {
                        css: finalCss,
                        timestamp: Date.now(),
                        themeHash: themeHash
                    });
                    this.savePersistentCache();
                }
            } else {
                this._applied = null; // theme text moved: order keys are stale until the next full write
            }
        }

    } catch (error) {
        console.error('[Manifest Utilities] Error compiling Tailwind CSS:', error);
    } finally {
        this.isCompiling = false;
        if (this._compileCounted) {
            this._compileCounted = false;
            window.__manifestUtilitiesPending = Math.max(0, (window.__manifestUtilitiesPending || 1) - 1);
            if (!window.__manifestUtilitiesPending) {
                window.dispatchEvent(new CustomEvent('manifest:utilities-idle'));
            }
        }
        // First-compile settle signal for the manifest:ready coordinator.
        if (!window.__manifestUtilitiesReady) {
            window.__manifestUtilitiesReady = true;
            window.dispatchEvent(new CustomEvent('manifest:utilities-ready'));
        }
    }
};

