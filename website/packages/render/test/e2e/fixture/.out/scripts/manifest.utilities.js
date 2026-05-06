// Utility generators
// Functions that generate CSS utilities from CSS variable suffixes

function createUtilityGenerators() {
    return {
        'color-': (suffix, value) => {
            const utilities = [];
            const addUtility = (prefix, property, baseValue) => {
                utilities.push([`${prefix}-${suffix}`, `${property}: ${baseValue}`]);
            };
            addUtility('text', 'color', value);
            addUtility('bg', 'background-color', value);
            addUtility('border', 'border-color', value);
            addUtility('outline', 'outline-color', value);
            addUtility('ring', 'box-shadow', `0 0 0 1px ${value}`);
            addUtility('fill', 'fill', value);
            addUtility('stroke', 'stroke', value);
            addUtility('decoration', 'text-decoration-color', value);
            addUtility('accent', 'accent-color', value);
            addUtility('caret', 'caret-color', value);
            utilities.push([`from-${suffix}`, `--tw-gradient-from: ${value}; --tw-gradient-stops: var(--tw-gradient-via-stops)`]);
            utilities.push([`via-${suffix}`, `--tw-gradient-via: ${value}; --tw-gradient-stops: var(--tw-gradient-via-stops)`]);
            utilities.push([`to-${suffix}`, `--tw-gradient-to: ${value}; --tw-gradient-stops: var(--tw-gradient-via-stops)`]);
            return utilities;
        },
        'font-': (suffix, value) => [
            [`font-${suffix}`, `font-family: ${value}`]
        ],
        'text-': (suffix, value) => [
            [`text-${suffix}`, `font-size: ${value}`]
        ],
        'font-weight-': (suffix, value) => [
            [`font-${suffix}`, `font-weight: ${value}`]
        ],
        'tracking-': (suffix, value) => [
            [`tracking-${suffix}`, `letter-spacing: ${value}`]
        ],
        'leading-': (suffix, value) => [
            [`leading-${suffix}`, `line-height: ${value}`]
        ],
        'breakpoint-': (suffix, value) => [
            [`@${suffix}`, `@media (min-width: ${value})`]
        ],
        'container-': (suffix, value) => [
            [`container-${suffix}`, `max-width: ${value}`],
            [`@container-${suffix}`, `@container (min-width: ${value})`]
        ],
        'spacing-': (suffix, value) => [
            [`gap-${suffix}`, `gap: ${value}`],
            [`p-${suffix}`, `padding: ${value}`],
            [`px-${suffix}`, `padding-left: ${value}; padding-right: ${value}`],
            [`py-${suffix}`, `padding-top: ${value}; padding-bottom: ${value}`],
            [`m-${suffix}`, `margin: ${value}`],
            [`mx-${suffix}`, `margin-left: ${value}; margin-right: ${value}`],
            [`my-${suffix}`, `margin-top: ${value}; margin-bottom: ${value}`],
            [`space-x-${suffix}`, `> * + * { margin-left: ${value}; }`],
            [`space-y-${suffix}`, `> * + * { margin-top: ${value}; }`],
            [`max-w-${suffix}`, `max-width: ${value}`],
            [`max-h-${suffix}`, `max-height: ${value}`],
            [`min-w-${suffix}`, `min-width: ${value}`],
            [`min-h-${suffix}`, `min-height: ${value}`],
            [`w-${suffix}`, `width: ${value}`],
            [`h-${suffix}`, `height: ${value}`]
        ],
        'radius-': (suffix, value) => [
            [`rounded-${suffix}`, `border-radius: ${value}`]
        ],
        'shadow-': (suffix, value) => [
            [`shadow-${suffix}`, `box-shadow: ${value}`]
        ],
        'inset-shadow-': (suffix, value) => [
            [`inset-shadow-${suffix}`, `box-shadow: inset ${value}`]
        ],
        'drop-shadow-': (suffix, value) => [
            [`drop-shadow-${suffix}`, `filter: drop-shadow(${value})`]
        ],
        'blur-': (suffix, value) => [
            [`blur-${suffix}`, `filter: blur(${value})`]
        ],
        'perspective-': (suffix, value) => [
            [`perspective-${suffix}`, `perspective: ${value}`]
        ],
        'aspect-': (suffix, value) => [
            [`aspect-${suffix}`, `aspect-ratio: ${value}`]
        ],
        'ease-': (suffix, value) => [
            [`ease-${suffix}`, `transition-timing-function: ${value}`]
        ],
        'animate-': (suffix, value) => [
            [`animate-${suffix}`, `animation: ${value}`]
        ],
        'border-width-': (suffix, value) => [
            [`border-${suffix}`, `border-width: ${value}`]
        ],
        'border-style-': (suffix, value) => [
            [`border-${suffix}`, `border-style: ${value}`]
        ],
        'outline-': (suffix, value) => [
            [`outline-${suffix}`, `outline-color: ${value}`]
        ],
        'outline-width-': (suffix, value) => [
            [`outline-${suffix}`, `outline-width: ${value}`]
        ],
        'outline-style-': (suffix, value) => [
            [`outline-${suffix}`, `outline-style: ${value}`]
        ],
        'ring-': (suffix, value) => [
            [`ring-${suffix}`, `box-shadow: 0 0 0 ${value} var(--color-ring)`]
        ],
        'ring-offset-': (suffix, value) => [
            [`ring-offset-${suffix}`, `--tw-ring-offset-width: ${value}`]
        ],
        'divide-': (suffix, value) => [
            [`divide-${suffix}`, `border-color: ${value}`]
        ],
        'accent-': (suffix, value) => [
            [`accent-${suffix}`, `accent-color: ${value}`]
        ],
        'caret-': (suffix, value) => [
            [`caret-${suffix}`, `caret-color: ${value}`]
        ],
        'decoration-': (suffix, value) => [
            [`decoration-${suffix}`, `text-decoration-color: ${value}`]
        ],
        'placeholder-': (suffix, value) => [
            [`placeholder-${suffix}`, `&::placeholder { color: ${value} }`]
        ],
        'selection-': (suffix, value) => [
            [`selection-${suffix}`, `&::selection { background-color: ${value} }`]
        ],
        'scrollbar-': (suffix, value) => [
            [`scrollbar-${suffix}`, `scrollbar-color: ${value}`]
        ]
    };
}



