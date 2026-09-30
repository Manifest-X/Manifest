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

    // Single MutationObserver for all DOM changes: recompile only when a class not yet seen appears
    const observer = new MutationObserver((mutations) => {
        let fresh = false;

        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                if (this.ignoredAttributes.includes(mutation.attributeName) || mutation.attributeName !== 'class') continue;
                if (mutation.target.nodeType === Node.ELEMENT_NODE && this.collectNewClasses(mutation.target)) fresh = true;
            } else if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;
                    const isIgnoredElement = this.ignoredElementSelectors.some(selector =>
                        node.tagName?.toLowerCase() === selector.toLowerCase() ||
                        node.closest(selector)
                    );
                    // Ignored subtrees (code blocks) are collected for the next compile but never trigger one
                    if (this.collectSubtreeClasses(node, isIgnoredElement)) fresh = true;
                    else if (!fresh && !isIgnoredElement && !this.hasInitialized && this.isSignificantNode(node)) fresh = true;
                }
            }
        }

        if (fresh) {
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

// Record classes not seen before; true when any were new. Quiet = collect without triggering
TailwindCompiler.prototype.collectNewClasses = function (el, quiet) {
    const value = el.getAttribute && el.getAttribute('class');
    if (!value) return false;
    let fresh = false;
    for (const cls of value.split(/\s+/)) {
        if (!cls || this.staticClassCache.has(cls)) continue;
        if (this.dynamicClassCache.has(cls)) {
            if (!quiet && this.quietClasses.delete(cls)) fresh = true;
            continue;
        }
        if (this.ignoredClassPatterns.some(pattern => pattern.test(cls))) continue;
        this.dynamicClassCache.add(cls);
        if (quiet) this.quietClasses.add(cls); else fresh = true;
    }
    return fresh;
};

TailwindCompiler.prototype.collectSubtreeClasses = function (node, quiet) {
    let fresh = this.collectNewClasses(node, quiet);
    const descendants = node.getElementsByTagName ? node.getElementsByTagName('*') : [];
    for (let i = 0; i < descendants.length; i++) {
        if (this.collectNewClasses(descendants[i], quiet)) fresh = true;
    }
    return fresh;
};

TailwindCompiler.prototype.isSignificantNode = function (node) {
    return this.significantChangeSelectors.some(selector => {
        try {
            return node.matches?.(selector) || node.querySelector?.(selector);
        } catch (e) {
            return false;
        }
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

