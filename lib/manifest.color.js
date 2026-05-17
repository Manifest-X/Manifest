/* Manifest Color */

// Initialize plugin when either DOM is ready or Alpine is ready
function initializeColorPlugin() {

    // Initialize color mode state with Alpine reactivity
    const color = Alpine.reactive({
        current: localStorage.getItem('theme') || 'system'
    })

    // Apply initial color mode
    applyColorMode(color.current)

    // Setup system color mode listener
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener('change', () => {
        if (color.current === 'system') {
            applyColorMode('system')
        }
    })

    // Register color directive
    Alpine.directive('color', (el, { expression }, { evaluate, cleanup }) => {

        const handleClick = () => {
            const newMode = expression === 'toggle'
                ? (document.documentElement.classList.contains('dark') ? 'light' : 'dark')
                : evaluate(expression)
            setColorMode(newMode)
        }

        el.addEventListener('click', handleClick)
        cleanup(() => el.removeEventListener('click', handleClick))
    })

    // Add $color magic method
    Alpine.magic('color', () => ({
        get current() {
            return color.current
        },
        set current(value) {
            setColorMode(value)
        }
    }))

    function setColorMode(newMode) {
        if (newMode === 'toggle') {
            newMode = color.current === 'light' ? 'dark' : 'light'
        }

        // Update color mode state
        color.current = newMode
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
let colorPluginInitialized = false;

function ensureColorPluginInitialized() {
    if (colorPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.directive !== 'function') return;

    colorPluginInitialized = true;
    initializeColorPlugin();
}

// Expose on window for loader to call if needed
window.ensureColorPluginInitialized = ensureColorPluginInitialized;

// Handle both DOMContentLoaded and alpine:init
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureColorPluginInitialized);
}

document.addEventListener('alpine:init', ensureColorPluginInitialized);

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.directive === 'function') {
    setTimeout(ensureColorPluginInitialized, 0);
} else {
    // If document is already loaded but Alpine isn't ready yet, wait for it
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.directive === 'function') {
            clearInterval(checkAlpine);
            ensureColorPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}