// Variants and variant groups
// CSS selector mappings for Tailwind variants

function createVariants() {
    return {
        // State variants
        'hover': ':hover',
        'focus': ':focus',
        'focus-visible': ':focus-visible',
        'focus-within': ':focus-within',
        'active': ':active',
        'visited': ':visited',
        'target': ':target',
        'first': ':first-child',
        'last': ':last-child',
        'only': ':only-child',
        'odd': ':nth-child(odd)',
        'even': ':nth-child(even)',
        'first-of-type': ':first-of-type',
        'last-of-type': ':last-of-type',
        'only-of-type': ':only-of-type',
        'empty': ':empty',
        'disabled': ':disabled',
        'enabled': ':enabled',
        'checked': ':checked',
        'indeterminate': ':indeterminate',
        'default': ':default',
        'required': ':required',
        'valid': ':valid',
        'invalid': ':invalid',
        'in-range': ':in-range',
        'out-of-range': ':out-of-range',
        'placeholder-shown': ':placeholder-shown',
        'autofill': ':autofill',
        'read-only': ':read-only',
        'read-write': ':read-write',
        'optional': ':optional',
        'user-valid': ':user-valid',
        'user-invalid': ':user-invalid',
        'inert': ':inert',
        'open': ':is([open], :popover-open, :open) &',
        'closed': ':not(:is([open], :popover-open, :open)) &',
        'paused': '[data-state="paused"] &',
        'playing': '[data-state="playing"] &',
        'muted': '[data-state="muted"] &',
        'unmuted': '[data-state="unmuted"] &',
        'collapsed': '[data-state="collapsed"] &',
        'expanded': '[data-state="expanded"] &',
        'unchecked': ':not(:checked)',
        'selected': '[data-state="selected"] &',
        'unselected': '[data-state="unselected"] &',
        'details-content': '::details-content',
        'nth': ':nth-child',
        'nth-last': ':nth-last-child',
        'nth-of-type': ':nth-of-type',
        'nth-last-of-type': ':nth-last-of-type',
        'has': ':has',
        'not': ':not',

        // Pseudo-elements
        'before': '::before',
        'after': '::after',
        'first-letter': '::first-letter',
        'first-line': '::first-line',
        'marker': '::marker',
        'selection': '::selection',
        'file': '::file-selector-button',
        'backdrop': '::backdrop',
        'placeholder': '::placeholder',
        'target-text': '::target-text',
        'spelling-error': '::spelling-error',
        'grammar-error': '::grammar-error',

        // Media queries
        'dark': '.dark &',
        'light': '.light &',

        // Group variants
        'group': '.group &',
        'group-hover': '.group:hover &',
        'group-focus': '.group:focus &',
        'group-focus-within': '.group:focus-within &',
        'group-active': '.group:active &',
        'group-disabled': '.group:disabled &',
        'group-visited': '.group:visited &',
        'group-checked': '.group:checked &',
        'group-required': '.group:required &',
        'group-valid': '.group:valid &',
        'group-invalid': '.group:invalid &',
        'group-in-range': '.group:in-range &',
        'group-out-of-range': '.group:out-of-range &',
        'group-placeholder-shown': '.group:placeholder-shown &',
        'group-autofill': '.group:autofill &',
        'group-read-only': '.group:read-only &',
        'group-read-write': '.group:read-write &',
        'group-optional': '.group:optional &',
        'group-user-valid': '.group:user-valid &',
        'group-user-invalid': '.group:user-invalid &',

        // Peer variants
        'peer': '.peer ~ &',
        'peer-hover': '.peer:hover ~ &',
        'peer-focus': '.peer:focus ~ &',
        'peer-focus-within': '.peer:focus-within ~ &',
        'peer-active': '.peer:active ~ &',
        'peer-disabled': '.peer:disabled ~ &',
        'peer-visited': '.peer:visited ~ &',
        'peer-checked': '.peer:checked ~ &',
        'peer-required': '.peer:required ~ &',
        'peer-valid': '.peer:valid ~ &',
        'peer-invalid': '.peer:invalid ~ &',
        'peer-in-range': '.peer:in-range ~ &',
        'peer-out-of-range': '.peer:out-of-range ~ &',
        'peer-placeholder-shown': '.peer:placeholder-shown ~ &',
        'peer-autofill': '.peer:autofill ~ &',
        'peer-read-only': '.peer:read-only ~ &',
        'peer-read-write': '.peer:read-write ~ &',
        'peer-optional': '.peer:optional ~ &',
        'peer-user-valid': '.peer:user-valid ~ &',
        'peer-user-invalid': '.peer:user-invalid &',

        'motion-safe': '@media (prefers-reduced-motion: no-preference)',
        'motion-reduce': '@media (prefers-reduced-motion: reduce)',
        'print': '@media print',
        'portrait': '@media (orientation: portrait)',
        'landscape': '@media (orientation: landscape)',
        'contrast-more': '@media (prefers-contrast: more)',
        'contrast-less': '@media (prefers-contrast: less)',
        'forced-colors': '@media (forced-colors: active)',
        'rtl': '&:where(:dir(rtl), [dir="rtl"], [dir="rtl"] *)',
        'ltr': '&:where(:dir(ltr), [dir="ltr"], [dir="ltr"] *)',
        '[dir=rtl]': '[dir="rtl"] &',
        '[dir=ltr]': '[dir="ltr"] &',
        'pointer-fine': '@media (pointer: fine)',
        'pointer-coarse': '@media (pointer: coarse)',
        'pointer-none': '@media (pointer: none)',
        'any-pointer-fine': '@media (any-pointer: fine)',
        'any-pointer-coarse': '@media (any-pointer: coarse)',
        'any-pointer-none': '@media (any-pointer: none)',
        'scripting-enabled': '@media (scripting: enabled)',
        'can-hover': '@media (hover: hover)',
        'can-not-hover': '@media (hover: none)',
        'any-hover': '@media (any-hover: hover)',
        'any-hover-none': '@media (any-hover: none)',
        'any-pointer': '@media (any-pointer: fine)',
        'any-pointer-coarse': '@media (any-pointer: coarse)',
        'any-pointer-none': '@media (any-pointer: none)',
        'color': '@media (color)',
        'color-gamut': '@media (color-gamut: srgb)',
        'color-gamut-p3': '@media (color-gamut: p3)',
        'color-gamut-rec2020': '@media (color-gamut: rec2020)',
        'monochrome': '@media (monochrome)',
        'monochrome-color': '@media (monochrome: 0)',
        'monochrome-grayscale': '@media (monochrome: 1)',
        'inverted-colors': '@media (inverted-colors: inverted)',
        'inverted-colors-none': '@media (inverted-colors: none)',
        'update': '@media (update: fast)',
        'update-slow': '@media (update: slow)',
        'update-none': '@media (update: none)',
        'overflow-block': '@media (overflow-block: scroll)',
        'overflow-block-paged': '@media (overflow-block: paged)',
        'overflow-inline': '@media (overflow-inline: scroll)',
        'overflow-inline-auto': '@media (overflow-inline: auto)',
        'prefers-color-scheme': '@media (prefers-color-scheme: dark)',
        'prefers-color-scheme-light': '@media (prefers-color-scheme: light)',
        'prefers-contrast': '@media (prefers-contrast: more)',
        'prefers-contrast-less': '@media (prefers-contrast: less)',
        'prefers-contrast-no-preference': '@media (prefers-contrast: no-preference)',
        'prefers-reduced-motion': '@media (prefers-reduced-motion: reduce)',
        'prefers-reduced-motion-no-preference': '@media (prefers-reduced-motion: no-preference)',
        'prefers-reduced-transparency': '@media (prefers-reduced-transparency: reduce)',
        'prefers-reduced-transparency-no-preference': '@media (prefers-reduced-transparency: no-preference)',
        'resolution': '@media (resolution: 1dppx)',
        'resolution-low': '@media (resolution: 1dppx)',
        'resolution-high': '@media (resolution: 2dppx)',
        'scan': '@media (scan: progressive)',
        'scan-interlace': '@media (scan: interlace)',
        'scripting': '@media (scripting: enabled)',
        'scripting-none': '@media (scripting: none)',
        'scripting-initial-only': '@media (scripting: initial-only)',

        // Container queries
        'container': '@container',
        'container-name': '@container',

        // Important modifier
        '!': '!important',

        // Responsive breakpoints
        'sm': '@media (min-width: 640px)',
        'md': '@media (min-width: 768px)',
        'lg': '@media (min-width: 1024px)',
        'xl': '@media (min-width: 1280px)',
        '2xl': '@media (min-width: 1536px)',

        // Supports queries
        'supports': '@supports',

        // Starting style
        'starting': '@starting-style',

        // Data attribute variants (common patterns)
        'data-open': '[data-state="open"] &',
        'data-closed': '[data-state="closed"] &',
        'data-checked': '[data-state="checked"] &',
        'data-unchecked': '[data-state="unchecked"] &',
        'data-on': '[data-state="on"] &',
        'data-off': '[data-state="off"] &',
        'data-visible': '[data-state="visible"] &',
        'data-hidden': '[data-state="hidden"] &',
        'data-disabled': '[data-disabled] &',
        'data-loading': '[data-loading] &',
        'data-error': '[data-error] &',
        'data-success': '[data-success] &',
        'data-warning': '[data-warning] &',
        'data-selected': '[data-selected] &',
        'data-highlighted': '[data-highlighted] &',
        'data-pressed': '[data-pressed] &',
        'data-expanded': '[data-expanded] &',
        'data-collapsed': '[data-collapsed] &',
        'data-active': '[data-active] &',
        'data-inactive': '[data-inactive] &',
        'data-valid': '[data-valid] &',
        'data-invalid': '[data-invalid] &',
        'data-required': '[data-required] &',
        'data-optional': '[data-optional] &',
        'data-readonly': '[data-readonly] &',
        'data-write': '[data-write] &',

        // Aria attribute variants (common patterns)
        'aria-expanded': '[aria-expanded="true"] &',
        'aria-collapsed': '[aria-expanded="false"] &',
        'aria-pressed': '[aria-pressed="true"] &',
        'aria-unpressed': '[aria-pressed="false"] &',
        'aria-checked': '[aria-checked="true"] &',
        'aria-unchecked': '[aria-checked="false"] &',
        'aria-selected': '[aria-selected="true"] &',
        'aria-unselected': '[aria-selected="false"] &',
        'aria-invalid': '[aria-invalid="true"] &',
        'aria-valid': '[aria-invalid="false"] &',
        'aria-required': '[aria-required="true"] &',
        'aria-optional': '[aria-required="false"] &',
        'aria-disabled': '[aria-disabled="true"] &',
        'aria-enabled': '[aria-disabled="false"] &',
        'aria-hidden': '[aria-hidden="true"] &',
        'aria-visible': '[aria-hidden="false"] &',
        'aria-busy': '[aria-busy="true"] &',
        'aria-available': '[aria-busy="false"] &',
        'aria-current': '[aria-current="true"] &',
        'aria-not-current': '[aria-current="false"] &',
        'aria-live': '[aria-live="polite"] &, [aria-live="assertive"] &',
        'aria-atomic': '[aria-atomic="true"] &',
        'aria-relevant': '[aria-relevant="additions"] &, [aria-relevant="removals"] &, [aria-relevant="text"] &, [aria-relevant="all"] &'
    };
}

