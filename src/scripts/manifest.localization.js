/* Manifest Localization */

// Global setLocale wrapper - will be replaced with real implementation
let setLocaleImpl = null;

// Wrapper function available immediately
async function setLocale(newLang, updateUrl = false) {
    if (setLocaleImpl) {
        return await setLocaleImpl(newLang, updateUrl);
    } else {
        console.warn('[Manifest Localization] setLocale implementation not ready yet, will retry');
        // Wait a bit and try again
        await new Promise(resolve => setTimeout(resolve, 100));
        if (setLocaleImpl) {
            return await setLocaleImpl(newLang, updateUrl);
        }
        console.error('[Manifest Localization] setLocale still not available after retry');
        return false;
    }
}

// Expose immediately so magic method can use it
window.__manifestSetLocale = setLocale;

function initializeLocalizationPlugin() {

    // Environment detection for debug logging
    const isDevelopment = window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname.includes('dev') ||
        window.location.search.includes('debug=true');

    // Debug logging helper (always enabled for now)
    // Debug logging disabled for production
    const debugLog = () => { };

    // RTL language codes - using Set for O(1) lookups
    const rtlLanguages = new Set([
        // Arabic script
        'ar',     // Arabic
        'az-Arab',// Azerbaijani (Arabic script)
        'bal',    // Balochi
        'ckb',    // Central Kurdish (Sorani)
        'fa',     // Persian (Farsi)
        'glk',    // Gilaki
        'ks',     // Kashmiri
        'ku-Arab',// Kurdish (Arabic script)
        'lrc',    // Northern Luri
        'mzn',    // Mazanderani
        'pnb',    // Western Punjabi (Shahmukhi)
        'ps',     // Pashto
        'sd',     // Sindhi
        'ur',     // Urdu

        // Hebrew script
        'he',     // Hebrew
        'yi',     // Yiddish
        'jrb',    // Judeo-Arabic
        'jpr',    // Judeo-Persian
        'lad-Hebr',// Ladino (Hebrew script)

        // Thaana script
        'dv',     // Dhivehi (Maldivian)

        // N’Ko script
        'nqo',    // N’Ko (West Africa)

        // Syriac script
        'syr',    // Syriac
        'aii',    // Assyrian Neo-Aramaic
        'arc',    // Aramaic
        'sam',    // Samaritan Aramaic

        // Mandaic script
        'mid',    // Mandaic

        // Other RTL minority/obscure scripts
        'uga',    // Ugaritic
        'phn',    // Phoenician
        'xpr',    // Parthian (ancient)
        'peo',    // Old Persian (cuneiform, but RTL)
        'pal',    // Middle Persian (Pahlavi)
        'avst',   // Avestan
        'man',    // Manding (N'Ko variants)
    ]);

    // Detect if a language is RTL
    function isRTL(lang) {
        return rtlLanguages.has(lang);
    }

    function isPrerenderedStaticBuild() {
        return document.head?.querySelector('meta[name="manifest:prerendered"][content="1"]') !== null;
    }

    // Returns the set of locales the prerender actually generated URL paths for.
    // Read from `<meta name="manifest:prerender-locales" content="en,fr,...">`.
    // When the target locale isn't in this set, MPA locale switching should NOT
    // navigate (it would 404) — instead, fall back to the in-page store update
    // so locale-aware data sources (e.g. examples on a localization docs page)
    // can re-render without leaving the current page.
    function getPrerenderLocales() {
        const meta = document.head?.querySelector('meta[name="manifest:prerender-locales"]');
        const content = meta?.getAttribute('content') || '';
        return content
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
    }

    function buildLocaleNavigationUrl(newLang, availableLocales) {
        const currentUrl = new URL(window.location.href);
        const pathParts = currentUrl.pathname.split('/').filter(Boolean);
        const hasLanguageInUrl = pathParts[0] && availableLocales.includes(pathParts[0]);

        // Determine path segments without any current locale prefix, for exclude-pattern checking.
        const pathWithoutLocale = hasLanguageInUrl ? pathParts.slice(1) : pathParts;

        // If the current path matches a manifest:locale-route-exclude pattern, do NOT add or
        // change the locale prefix — this prevents an infinite redirect loop on prerendered
        // builds where normalizeRedundantLocalePrefixInUrl() strips the locale from the URL
        // but the localization init would otherwise re-add it via window.location.assign().
        const routeExcludeMeta = document.querySelector('meta[name="manifest:locale-route-exclude"]');
        if (routeExcludeMeta) {
            try {
                const rawContent = (routeExcludeMeta.getAttribute('content') || '').replace(/&quot;/g, '"');
                const patterns = JSON.parse(rawContent);
                if (Array.isArray(patterns) && patterns.length > 0) {
                    const lower = pathWithoutLocale.map(s => s.toLowerCase());
                    for (const pattern of patterns) {
                        const p = String(pattern).trim().replace(/^\/+/, '').split('/').filter(Boolean).map(x => x.toLowerCase());
                        if (p.length === 0) continue;
                        if (lower.length < p.length) continue;
                        let match = true;
                        for (let i = 0; i < p.length; i++) {
                            if (lower[i] !== p[i]) { match = false; break; }
                        }
                        if (match) {
                            // Path is locale-excluded — return URL unchanged so no navigation is triggered
                            return currentUrl.toString();
                        }
                    }
                }
            } catch { /* ignore JSON parse errors */ }
        }

        if (hasLanguageInUrl) pathParts[0] = newLang;
        else pathParts.unshift(newLang);
        currentUrl.pathname = '/' + pathParts.join('/') + '/';
        return currentUrl.toString();
    }

    // Input validation for language codes.
    //
    // Conforms to BCP 47 / ISO 639 shape:
    //   - 2 or 3 letter primary tag (e.g. en, fr, zh, kab)
    //   - Optional region: -XX (ISO 3166 alpha-2, e.g. en-US) or -DDD (UN M.49)
    //   - Optional script: -Xxxx (ISO 15924, e.g. zh-Hans, zh-Hant)
    //
    // The previous /^[a-zA-Z0-9_-]+$/ pattern was too permissive — it matched
    // arbitrary identifiers like `appwriteTableId`, `scope`, `storage` from
    // non-localization data source configs and added them to `available`.
    function isValidLanguageCode(lang) {
        if (typeof lang !== 'string' || lang.length === 0) return false;
        return /^[a-z]{2,3}(?:-(?:[A-Z][a-z]{3}|[A-Z]{2}|\d{3}))?$/i.test(lang);
    }

    // Identify data source entries that are Appwrite collections/buckets.
    // These have structural keys like `appwriteTableId` / `appwriteBucketId`
    // that must not be treated as locale codes during locale discovery.
    function isAppwriteDataSource(collection) {
        return !!(collection && typeof collection === 'object' &&
            (collection.appwriteTableId || collection.appwriteBucketId ||
             collection.appwriteDatabaseId));
    }

    // Safe localStorage operations with error handling
    const safeStorage = {
        get: (key) => {
            try {
                return localStorage.getItem(key);
            } catch (error) {
                return null;
            }
        },
        set: (key, value) => {
            try {
                localStorage.setItem(key, value);
                return true;
            } catch (error) {
                return false;
            }
        }
    };

    // Initialize empty localization store (create immediately so magic method works)
    if (!Alpine.store('locale')) {
        Alpine.store('locale', {
            current: document.documentElement.lang || 'en',
            available: [],
            direction: 'ltr',
            _initialized: false
        });
    } else {
    }

    // Cache for manifest data
    let manifestCache = null;

    // Get available locales from manifest with caching
    async function getAvailableLocales() {
        // Return cached data if available
        if (manifestCache) {
            return manifestCache;
        }

        try {
            let manifest = window.__manifestLoaded || window.ManifestComponentsRegistry?.manifest;
            if (!manifest) {
                const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
                const response = await fetch(manifestUrl);
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                manifest = await response.json();
            }

            // Validate manifest structure
            if (!manifest || typeof manifest !== 'object') {
                throw new Error('Invalid manifest structure');
            }

            // Get unique locales from data sources
            const locales = new Set();
            if (manifest.data && typeof manifest.data === 'object') {
                // Process each data source
                for (const [sourceName, collection] of Object.entries(manifest.data)) {
                    // Skip Appwrite collections — their config keys (appwriteTableId,
                    // scope, storage, etc.) shouldn't be treated as locale codes.
                    if (isAppwriteDataSource(collection)) continue;
                    if (collection && typeof collection === 'object') {
                        // Check for single-file multi-locale CSV (e.g., {"locales": "/path/to/file.csv"})
                        if (collection.locales && typeof collection.locales === 'string' && collection.locales.endsWith('.csv')) {
                            try {
                                const base = typeof window.getManifestBase === 'function' ? window.getManifestBase() : '';
                                const localesPath = collection.locales.startsWith('/') ? collection.locales.slice(1) : collection.locales;
                                const localesUrl = (collection.locales.startsWith('http')) ? collection.locales : (base + localesPath);
                                const csvResponse = await fetch(localesUrl);
                                if (csvResponse.ok) {
                                    const csvText = await csvResponse.text();
                                    // Parse CSV header to get locale columns
                                    const lines = csvText.split('\n').filter(line => line.trim());
                                    if (lines.length > 0) {
                                        const headers = lines[0].split(',').map(h => h.trim());
                                        // First column is typically 'key', rest are locale columns
                                        headers.forEach(header => {
                                            if (header !== 'key' && isValidLanguageCode(header)) {
                                                locales.add(header);
                                            }
                                        });
                                    }
                                }
                            } catch (csvError) {
                                console.warn('[Manifest Localization] Error loading locales CSV:', csvError);
                            }
                        }

                        // Check for locale keys in manifest (e.g., {"en": "/path/to/en.csv", "fr": "/path/to/fr.csv"})
                        Object.keys(collection).forEach(key => {
                            // Exclude reserved config keys (add more as needed for future phases)
                            const reservedKeys = ['url', 'headers', 'params', 'transform', 'defaultValue', 'locales'];

                            // Accept any valid language code that's not a reserved key
                            // This allows custom locale codes like "klingon", "en", "fr", etc.
                            if (isValidLanguageCode(key) && !reservedKeys.includes(key)) {
                                locales.add(key);
                            }
                        });
                    } else if (typeof collection === 'string' && collection.endsWith('.csv')) {
                        // Simple CSV file path - check if it has locale columns
                        try {
                            const base = typeof window.getManifestBase === 'function' ? window.getManifestBase() : '';
                            const csvPath = collection.startsWith('/') ? collection.slice(1) : collection;
                            const csvUrl = collection.startsWith('http') ? collection : (base + csvPath);
                            const csvResponse = await fetch(csvUrl);
                            if (csvResponse.ok) {
                                const csvText = await csvResponse.text();
                                const lines = csvText.split('\n').filter(line => line.trim());
                                if (lines.length > 0) {
                                    const headers = lines[0].split(',').map(h => h.trim());
                                    // Check if this looks like a localized CSV (has 'key' column + locale columns)
                                    // vs tabular data (has 'id' column)
                                    const firstHeader = headers[0]?.toLowerCase();
                                    if (firstHeader === 'key' && headers.length > 1) {
                                        // This is a key-value CSV, check for locale columns
                                        headers.forEach(header => {
                                            if (header !== 'key' && isValidLanguageCode(header)) {
                                                locales.add(header);
                                            }
                                        });
                                        if (locales.size > 0) {
                                        }
                                    }
                                }
                            }
                        } catch (csvError) {
                            console.warn('[Manifest Localization] Error checking simple CSV for locales:', csvError);
                        }
                    }
                }
            }

            // If no locales found, fallback to HTML lang or 'en'
            if (locales.size === 0) {
                const htmlLang = document.documentElement.lang;
                const fallbackLang = htmlLang && isValidLanguageCode(htmlLang) ? htmlLang : 'en';
                locales.add(fallbackLang);
            }

            const availableLocales = Array.from(locales);

            // Cache the result
            manifestCache = availableLocales;
            return availableLocales;
        } catch (error) {
            console.error('[Manifest Localization] Error loading manifest:', error);
            // Fallback to HTML lang or 'en'
            const htmlLang = document.documentElement.lang;
            const fallbackLang = htmlLang && isValidLanguageCode(htmlLang) ? htmlLang : 'en';
            return [fallbackLang];
        }
    }

    // Detect initial locale
    function detectInitialLocale(availableLocales) {

        // 1. Check URL path first (highest priority for direct links)
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        if (pathParts[0] && isValidLanguageCode(pathParts[0]) && availableLocales.includes(pathParts[0])) {
            return pathParts[0];
        }

        // 2. Check localStorage (user preference from UI toggles)
        const storedLang = safeStorage.get('lang');
        if (storedLang && isValidLanguageCode(storedLang) && availableLocales.includes(storedLang)) {
            return storedLang;
        }

        // 3. Check HTML lang attribute
        const htmlLang = document.documentElement.lang;
        if (htmlLang && isValidLanguageCode(htmlLang) && availableLocales.includes(htmlLang)) {
            return htmlLang;
        }

        // 4. Check browser language
        if (navigator.language) {
            const browserLang = navigator.language.split('-')[0];
            if (isValidLanguageCode(browserLang) && availableLocales.includes(browserLang)) {
                return browserLang;
            }
        }

        // Default to first available locale
        const defaultLang = availableLocales[0] || 'en';
        return defaultLang;
    }

    // Update locale - this is the real implementation
    async function setLocaleReal(newLang, updateUrl = false) {

        // Validate input
        if (!isValidLanguageCode(newLang)) {
            console.error('[Manifest Localization] Invalid language code:', newLang);
            return false;
        }

        const store = Alpine.store('locale');

        // If available locales aren't loaded yet, load them first
        if (!store.available || store.available.length === 0) {
            const availableLocales = await getAvailableLocales();
            if (!availableLocales.includes(newLang)) {
                console.error('[Manifest Localization] Locale not in available locales:', newLang);
                return false;
            }
        } else if (!store.available.includes(newLang)) {
            console.error('[Manifest Localization] Locale not in available locales:', newLang, 'Available:', store.available);
            return false;
        }

        if (newLang === store.current) {
            return false;
        }


        try {
            // In prerendered static output, locale switching normally navigates
            // to the target locale's URL.  But only do this when the target
            // locale was ACTUALLY prerendered — otherwise navigation would 404.
            //
            // When the host site has a single locale (e.g. an English docs site
            // with locale-aware example data on one page), `prerender-locales`
            // contains only that locale.  Switching to any other locale falls
            // through to the in-page store update below — locale-aware data
            // re-loads via the `localechange` event and the page reflects the
            // new locale without navigating.
            // Track whether this is a "scoped" change (in-page only on a
            // prerendered single-locale site).  Scoped changes must NOT persist
            // to localStorage or update the URL — the locale is a transient
            // example/demo state, not a site-wide preference.  Persisting would
            // leak the demo locale to subsequent page loads via localStorage,
            // making `<html lang>` mismatch the actual baked content (English
            // article body with `lang="fr"`) and muddying the SEO signal.
            let isScopedDemoChange = false;
            if (isPrerenderedStaticBuild()) {
                const prerenderLocales = getPrerenderLocales();
                // Multi-locale site: navigate to the target locale's URL.
                // Single-locale site: there are no other locale URLs to navigate
                // to (the renderer skips the redundant default-locale mirror),
                // so ALL switches must be treated as in-page demos.
                const isMultiLocaleSite = prerenderLocales.length > 1;
                const targetIsPrerendered =
                    prerenderLocales.length === 0 ||
                    prerenderLocales.includes(newLang);
                if (isMultiLocaleSite && targetIsPrerendered) {
                    const targetUrl = buildLocaleNavigationUrl(newLang, store.available || []);
                    if (targetUrl !== window.location.href) {
                        window.location.assign(targetUrl);
                    }
                    return true;
                }
                // In-page demo: locale-aware data re-renders without navigating.
                // Mark as scoped so we skip URL/localStorage persistence below.
                isScopedDemoChange = true;
            }

            // Update store
            store.current = newLang;
            store.direction = isRTL(newLang) ? 'rtl' : 'ltr';
            store._initialized = true;

            // Update HTML safely
            try {
                document.documentElement.lang = newLang;
                document.documentElement.dir = store.direction;
            } catch (domError) {
                console.error('[Manifest Localization] DOM update error:', domError);
            }

            // Update localStorage safely — but skip for scoped demo changes
            // so the next page load doesn't restore a non-prerendered locale.
            if (!isScopedDemoChange) {
                safeStorage.set('lang', newLang);
            }

            // Update URL based on current URL state and updateUrl parameter.
            // Skip entirely for scoped demo changes — adding/replacing a locale
            // prefix would point at a URL that wasn't prerendered (404).
            try {
                const currentUrl = new URL(window.location.href);
                const pathParts = currentUrl.pathname.split('/').filter(Boolean);
                const hasLanguageInUrl = pathParts[0] && store.available.includes(pathParts[0]);

                if (!isScopedDemoChange && (updateUrl || hasLanguageInUrl)) {
                    // Update URL if:
                    // 1. updateUrl is explicitly true (router navigation, initialization)
                    // 2. OR there's already a language code in the URL (user expects URL to update)

                    if (hasLanguageInUrl) {
                        // Replace existing language code
                        if (pathParts[0] !== newLang) {
                            pathParts[0] = newLang;
                            currentUrl.pathname = '/' + pathParts.join('/');
                            window.history.replaceState({}, '', currentUrl);
                        }
                    } else if (updateUrl && pathParts.length > 0) {
                        // Add language code only if explicitly requested (router/init)
                        pathParts.unshift(newLang);
                        currentUrl.pathname = '/' + pathParts.join('/');
                        window.history.replaceState({}, '', currentUrl);
                    }
                }
            } catch (urlError) {
                console.error('[Manifest Localization] URL update error:', urlError);
            }

            // Trigger locale change event
            try {
                window.dispatchEvent(new CustomEvent('localechange', {
                    detail: { locale: newLang }
                }));
            } catch (eventError) {
                console.error('[Manifest Localization] Event dispatch error:', eventError);
            }

            return true;

        } catch (error) {
            console.error('[Manifest Localization] Error setting locale:', error);
            // Restore previous state safely
            const fallbackLang = safeStorage.get('lang') || store.available[0] || 'en';
            store.current = fallbackLang;
            store.direction = isRTL(fallbackLang) ? 'rtl' : 'ltr';
            try {
                document.documentElement.lang = store.current;
                document.documentElement.dir = store.direction;
            } catch (domError) {
                console.error('[Manifest Localization] DOM restore error:', domError);
            }
            return false;
        }
    }

    // Replace the wrapper with the real implementation
    setLocaleImpl = setLocaleReal;
    window.__manifestSetLocale = setLocaleReal;

    // Event listener cleanup tracking
    let routeChangeListener = null;

    // Initialize with manifest data
    (async () => {
        try {
            const availableLocales = await getAvailableLocales();
            const store = Alpine.store('locale');
            store.available = availableLocales;

            const initialLocale = detectInitialLocale(availableLocales);

            const success = await setLocale(initialLocale, true);
            // Locale initialization complete
        } catch (error) {
            console.error('[Manifest Localization] Initialization error:', error);
        }
    })();

    // Listen for router navigation to detect locale changes
    routeChangeListener = async (event) => {
        try {
            const newPath = event.detail.to;

            // Extract locale from new path
            const pathParts = newPath.split('/').filter(Boolean);
            const store = Alpine.store('locale');

            if (pathParts[0] && isValidLanguageCode(pathParts[0]) && store.available.includes(pathParts[0])) {
                const newLocale = pathParts[0];

                // Only change if it's different from current locale
                if (newLocale !== store.current) {
                    await setLocale(newLocale, true);
                }
            }
        } catch (error) {
            console.error('[Manifest Localization] Router navigation error:', error);
        }
    };

    window.addEventListener('manifest:route-change', routeChangeListener);

    // Cleanup function for memory management
    const cleanup = () => {
        if (routeChangeListener) {
            window.removeEventListener('manifest:route-change', routeChangeListener);
            routeChangeListener = null;
        }
        manifestCache = null;
    };

    // Expose cleanup for external use
    window.__manifestLocalizationCleanup = cleanup;
}

