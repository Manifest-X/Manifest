/* Manifest Utilities */

/** True when prerender wrote utilities to prerender.utilities.css — skip runtime #manifest-styles generation. */
function manifestPageUsesStaticPrerenderUtilities() {
    if (typeof document === 'undefined') return false;
    try {
        if (!document.querySelector('meta[name="manifest:prerendered"][content="1"]')) return false;
        for (const link of document.querySelectorAll('link[rel="stylesheet"][href]')) {
            if ((link.getAttribute('href') || '').toLowerCase().includes('prerender.utilities.css')) {
                return true;
            }
        }
    } catch (e) {
        return false;
    }
    return false;
}

// Browser runtime compiler
class TailwindCompiler {
    constructor(options = {}) {
        this.usesStaticPrerenderUtilities = manifestPageUsesStaticPrerenderUtilities();

        // Prerender already emitted utility CSS; do not inject duplicate #manifest-styles / observers.
        if (this.usesStaticPrerenderUtilities) {
            this.debug = options.debug === true;
            this.startTime = performance.now();
            this.options = {
                rootSelector: options.rootSelector || ':root',
                themeSelector: options.themeSelector || '@theme',
                debounceTime: options.debounceTime || 50,
                maxCacheAge: options.maxCacheAge || 24 * 60 * 60 * 1000,
                debug: options.debug !== false,
                ...options
            };
            this.criticalStyleElement = null;
            this.styleElement = null;
            this.tailwindLink = null;
            this.observer = null;
            this.isCompiling = false;
            this.compileTimeout = null;
            this.cache = new Map();
            this.hasInitialized = true;
            // manifest.code.js (and others) may still register ignore rules; mirror full constructor defaults.
            this.ignoredClassPatterns = [
                /^hljs/, /^language-/, /^copy$/, /^copied$/, /^lines$/, /^selected$/
            ];
            this.ignoredElementSelectors = [
                'pre', 'code', 'x-code', 'x-code-group'
            ];
            this.significantChangeSelectors = [
                '[data-component]', '[x-data]'
            ];
            return;
        }

        this.debug = options.debug === true;
        this.startTime = performance.now();

        // Create critical style element FIRST - must be before any rendering
        const criticalStyleStart = performance.now();
        this.criticalStyleElement = document.createElement('style');
        this.criticalStyleElement.id = 'manifest-styles-critical';
        // Insert at the very beginning of head
        if (document.head) {
            if (document.head.firstChild) {
                document.head.insertBefore(this.criticalStyleElement, document.head.firstChild);
            } else {
                document.head.appendChild(this.criticalStyleElement);
            }
        } else {
            // If head doesn't exist yet, wait for it (shouldn't happen, but safety check)
            const checkHead = setInterval(() => {
                if (document.head) {
                    clearInterval(checkHead);
                    if (document.head.firstChild) {
                        document.head.insertBefore(this.criticalStyleElement, document.head.firstChild);
                    } else {
                        document.head.appendChild(this.criticalStyleElement);
                    }
                }
            }, 1);
        }

        // Initialize options first (needed for regex patterns)
        this.options = {
            rootSelector: options.rootSelector || ':root',
            themeSelector: options.themeSelector || '@theme',
            debounceTime: options.debounceTime || 50,
            maxCacheAge: options.maxCacheAge || 24 * 60 * 60 * 1000,
            debug: options.debug !== false,
            ...options
        };

        // Initialize regex patterns (needed for utility generation)
        this.regexPatterns = {
            root: new RegExp(`${this.options.rootSelector}\\s*{([^}]*)}`, 'g'),
            theme: new RegExp(`${this.options.themeSelector}\\s*{([^}]*)}`, 'g'),
            variable: /--([\w-]+):\s*([^;]+);/g,
            tailwindPrefix: /^(color|font|text|font-weight|tracking|leading|breakpoint|container|spacing|radius|shadow|inset-shadow|drop-shadow|blur|perspective|aspect|ease|animate|border-width|border-style|outline|outline-width|outline-style|ring|ring-offset|divide|accent|caret|decoration|placeholder|selection|scrollbar)-/
        };

        // Initialize utility generators from component
        const generators = createUtilityGenerators();
        // Start with minimal generators needed for synchronous generation
        this.utilityGenerators = {
            'color-': generators['color-'],
            'font-': generators['font-'],
            'text-': generators['text-'],
            'font-weight-': generators['font-weight-'],
            'tracking-': generators['tracking-'],
            'leading-': generators['leading-'],
            'spacing-': generators['spacing-'],
            'radius-': generators['radius-'],
            'shadow-': generators['shadow-'],
            'blur-': generators['blur-']
        };
        // Add remaining generators
        Object.assign(this.utilityGenerators, generators);

        // Initialize variants from component (needed for parseClassName during sync generation)
        this.variants = createVariants();
        this.variantGroups = createVariantGroups();

        // Cache for parsed class names (must be before addCriticalBlockingStylesSync)
        this.classCache = new Map();

        // Add critical styles IMMEDIATELY - don't wait for anything
        this.addCriticalBlockingStylesSync();

        // Create main style element for generated utilities
        this.styleElement = document.createElement('style');
        this.styleElement.id = 'manifest-styles';
        document.head.appendChild(this.styleElement);
        this.setupUtilityStylesOrderObserver();

        // Initialize properties
        this.tailwindLink = null;
        this.observer = null;
        this.isCompiling = false;
        this.compileTimeout = null;
        this.cache = new Map();
        this.lastThemeHash = null;
        this.processedElements = new WeakSet();
        this.activeBreakpoints = new Set();
        this.activeModifiers = new Set();
        this.cssFiles = new Set();
        this.pendingStyles = new Map();
        this.currentThemeVars = new Map();
        this.hasInitialized = false;
        this.lastCompileTime = 0;
        this.minCompileInterval = 100; // Minimum time between compilations in ms
        this.cssContentCache = new Map(); // Cache CSS file contents with timestamps
        this.lastClassesHash = ''; // Track changes in used classes
        this.staticClassCache = new Set(); // Cache classes found in static HTML/components
        this.dynamicClassCache = new Set(); // Cache classes that appear dynamically
        this.hasScannedStatic = false; // Track if we've done initial static scan
        this.staticScanPromise = null; // Promise for initial static scan
        this.ignoredClassPatterns = [ // Patterns for classes to ignore
            /^hljs/, /^language-/, /^copy$/, /^copied$/, /^lines$/, /^selected$/
        ];
        this.ignoredElementSelectors = [ // Elements to ignore for DOM mutations
            'pre', 'code', 'x-code', 'x-code-group'
        ];
        this.ignoredAttributes = [ // Attribute changes to ignore (non-visual/utility changes)
            'id', 'data-order', 'data-component-id', 'data-highlighted', 'data-processed',
            'x-intersect', 'x-intersect:leave', 'x-show', 'x-hide', 'x-transition',
            'aria-expanded', 'aria-selected', 'aria-current', 'aria-hidden', 'aria-label',
            'tabindex', 'role', 'title', 'alt', 'data-state', 'data-value'
        ];
        this.significantChangeSelectors = [ // Only these DOM additions trigger recompilation
            '[data-component]', '[x-data]' // Components and Alpine elements
        ];

        // Pre-define pseudo classes
        this.pseudoClasses = ['hover', 'focus', 'active', 'disabled', 'dark'];

        // Cache for discovered custom utility classes
        this.customUtilities = new Map();

        // Variants and classCache already initialized above (before addCriticalBlockingStylesSync)

        // Load cache and start processing
        this.loadAndApplyCache();

        // If cache loaded utilities, they'll be in the main style element
        // The critical style element will be cleared when full utilities are ready

        // Try to generate minimal utilities synchronously from inline styles
        this.generateSynchronousUtilities();

        // Listen for component loads
        this.setupComponentLoadListener();

        this.waitForTailwind().then(() => {
            this.startProcessing();
        });
    }