function createVariantGroups() {
    return {
        'state': ['hover', 'focus', 'active', 'visited', 'target', 'open', 'closed', 'paused', 'playing', 'muted', 'unmuted', 'collapsed', 'expanded', 'unchecked', 'selected', 'unselected'],
        'child': ['first', 'last', 'only', 'odd', 'even'],
        'form': ['disabled', 'enabled', 'checked', 'indeterminate', 'required', 'valid', 'invalid'],
        'pseudo': ['before', 'after', 'first-letter', 'first-line', 'marker', 'selection', 'file', 'backdrop'],
        'media': ['dark', 'light', 'motion-safe', 'motion-reduce', 'print', 'portrait', 'landscape', 'rtl', 'ltr', 'can-hover', 'can-not-hover', 'any-hover', 'any-hover-none', 'color', 'monochrome', 'inverted-colors', 'inverted-colors-none', 'update', 'update-slow', 'update-none', 'overflow-block', 'overflow-block-paged', 'overflow-inline', 'overflow-inline-auto', 'prefers-color-scheme', 'prefers-color-scheme-light', 'prefers-contrast', 'prefers-contrast-less', 'prefers-contrast-no-preference', 'prefers-reduced-motion', 'prefers-reduced-motion-no-preference', 'prefers-reduced-transparency', 'prefers-reduced-transparency-no-preference', 'resolution', 'resolution-low', 'resolution-high', 'scan', 'scan-interlace', 'scripting', 'scripting-none', 'scripting-initial-only', 'forced-colors', 'contrast-more', 'contrast-less', 'pointer-fine', 'pointer-coarse', 'pointer-none', 'any-pointer-fine', 'any-pointer-coarse', 'any-pointer-none', 'scripting-enabled'],
        'responsive': ['sm', 'md', 'lg', 'xl', '2xl'],
        'group': ['group', 'group-hover', 'group-focus', 'group-active', 'group-disabled', 'group-checked', 'group-required', 'group-valid', 'group-invalid'],
        'peer': ['peer', 'peer-hover', 'peer-focus', 'peer-active', 'peer-disabled', 'peer-checked', 'peer-required', 'peer-valid', 'peer-invalid'],
        'data': ['data-open', 'data-closed', 'data-checked', 'data-unchecked', 'data-visible', 'data-hidden', 'data-disabled', 'data-loading', 'data-error', 'data-success', 'data-warning', 'data-selected', 'data-highlighted', 'data-pressed', 'data-expanded', 'data-collapsed', 'data-active', 'data-inactive', 'data-valid', 'data-invalid', 'data-required', 'data-optional', 'data-readonly', 'data-write'],
        'aria': ['aria-expanded', 'aria-collapsed', 'aria-pressed', 'aria-unpressed', 'aria-checked', 'aria-unchecked', 'aria-selected', 'aria-unselected', 'aria-invalid', 'aria-valid', 'aria-required', 'aria-optional', 'aria-disabled', 'aria-enabled', 'aria-hidden', 'aria-visible', 'aria-busy', 'aria-available', 'aria-current', 'aria-not-current', 'aria-live', 'aria-atomic', 'aria-relevant']
    };
}