// Register $locale magic method immediately when Alpine is available
// This ensures it's available even before full initialization completes
function registerLocaleMagic() {

    if (!window.Alpine) {
        return false;
    }

    if (typeof window.Alpine.magic !== 'function') {
        return false;
    }

    // Only register once
    if (window.__manifestLocaleMagicRegistered) {
        return true;
    }

    window.__manifestLocaleMagicRegistered = true;

    try {
        Alpine.magic('locale', () => {
            const store = Alpine.store('locale');

            // If store doesn't exist yet, create minimal one
            if (!store) {
                Alpine.store('locale', {
                    current: document.documentElement.lang || 'en',
                    available: [document.documentElement.lang || 'en'],
                    direction: 'ltr',
                    _initialized: false
                });
            }

            return new Proxy({}, {
                get(target, prop) {
                    const currentStore = Alpine.store('locale');
                    if (prop === 'current') return currentStore?.current || document.documentElement.lang || 'en';
                    if (prop === 'available') return currentStore?.available || [document.documentElement.lang || 'en'];
                    if (prop === 'direction') return currentStore?.direction || 'ltr';
                    if (prop === 'set') {
                        // Use the global setLocale function (wrapper or real implementation)
                        return async (locale, updateUrl = false) => {
                            if (window.__manifestSetLocale) {
                                const result = await window.__manifestSetLocale(locale, updateUrl);
                                return result;
                            }
                            console.error('[Manifest Localization] setLocale not available');
                            return false;
                        };
                    }
                    if (prop === 'toggle') {
                        return () => {
                            const store = Alpine.store('locale');
                            const available = store?.available || [document.documentElement.lang || 'en'];
                            const current = store?.current || document.documentElement.lang || 'en';
                            const currentIndex = available.indexOf(current);
                            const nextIndex = (currentIndex + 1) % available.length;
                            if (window.__manifestSetLocale) {
                                window.__manifestSetLocale(available[nextIndex], false);
                            }
                        };
                    }
                    return undefined;
                }
            });
        });
        return true;
    } catch (error) {
        console.error('[Manifest Localization] Error registering magic method:', error);
        window.__manifestLocaleMagicRegistered = false;
        return false;
    }
}

