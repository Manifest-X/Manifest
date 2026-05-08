/* Manifest Colors */

// Initialize plugin when either DOM is ready or Alpine is ready
function initializeColorsPlugin() {

    // Initialize color mode state with Alpine reactivity
    const colors = Alpine.reactive({
        current: localStorage.getItem('theme') || 'system'
    })

    // Apply initial color mode
    applyColorMode(colors.current)

    // Setup system color mode listener
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', () => {
        if (colors.current === 'system') {
            applyColorMode('system')
        }
    })

    // Register colors directive
    Alpine.directive('colors', (el, { expression }, { evaluate, cleanup }) => {

        const handleClick = () => {
            const newMode = expression === 'toggle'
                ? (document.documentElement.classList.contains('dark') ? 'light' : 'dark')
                : evaluate(expression)
            setColorMode(newMode)
        }

        el.addEventListener('click', handleClick)
        cleanup(() => el.removeEventListener('click', handleClick))
    })

    // Add $colors magic method
    Alpine.magic('colors', () => ({
        get current() {
            return colors.current
        },
        set current(value) {
            setColorMode(value)
        }
    }))

    function setColorMode(newMode) {
        if (newMode === 'toggle') {
            newMode = colors.current === 'light' ? 'dark' : 'light'
        }

        // Update color mode state
        colors.current = newMode
        localStorage.setItem('theme', newMode)

        // Apply color mode
        applyColorMode(newMode)
    }

    function applyColorMode(mode) {
        const isDark = mode === 'system'
            ? window.matchMedia('(prefers-color-scheme: dark)').matches
            : mode === 'dark'

        // Update document classes
        document.documentElement.classList.remove('light', 'dark')
        document.documentElement.classList.add(isDark ? 'dark' : 'light')

        // Update meta theme-color
        const metaThemeColor = document.querySelector('meta[name="theme-color"]')
        if (metaThemeColor) {
            metaThemeColor.setAttribute('content', isDark ? '#000000' : '#FFFFFF')
        }
    }
}

// Track initialization to prevent duplicates
let colorsPluginInitialized = false;

function ensureColorsPluginInitialized() {
    if (colorsPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;

    colorsPluginInitialized = true;
    initializeColorsPlugin();
}

// Expose on window for loader to call if needed
window.ensureColorsPluginInitialized = ensureColorsPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureColorsPluginInitialized);
}

document.addEventListener('alpine:init', ensureColorsPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureColorsPluginInitialized, 0);
} else {
    // If document is already loaded but Alpine isn't ready yet, wait for it
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureColorsPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}