/* Manifest Utilities */

/** True when prerender wrote utilities to prerender.utilities.css — skip runtime #utility-styles generation. */
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

        // Prerender already emitted utility CSS; do not inject duplicate #utility-styles / observers.
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
        this.criticalStyleElement.id = 'utility-styles-critical';
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
        this.styleElement.id = 'utility-styles';
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



// Synchronous utility generation
// Methods for generating utilities synchronously before first paint

TailwindCompiler.prototype.addCriticalBlockingStylesSync = function () {
    if (!this.criticalStyleElement) return;

    const syncStart = performance.now();

    try {
        // Extract CSS variables synchronously from already-loaded sources
        const cssVariables = new Map();

        // 1. From inline style elements (already in DOM)
        const inlineStyles = document.querySelectorAll('style:not(#utility-styles):not(#utility-styles-critical)');
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
        const inlineStyles = document.querySelectorAll('style:not(#utility-styles)');
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



// Cache management
// Methods for loading, saving, and managing cached utilities

// Load and apply cached utilities
TailwindCompiler.prototype.loadAndApplyCache = function () {
    const cacheStart = performance.now();
    try {
        const cached = localStorage.getItem('tailwind-cache');
        if (cached) {
            const parsed = JSON.parse(cached);
            this.cache = new Map(Object.entries(parsed));

            // Try to find the best matching cache entry
            // First, try to get a quick scan of current classes
            let currentClasses = new Set();
            try {
                // Quick scan of HTML source for classes
                if (document.documentElement) {
                    const htmlSource = document.documentElement.outerHTML;
                    const classRegex = /class=["']([^"']+)["']/gi;
                    let classMatch;
                    while ((classMatch = classRegex.exec(htmlSource)) !== null) {
                        const classes = classMatch[1].split(/\s+/).filter(Boolean);
                        classes.forEach(cls => {
                            if (!cls.startsWith('x-') && !cls.startsWith('$')) {
                                currentClasses.add(cls);
                            }
                        });
                    }
                }
            } catch (e) {
                // If HTML parsing fails, just use most recent
            }

            let bestMatch = null;
            let bestScore = 0;

            // Score cache entries by how many classes they match
            if (currentClasses.size > 0) {
                for (const [key, value] of this.cache.entries()) {
                    // Extract classes from cache key (format: "class1,class2-themeHash")
                    // Find the last occurrence of '-' followed by 8 chars (theme hash length)
                    const lastDashIndex = key.lastIndexOf('-');
                    const classesPart = lastDashIndex > 0 ? key.substring(0, lastDashIndex) : key;
                    const cachedClasses = classesPart ? classesPart.split(',') : [];
                    const cachedSet = new Set(cachedClasses);

                    // Count how many current classes are in cache
                    let matches = 0;
                    for (const cls of currentClasses) {
                        if (cachedSet.has(cls)) {
                            matches++;
                        }
                    }

                    // Score based on match ratio and recency
                    const matchRatio = matches / currentClasses.size;
                    const recencyScore = (Date.now() - value.timestamp) / (24 * 60 * 60 * 1000); // Days since cache
                    const score = matchRatio * 0.7 + (1 - Math.min(recencyScore, 1)) * 0.3; // 70% match, 30% recency

                    if (score > bestScore) {
                        bestScore = score;
                        bestMatch = value;
                    }
                }
            }

            // Use best match, or fall back to most recent
            const cacheToUse = bestMatch || Array.from(this.cache.entries())
                .sort((a, b) => b[1].timestamp - a[1].timestamp)[0]?.[1];

            if (cacheToUse && cacheToUse.css) {
                const applyCacheStart = performance.now();
                this.styleElement.textContent = cacheToUse.css;
                this.ensureUtilityStylesLast();
                this.scheduleEnsureUtilityStylesLast();
                this.lastThemeHash = cacheToUse.themeHash;

                // Also apply cache to critical style element
                // Extract utilities from @layer utilities block and apply directly (no @layer)
                if (this.criticalStyleElement && !this.criticalStyleElement.textContent) {
                    let criticalCss = cacheToUse.css;
                    // Remove @layer utilities wrapper if present
                    criticalCss = criticalCss.replace(/@layer\s+utilities\s*\{/g, '').replace(/\}\s*$/, '').trim();
                    if (criticalCss) {
                        this.criticalStyleElement.textContent = criticalCss;
                    }
                }

                // Don't clear critical styles yet - keep them until full compilation completes
            }
        }
    } catch (error) {
        // Silently fail - cache is optional
    }
};

// Save cache to localStorage
TailwindCompiler.prototype.savePersistentCache = function () {
    try {
        const serialized = JSON.stringify(Object.fromEntries(this.cache));
        localStorage.setItem('tailwind-cache', serialized);
    } catch (error) {
        console.warn('Failed to save cached styles:', error);
    }
};

// Load cache from localStorage
TailwindCompiler.prototype.loadPersistentCache = function () {
    try {
        const cached = localStorage.getItem('tailwind-cache');
        if (cached) {
            const parsed = JSON.parse(cached);
            this.cache = new Map(Object.entries(parsed));
        }
    } catch (error) {
        console.warn('Failed to load cached styles:', error);
    }
};

// Generate a hash of the theme variables to detect changes
TailwindCompiler.prototype.generateThemeHash = function (themeCss) {
    // Use encodeURIComponent to handle non-Latin1 characters safely
    return encodeURIComponent(themeCss).slice(0, 8); // Simple hash of theme content
};

// Clean up old cache entries
TailwindCompiler.prototype.cleanupCache = function () {
    const now = Date.now();
    const maxAge = this.options.maxCacheAge;
    const entriesToDelete = [];

    for (const [key, value] of this.cache.entries()) {
        if (value.timestamp && (now - value.timestamp > maxAge)) {
            entriesToDelete.push(key);
        }
    }

    for (const key of entriesToDelete) {
        this.cache.delete(key);
    }

    if (entriesToDelete.length > 0) {
        this.savePersistentCache();
    }
};



// Helper methods
// Utility functions for extracting, parsing, and processing CSS and classes

// Ensure #utility-styles is last in head so our responsive/variant rules win over Tailwind and any later-injected styles
TailwindCompiler.prototype.ensureUtilityStylesLast = function () {
    if (this.styleElement && this.styleElement.parentNode && document.head.lastElementChild !== this.styleElement) {
        document.head.appendChild(this.styleElement);
    }
};

// When any element is added to head after ours, move #utility-styles to end. Handles CDN load order (e.g. Tailwind injecting after we run).
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
        const styleElements = document.querySelectorAll('style:not(#utility-styles)');
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

// Fetch theme content from CSS files
TailwindCompiler.prototype.fetchThemeContent = async function () {
    const themeContents = new Set();
    const fetchPromises = [];

    // If we haven't discovered CSS files yet, do it now
    if (this.cssFiles.size === 0) {
        this.discoverCssFiles();
    }

    // Process all files concurrently
    for (const source of this.cssFiles) {
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
                    themeContents.add(content);
                }
            } catch (error) {
                console.warn(`Error fetching CSS from ${source}:`, error);
            }
        })();
        fetchPromises.push(fetchPromise);
    }

    // Wait for all fetches to complete
    await Promise.all(fetchPromises);

    return Array.from(themeContents).join('\n');
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
                let nestedSelector = null; // For variants that end with & (CSS nesting)

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
                        // Check if selector ends with & (indicates CSS nesting)
                        if (variant.selector.trim().endsWith('&')) {
                            // This is a nested selector - move & to the beginning for CSS nesting
                            const selectorWithoutAmpersand = variant.selector.trim().slice(0, -1).trim();
                            const nestedSelectorText = `&${selectorWithoutAmpersand}`;
                            nestedSelector = nestedSelector ? `${nestedSelector} ${nestedSelectorText}` : nestedSelectorText;
                        } else {
                            // Handle variants like .dark &, .light &, .group &, etc.
                            // Replace & with the actual selector
                            const replacedSelector = variant.selector.replace(/&/g, selector);
                            selector = replacedSelector;
                        }
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
                } else if (nestedSelector) {
                    // Handle nested selectors (variants ending with &)
                    rule = `${selector} {\n    ${nestedSelector} {\n        ${cssContent}\n    }\n}`;
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
                let nestedSelector = null; // For variants that end with & (CSS nesting)

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
                        // Check if selector ends with & (indicates CSS nesting)
                        if (variant.selector.trim().endsWith('&')) {
                            // This is a nested selector - move & to the beginning for CSS nesting
                            const selectorWithoutAmpersand = variant.selector.trim().slice(0, -1).trim();
                            const nestedSelectorText = `&${selectorWithoutAmpersand}`;
                            nestedSelector = nestedSelector ? `${nestedSelector} ${nestedSelectorText}` : nestedSelectorText;
                        } else {
                            // Handle variants like .dark &, .light &, .group &, etc.
                            // Replace & with the actual selector
                            const replacedSelector = variant.selector.replace(/&/g, selector);
                            selector = replacedSelector;
                        }
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
            if (themeCss) {
                // Extract and cache custom utilities
                const discoveredCustomUtilities = this.extractCustomUtilities(themeCss);
                for (const [name, value] of discoveredCustomUtilities.entries()) {
                    this.customUtilities.set(name, value);
                }

                const variables = this.extractThemeVariables(themeCss);
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

        // For subsequent compilations, check for new dynamic classes
        const usedData = this.getUsedClasses();
        const dynamicClasses = Array.from(this.dynamicClassCache);

        // Create a hash of current dynamic classes to detect changes
        const dynamicClassesHash = dynamicClasses.sort().join(',');

        // Check if dynamic classes have actually changed
        if (dynamicClassesHash !== this.lastClassesHash || !this.hasInitialized) {
            // Fetch CSS content for dynamic compilation
            const themeCss = await this.fetchThemeContent();
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
                const varUtilities = this.generateUtilitiesFromVars(themeCss, usedData);
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
        }

    } catch (error) {
        console.error('[Manifest Utilities] Error compiling Tailwind CSS:', error);
    } finally {
        this.isCompiling = false;
    }
};



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