// Handle initialization
function setupLocalization() {

    // Try to register magic method immediately
    const registered = registerLocaleMagic();

    if (window.Alpine) {
        initializeLocalizationPlugin();
    } else {
        // Wait for Alpine, then register magic method and initialize
        document.addEventListener('alpine:init', () => {
            const registered = registerLocaleMagic();
            if (registered) {
                initializeLocalizationPlugin();
            } else {
                console.error('[Manifest Localization] Failed to register magic method on alpine:init');
            }
        }, { once: true });
    }
}

// Track initialization to prevent duplicates
let localizationPluginInitialized = false;

function ensureLocalizationPluginInitialized() {
    if (localizationPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.magic !== 'function') return;

    localizationPluginInitialized = true;
    registerLocaleMagic();
    setupLocalization();
}

// Expose on window for loader to call if needed
window.ensureLocalizationPluginInitialized = ensureLocalizationPluginInitialized;

// Register magic method on alpine:init (fires when Alpine initializes)
document.addEventListener('alpine:init', () => {
    ensureLocalizationPluginInitialized();
}, { once: true });

// Handle both DOMContentLoaded and immediate execution
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureLocalizationPluginInitialized);
} else {
    ensureLocalizationPluginInitialized();
}

// If Alpine is already initialized when this script loads, initialize immediately
if (window.Alpine && typeof window.Alpine.magic === 'function') {
    setTimeout(ensureLocalizationPluginInitialized, 0);
} else {
    const checkAlpine = setInterval(() => {
        if (window.Alpine && typeof window.Alpine.magic === 'function') {
            clearInterval(checkAlpine);
            ensureLocalizationPluginInitialized();
        }
    }, 10);
    setTimeout(() => clearInterval(checkAlpine), 5000);
}