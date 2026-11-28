// DOM observation: watch for changes and trigger recompilation

// Setup component load listener and MutationObserver
TailwindCompiler.prototype.setupComponentLoadListener = function () {
    // compile() queues a retry when busy; dropping the call here lost classes seen mid-compile
    const debouncedCompile = this.debounce(() => this.compile(), this.options.debounceTime);

    // Recompile when components load/process (the observer has already collected their classes)
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

    // Single MutationObserver for all DOM changes: recompile only when a class not yet seen appears
    const observer = new MutationObserver((mutations) => {
        let fresh = false;

        for (const mutation of mutations) {
            if (mutation.type === 'attributes') {
                if (this.ignoredAttributes.includes(mutation.attributeName) || mutation.attributeName !== 'class') continue;
                if (mutation.target.nodeType === Node.ELEMENT_NODE && this.collectNewClasses(mutation.target, false, true)) fresh = true;
            } else if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) {
                    // Tailwind cache's engine carrier: not page content
                    if (node.nodeType !== Node.ELEMENT_NODE || node.hasAttribute('data-tailwind-seed')) continue;
                    if (this._engineGate) this.checkEngineNode(node);
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
// classOnly: a class attribute change (the element's binding expression was read when it was added)
TailwindCompiler.prototype.collectNewClasses = function (el, quiet, classOnly) {
    if (!el.getAttribute) return false;
    const value = el.getAttribute('class');
    let fresh = false;
    if (value) {
        // Rows repeat a handful of class strings: one fully recorded needs no re-split
        const seen = this._seenClassStrings || (this._seenClassStrings = new Set());
        if (!seen.has(value)) {
            fresh = this.recordClasses(value.split(/\s+/), quiet);
            if (!quiet) {
                if (seen.size > 5000) seen.clear();
                seen.add(value);
            }
        }
    }
    if (classOnly) return fresh;
    const bound = el.getAttribute(':class') || el.getAttribute('x-bind:class');
    if (bound && this.recordClasses(this.bindingClasses(bound), quiet)) fresh = true;
    return fresh;
};

// Binding literals per expression, cached: x-for clones repeat the same few
TailwindCompiler.prototype.bindingClasses = function (expr) {
    if (!this._bindingClasses) this._bindingClasses = new Map();
    let list = this._bindingClasses.get(expr);
    if (!list) {
        const set = new Set();
        this.collectBindingClasses(expr, set);
        list = Array.from(set);
        if (this._bindingClasses.size > 500) this._bindingClasses.clear();
        this._bindingClasses.set(expr, list);
    }
    return list;
};

TailwindCompiler.prototype.recordClasses = function (list, quiet) {
    let fresh = false;
    for (const cls of list) {
        if (!cls || this.staticClassCache.has(cls)) continue;
        if (this.dynamicClassCache.has(cls)) {
            if (!quiet && this.quietClasses.delete(cls)) fresh = true;
            continue;
        }
        if (this.ignoredClassPatterns.some(pattern => pattern.test(cls))) continue;
        this.dynamicClassCache.add(cls);
        if (this._engineGate) this.checkEngineToken(cls);
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