// Start processing with initial compilation and observer setup
TailwindCompiler.prototype.startProcessing = async function () {
    if (this.usesStaticPrerenderUtilities) return;
    try {
        // Start initial compilation immediately
        const initialCompilation = this.compile();

        // Set up observer while compilation is running
        this.observer = new MutationObserver((mutations) => {
            const relevantMutations = mutations.filter(mutation => {
                if (mutation.type === 'attributes' &&
                    mutation.attributeName === 'class') {
                    return true;
                }
                if (mutation.type === 'childList') {
                    return Array.from(mutation.addedNodes).some(node =>
                        node.nodeType === Node.ELEMENT_NODE);
                }
                return false;
            });

            if (relevantMutations.length === 0) return;

            // Check if there are any new classes that need processing
            const newClasses = this.getUsedClasses();
            if (newClasses.classes.length === 0) return;

            if (this.compileTimeout) {
                clearTimeout(this.compileTimeout);
            }
            this.compileTimeout = setTimeout(() => {
                if (!this.isCompiling) {
                    this.compile();
                }
            }, this.options.debounceTime);
        });

        // Start observing immediately
        this.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });

        // Wait for initial compilation
        await initialCompilation;

        this.hasInitialized = true;
    } catch (error) {
        console.error('Error starting Tailwind compiler:', error);
    }
};



// Utilities initialization
// Initialize compiler and set up event listeners

// Initialize immediately without waiting for DOMContentLoaded
const compiler = new TailwindCompiler();

// Expose utilities compiler for optional integration
window.ManifestUtilities = compiler;

// Log when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        // DOM ready
    });
} else {
    // DOM already ready
}

// Log first paint if available
if ('PerformanceObserver' in window) {
    try {
        const paintObserver = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
            }
        });
        paintObserver.observe({ entryTypes: ['paint'] });
    } catch (e) {
        // PerformanceObserver might not be available
    }
}

// Also handle DOMContentLoaded for any elements that might be added later
document.addEventListener('DOMContentLoaded', () => {
    if (!compiler.usesStaticPrerenderUtilities && !compiler.isCompiling) {
        compiler.compile();
    }
});

