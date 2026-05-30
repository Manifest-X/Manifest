// DOM observation and event handling
// Methods for watching DOM changes and triggering recompilation

// Setup component load listener and MutationObserver
TailwindCompiler.prototype.setupComponentLoadListener = function () {
    // Use a single debounced handler for all component-related events
    const debouncedCompile = this.debounce(() => {
        if (!this.isCompiling) {
            this.compile();
        }
    }, this.options.debounceTime);

    // Listen for custom events when components are loaded/processed
    // Support both old (manifest) and new (manifest) event names for compatibility
    const handleComponentEvent = () => {
        // If we haven't scanned static classes yet, trigger a full re-scan
        // This ensures component HTML files are scanned for utility classes
        if (!this.hasScannedStatic) {
            // Reset the scan promise to allow re-scanning
            this.staticScanPromise = null;
            this.hasScannedStatic = false;
        }
        debouncedCompile();
    };

    document.addEventListener('manifest:component-loaded', handleComponentEvent);
    document.addEventListener('manifest:components-processed', handleComponentEvent);
    document.addEventListener('manifest:components-ready', handleComponentEvent);
    // Also listen for manifest-prefixed events (for future compatibility)
    document.addEventListener('manifest:components-processed', handleComponentEvent);
    document.addEventListener('manifest:components-ready', handleComponentEvent);

    // Listen for route changes but don't recompile unnecessarily
    document.addEventListener('manifest:route-change', (event) => {
        // Only trigger compilation if we detect new dynamic classes
        // The existing MutationObserver will handle actual DOM changes
        if (this.hasScannedStatic) {
            // Wait longer for route content to fully load before checking
            setTimeout(() => {
                const currentDynamicCount = this.dynamicClassCache.size;
                const currentClassesHash = this.lastClassesHash;

                // Scan for new classes
                const usedData = this.getUsedClasses();
                const newDynamicCount = this.dynamicClassCache.size;
                const dynamicClasses = Array.from(this.dynamicClassCache);
                const newClassesHash = dynamicClasses.sort().join(',');

                // Only compile if we found genuinely new classes, not just code processing artifacts
                if (newDynamicCount > currentDynamicCount && newClassesHash !== currentClassesHash) {
                    const newClasses = dynamicClasses.filter(cls =>
                        // Filter out classes that are likely from code processing
                        !cls.includes('hljs') &&
                        !cls.startsWith('language-') &&
                        !cls.includes('copy') &&
                        !cls.includes('lines')
                    );

                    if (newClasses.length > 0) {
                        debouncedCompile();
                    }
                }
            }, 300); // Longer delay to let code processing finish
        }
    });

    // Use a single MutationObserver for all DOM changes
    const observer = new MutationObserver((mutations) => {
        let shouldRecompile = false;

        for (const mutation of mutations) {
            // Skip attribute changes that don't affect utilities
            if (mutation.type === 'attributes') {
                const attributeName = mutation.attributeName;

                // Skip ignored attributes (like id changes from router)
                if (this.ignoredAttributes.includes(attributeName)) {
                    continue;
                }

                // Only care about class attribute changes
                if (attributeName !== 'class') {
                    continue;
                }

                // If it's a class change, check if we have new classes that need utilities
                const element = mutation.target;
                if (element.nodeType === Node.ELEMENT_NODE) {
                    const currentClasses = Array.from(element.classList || []);
                    const newClasses = currentClasses.filter(cls => {
                        // Skip ignored patterns
                        if (this.ignoredClassPatterns.some(pattern => pattern.test(cls))) {
                            return false;
                        }

                        // Check if this class is new (not in our cache)
                        return !this.staticClassCache.has(cls) && !this.dynamicClassCache.has(cls);
                    });

                    if (newClasses.length > 0) {
                        // Add new classes to dynamic cache
                        newClasses.forEach(cls => this.dynamicClassCache.add(cls));
                        shouldRecompile = true;
                        break;
                    }
                }
            }
            else if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // Skip ignored elements using configurable selectors
                        const isIgnoredElement = this.ignoredElementSelectors.some(selector =>
                            node.tagName?.toLowerCase() === selector.toLowerCase() ||
                            node.closest(selector)
                        );

                        if (isIgnoredElement) {
                            continue;
                        }

                        // Only recompile for significant changes using configurable selectors
                        const hasSignificantChange = this.significantChangeSelectors.some(selector => {
                            try {
                                return node.matches?.(selector) || node.querySelector?.(selector);
                            } catch (e) {
                                return false; // Invalid selector
                            }
                        });

                        if (hasSignificantChange) {
                            shouldRecompile = true;
                            break;
                        }
                    }
                }
            }
            if (shouldRecompile) break;
        }

        if (shouldRecompile) {
            debouncedCompile();
        }
    });

    // Start observing the document with the configured parameters
    observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'] // Only observe class changes
    });
};

// Start processing with initial compilation. DOM observation is owned by
// setupComponentLoadListener (called separately from main.js init) — that one
// uses an incremental staticClassCache lookup per mutation, which scales to
// thousands of elements. A previous version of this method also installed its
// own MutationObserver here that called getUsedClasses() on EVERY mutation
// (a full document-wide O(N) DOM scan), so on a busy page with N≥3000 the
// scan cost exceeded the inter-mutation interval and the main thread froze
// (~100% CPU on docs site, 3042 elements). That observer was redundant with
// the incremental one and has been removed.
TailwindCompiler.prototype.startProcessing = async function () {
    if (this.usesStaticPrerenderUtilities) return;
    try {
        await this.compile();
        this.hasInitialized = true;
    } catch (error) {
        console.error('Error starting Tailwind compiler:', error);
    }
};

