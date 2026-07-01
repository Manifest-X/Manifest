// DOM observation: watch for changes and trigger recompilation

// Setup component load listener and MutationObserver
TailwindCompiler.prototype.setupComponentLoadListener = function () {
    const debouncedCompile = this.debounce(() => {
        if (!this.isCompiling) {
            this.compile();
        }
    }, this.options.debounceTime);

    // Recompile when components load/process; re-scan so component HTML is covered.
    const handleComponentEvent = () => {
        if (!this.hasScannedStatic) {
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

    // On route change, recompile only if genuinely new dynamic classes appeared.
    document.addEventListener('manifest:route-change', (event) => {
        if (this.hasScannedStatic) {
            setTimeout(() => {
                const currentDynamicCount = this.dynamicClassCache.size;
                const currentClassesHash = this.lastClassesHash;

                // Scan for new classes
                const usedData = this.getUsedClasses();
                const newDynamicCount = this.dynamicClassCache.size;
                const dynamicClasses = Array.from(this.dynamicClassCache);
                const newClassesHash = dynamicClasses.sort().join(',');

                if (newDynamicCount > currentDynamicCount && newClassesHash !== currentClassesHash) {
                    const newClasses = dynamicClasses.filter(cls =>
                        // Ignore highlight/code-processing artifacts
                        !cls.includes('hljs') &&
                        !cls.startsWith('language-') &&
                        !cls.includes('copy') &&
                        !cls.includes('lines')
                    );

                    if (newClasses.length > 0) {
                        debouncedCompile();
                    }
                }
            }, 300); // let code processing finish
        }
    });

    // Single MutationObserver for all DOM changes
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

// Initial compilation only. DOM observation is owned by
// setupComponentLoadListener (incremental, scales to thousands of elements);
// don't add a per-mutation getUsedClasses() scan here — it froze the main
// thread on busy pages.
TailwindCompiler.prototype.startProcessing = async function () {
    if (this.usesStaticPrerenderUtilities) return;
    try {
        await this.compile();
        this.hasInitialized = true;
    } catch (error) {
        console.error('Error starting Tailwind compiler:', error);
    }
};