    // Public API for other plugins to configure behavior
    addIgnoredClassPattern(pattern) {
        if (!Array.isArray(this.ignoredClassPatterns)) {
            this.ignoredClassPatterns = [];
        }
        if (pattern instanceof RegExp) {
            this.ignoredClassPatterns.push(pattern);
        } else if (typeof pattern === 'string') {
            this.ignoredClassPatterns.push(new RegExp(pattern));
        }
    }

    addIgnoredElementSelector(selector) {
        if (!Array.isArray(this.ignoredElementSelectors)) {
            this.ignoredElementSelectors = [];
        }
        if (typeof selector === 'string') {
            this.ignoredElementSelectors.push(selector);
        }
    }

    addSignificantChangeSelector(selector) {
        if (!Array.isArray(this.significantChangeSelectors)) {
            this.significantChangeSelectors = [];
        }
        if (typeof selector === 'string') {
            this.significantChangeSelectors.push(selector);
        }
    }

    // Allow plugins to trigger recompilation when needed
    triggerRecompilation(reason = 'manual') {
        this.compile();
    }

    // Debounce utility
    debounce(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    // Wait for Tailwind to be available
    async waitForTailwind() {
        return new Promise((resolve) => {
            if (this.isTailwindAvailable()) {
                resolve();
                return;
            }

            const checkInterval = setInterval(() => {
                if (this.isTailwindAvailable()) {
                    clearInterval(checkInterval);
                    resolve();
                }
            }, 100);

            // Also check on DOMContentLoaded
            document.addEventListener('DOMContentLoaded', () => {
                if (this.isTailwindAvailable()) {
                    clearInterval(checkInterval);
                    resolve();
                }
            });

            // Set a timeout to prevent infinite waiting
            setTimeout(() => {
                clearInterval(checkInterval);
                resolve();
            }, 5000);
        });
    }

    // Check if Tailwind is available
    isTailwindAvailable() {
        // Check for Tailwind in various ways
        return (
            // Check for Tailwind CSS file
            Array.from(document.styleSheets).some(sheet =>
                sheet.href && (
                    sheet.href.includes('tailwind') ||
                    sheet.href.includes('tailwindcss') ||
                    sheet.href.includes('manifest')
                )
            ) ||
            // Check for Tailwind classes in document
            document.querySelector('[class*="tailwind"]') ||
            // Check for Tailwind in window object
            window.tailwind ||
            // Check for Tailwind in document head
            document.head.innerHTML.includes('tailwind') ||
            // Check for Manifest CSS files
            document.head.innerHTML.includes('manifest')
        );
    }
}

