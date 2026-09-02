/* Manifest Localization */

(function () {


// Original <html lang>, snapshotted before any locale mutation — the declared
// default that $locale.reset() restores to.
const originalHtmlLang = (typeof document !== 'undefined' && document.documentElement)
    ? (document.documentElement.lang || '')
    : '';

// RTL language codes — shared by the init plugin and the $locale magic.
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

// Endonym overrides — Intl.DisplayNames returns a wrong/anglicized/bare-code
// value for these, so pin the native-script names here. Overrides win over Intl.
const localeNameOverrides = {
    tl: 'Tagalog',
    dv: 'ދިވެހި',
    bal: 'بلوچی',
    glk: 'گیلکی',
    pnb: 'پنجابی',
    aii: 'ܣܘܪܝܬ',
};

// Native language name (endonym) for a BCP-47 code via Intl.DisplayNames,
// e.g. 'fr' → "français". Falls back to the raw code if unsupported.
const localeNameCache = new Map();
function localeName(code) {
    if (localeNameOverrides[code]) return localeNameOverrides[code];
    if (localeNameCache.has(code)) return localeNameCache.get(code);
    let name = code;
    try {
        if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames === 'function') {
            name = new Intl.DisplayNames([code], { type: 'language' }).of(code) || code;
        }
    } catch { /* unsupported code — keep raw code */ }
    localeNameCache.set(code, name);
    return name;
}

// Rich list backing $locale.list: one item per locale, with ordering views
// (alphabetical, currentFirst) as non-enumerable getters so x-for/spreads
// only see the items.
function buildLocaleList(available, current) {
    const list = available.map(code => ({
        code,
        name: localeName(code),
        direction: isRTL(code) ? 'rtl' : 'ltr',
        current: code === current
    }));
    Object.defineProperty(list, 'alphabetical', {
        enumerable: false,
        get() { return [...list].sort((a, b) => a.name.localeCompare(b.name)); }
    });
    Object.defineProperty(list, 'currentFirst', {
        enumerable: false,
        get() { return [...list].sort((a, b) => (b.current === true) - (a.current === true)); }
    });
    return list;
}

// Global setLocale wrapper — replaced with the real implementation at init
let setLocaleImpl = null;

async function setLocale(newLang, updateUrl = false) {
    if (setLocaleImpl) {
        return await setLocaleImpl(newLang, updateUrl);
    } else {
        console.warn('[Manifest Localization] setLocale implementation not ready yet, will retry');
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

    const isDevelopment = window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname.includes('dev') ||
        window.location.search.includes('debug=true');

    const debugLog = () => { };

    function isPrerenderedStaticBuild() {
        return document.head?.querySelector('meta[name="manifest:prerendered"][content="1"]') !== null;
    }

    // Locales the prerender generated URL paths for (from
    // <meta name="manifest:prerender-locales">). Switching to a locale not in
    // this set falls back to an in-page update rather than navigating (404).
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

        const pathWithoutLocale = hasLanguageInUrl ? pathParts.slice(1) : pathParts;

        // Skip locale-prefix changes for paths matching manifest:locale-route-exclude —
        // avoids a redirect loop against the prerender's locale-stripping.
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
                            // Locale-excluded — return URL unchanged so no navigation fires.
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

    // Validate a BCP 47 / ISO 639 language code: 2-3 letter primary tag, optional
    // region (-XX / -DDD) or script (-Xxxx). Strict enough to reject stray config
    // keys (appwriteTableId, scope, …) that a looser pattern let into `available`.
    function isValidLanguageCode(lang) {
        if (typeof lang !== 'string' || lang.length === 0) return false;
        return /^[a-z]{2,3}(?:-(?:[A-Z][a-z]{3}|[A-Z]{2}|\d{3}))?$/i.test(lang);
    }

    // Appwrite data sources carry structural keys (appwriteTableId, …) that must
    // not be mistaken for locale codes during discovery.
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
        },
        remove: (key) => {
            try {
                localStorage.removeItem(key);
                return true;
            } catch (error) {
                return false;
            }
        }
    };

    // Seed an empty store immediately so the magic method works
    if (!Alpine.store('locale')) {
        Alpine.store('locale', {
            current: document.documentElement.lang || 'en',
            available: [],
            direction: 'ltr',
            _initialized: false
        });
    } else {
    }

    let manifestCache = null;

    // Available locales from manifest, cached
    async function getAvailableLocales() {
        if (manifestCache) {
            return manifestCache;
        }

        try {
            let manifest = window.__manifestLoaded || window.ManifestComponentsRegistry?.manifest;
            // A partially-seeded global can be truthy yet lack `data` — await the
            // shared in-flight fetch (or start one, one request per boot) so locale
            // detection sees every source.
            if (!manifest || !manifest.data) {
                if (window.__manifestPromise) manifest = await window.__manifestPromise.catch(() => null);
                if (!manifest || !manifest.data) {
                    const manifestUrl = (document.querySelector('link[rel="manifest"]')?.getAttribute('href')) || '/manifest.json';
                    window.__manifestPromise = fetch(manifestUrl).then(r => {
                        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
                        return r.json();
                    }).then(m => { window.ManifestDataConfig?.interpolateManifest?.(m); return m; });
                    manifest = await window.__manifestPromise;
                }
            }

            if (!manifest || typeof manifest !== 'object') {
                throw new Error('Invalid manifest structure');
            }

            // Collect unique locales across data sources
            const locales = new Set();
            if (manifest.data && typeof manifest.data === 'object') {
                for (const [sourceName, collection] of Object.entries(manifest.data)) {
                    // Skip Appwrite collections (their config keys aren't locales)
                    if (isAppwriteDataSource(collection)) continue;
                    if (collection && typeof collection === 'object') {
                        // Single-file multi-locale CSV, e.g. {"locales": "file.csv"}
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
                                        // First column is 'key', rest are locale columns
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

                        // Per-locale keys, e.g. {"en": "en.csv", "fr": "fr.csv"}
                        Object.keys(collection).forEach(key => {
                            const reservedKeys = ['url', 'headers', 'params', 'transform', 'defaultValue', 'locales'];
                            if (isValidLanguageCode(key) && !reservedKeys.includes(key)) {
                                locales.add(key);
                            }
                        });
                    } else if (typeof collection === 'string' && collection.endsWith('.csv')) {
                        // Bare CSV path — inspect for locale columns
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
                                    // Localized CSV ('key' + locale columns) vs tabular ('id')
                                    const firstHeader = headers[0]?.toLowerCase();
                                    if (firstHeader === 'key' && headers.length > 1) {
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

            // No locales found — fall back to HTML lang or 'en'
            if (locales.size === 0) {
                const htmlLang = document.documentElement.lang;
                const fallbackLang = htmlLang && isValidLanguageCode(htmlLang) ? htmlLang : 'en';
                locales.add(fallbackLang);
            }

            const availableLocales = Array.from(locales);
            manifestCache = availableLocales;
            return availableLocales;
        } catch (error) {
            console.error('[Manifest Localization] Error loading manifest:', error);
            const htmlLang = document.documentElement.lang;
            const fallbackLang = htmlLang && isValidLanguageCode(htmlLang) ? htmlLang : 'en';
            return [fallbackLang];
        }
    }

    // Detect initial locale, by priority: URL > localStorage > <html lang> > browser > first available
    function detectInitialLocale(availableLocales) {

        // URL path (direct links)
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        if (pathParts[0] && isValidLanguageCode(pathParts[0]) && availableLocales.includes(pathParts[0])) {
            return pathParts[0];
        }

        // localStorage (UI-toggle preference)
        const storedLang = safeStorage.get('lang');
        if (storedLang && isValidLanguageCode(storedLang) && availableLocales.includes(storedLang)) {
            return storedLang;
        }

        // <html lang>
        const htmlLang = document.documentElement.lang;
        if (htmlLang && isValidLanguageCode(htmlLang) && availableLocales.includes(htmlLang)) {
            return htmlLang;
        }

        // Browser language
        if (navigator.language) {
            const browserLang = navigator.language.split('-')[0];
            if (isValidLanguageCode(browserLang) && availableLocales.includes(browserLang)) {
                return browserLang;
            }
        }

        const defaultLang = availableLocales[0] || 'en';
        return defaultLang;
    }

    async function setLocaleReal(newLang, updateUrl = false) {

        if (!isValidLanguageCode(newLang)) {
            console.error('[Manifest Localization] Invalid language code:', newLang);
            return false;
        }

        const store = Alpine.store('locale');

        // Load available locales if not yet present
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
            // In prerendered output, switching normally navigates to the target
            // locale's URL — but only if that locale was actually prerendered
            // (else 404). A single-locale site has no other locale URLs, so every
            // switch becomes an in-page "scoped demo" change instead. Scoped
            // changes skip localStorage/URL persistence so they don't leak the
            // demo locale into later page loads.
            let isScopedDemoChange = false;
            if (isPrerenderedStaticBuild()) {
                const prerenderLocales = getPrerenderLocales();
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
                isScopedDemoChange = true;
            }

            store.current = newLang;
            store.direction = isRTL(newLang) ? 'rtl' : 'ltr';
            store._initialized = true;

            try {
                document.documentElement.lang = newLang;
                document.documentElement.dir = store.direction;
            } catch (domError) {
                console.error('[Manifest Localization] DOM update error:', domError);
            }

            // Persist preference, except for scoped demo changes
            if (!isScopedDemoChange) {
                safeStorage.set('lang', newLang);
            }

            // Update URL (replace existing locale prefix, or add when updateUrl).
            // Skipped for scoped demo changes — the prefixed URL wasn't prerendered.
            try {
                const currentUrl = new URL(window.location.href);
                const pathParts = currentUrl.pathname.split('/').filter(Boolean);
                const hasLanguageInUrl = pathParts[0] && store.available.includes(pathParts[0]);

                if (!isScopedDemoChange && (updateUrl || hasLanguageInUrl)) {
                    if (hasLanguageInUrl) {
                        if (pathParts[0] !== newLang) {
                            pathParts[0] = newLang;
                            currentUrl.pathname = '/' + pathParts.join('/');
                            window.history.replaceState({}, '', currentUrl);
                        }
                    } else if (updateUrl && pathParts.length > 0) {
                        pathParts.unshift(newLang);
                        currentUrl.pathname = '/' + pathParts.join('/');
                        window.history.replaceState({}, '', currentUrl);
                    }
                }
            } catch (urlError) {
                console.error('[Manifest Localization] URL update error:', urlError);
            }

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
            // Restore previous state
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

    // $locale.reset implementation — exposed via window so registerLocaleMagic
    // (a sibling top-level fn) can call it while keeping closure access to
    // safeStorage / isValidLanguageCode / isRTL / originalHtmlLang.
    function resetLocaleReal(href) {
        const store = Alpine.store('locale');
        const available = store?.available || [originalHtmlLang || 'en'];

        // Clear stored preference so future loads re-detect
        safeStorage.remove('lang');

        // Resolve default: original <html lang> > browser language > first available
        let defaultLocale = null;
        if (originalHtmlLang
            && isValidLanguageCode(originalHtmlLang)
            && available.includes(originalHtmlLang)) {
            defaultLocale = originalHtmlLang;
        } else if (navigator.language) {
            const browserLang = navigator.language.split('-')[0];
            if (isValidLanguageCode(browserLang) && available.includes(browserLang)) {
                defaultLocale = browserLang;
            }
        }
        if (!defaultLocale) {
            defaultLocale = available[0] || 'en';
        }

        // Resolve target URL and strip any leading locale segment
        let target;
        try {
            target = new URL(href || window.location.href, window.location.href);
        } catch {
            return false;
        }
        const segs = target.pathname.split('/').filter(Boolean);
        if (segs.length && available.includes(segs[0])) {
            segs.shift();
        }
        target.pathname = '/' + segs.join('/');

        // Apply default to live store + DOM before navigating
        if (store && store.current !== defaultLocale) {
            store.current = defaultLocale;
            store.direction = isRTL(defaultLocale) ? 'rtl' : 'ltr';
            try {
                document.documentElement.lang = defaultLocale;
                document.documentElement.dir = store.direction;
            } catch { /* DOM unavailable */ }
            try {
                window.dispatchEvent(new CustomEvent('localechange', {
                    detail: { locale: defaultLocale }
                }));
            } catch { /* event dispatch unavailable */ }
        }

        // Navigate to the locale-stripped URL: SPA hop live, MPA hop when prerendered
        const isSameOrigin = target.origin === window.location.origin;
        const isPrerendered = !!document.querySelector('meta[name="manifest:prerendered"]:not([content="0"]):not([content="false"])');

        if (isSameOrigin && !isPrerendered && typeof history?.pushState === 'function') {
            history.pushState(null, '', target.pathname + target.search + target.hash);
            window.dispatchEvent(new PopStateEvent('popstate'));
        } else {
            window.location.assign(target.toString());
        }
        return true;
    }
    window.__manifestResetLocale = resetLocaleReal;

    let routeChangeListener = null;

    // Initialize from manifest data
    (async () => {
        try {
            const availableLocales = await getAvailableLocales();
            const store = Alpine.store('locale');
            store.available = availableLocales;

            const initialLocale = detectInitialLocale(availableLocales);

            const success = await setLocale(initialLocale, true);
        } catch (error) {
            console.error('[Manifest Localization] Initialization error:', error);
        }
    })();

    // Sync locale to router navigation
    routeChangeListener = async (event) => {
        try {
            const newPath = event.detail.to;

            const pathParts = newPath.split('/').filter(Boolean);
            const store = Alpine.store('locale');

            if (pathParts[0] && isValidLanguageCode(pathParts[0]) && store.available.includes(pathParts[0])) {
                const newLocale = pathParts[0];

                if (newLocale !== store.current) {
                    await setLocale(newLocale, true);
                }
            }
        } catch (error) {
            console.error('[Manifest Localization] Router navigation error:', error);
        }
    };

    window.addEventListener('manifest:route-change', routeChangeListener);

    const cleanup = () => {
        if (routeChangeListener) {
            window.removeEventListener('manifest:route-change', routeChangeListener);
            routeChangeListener = null;
        }
        manifestCache = null;
    };

    window.__manifestLocalizationCleanup = cleanup;
}

// Register the $locale magic — runs before full init so it's available early
function registerLocaleMagic() {

    if (!window.Alpine) {
        return false;
    }

    if (typeof window.Alpine.magic !== 'function') {
        return false;
    }

    if (window.__manifestLocaleMagicRegistered) {
        return true;
    }

    window.__manifestLocaleMagicRegistered = true;

    try {
        Alpine.magic('locale', () => {
            const store = Alpine.store('locale');

            // Create a minimal store if none exists yet
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
                    if (prop === 'name') {
                        const fallback = document.documentElement.lang || 'en';
                        return localeName(currentStore?.current || fallback);
                    }
                    if (prop === 'list') {
                        const fallback = document.documentElement.lang || 'en';
                        return buildLocaleList(
                            currentStore?.available || [fallback],
                            currentStore?.current || fallback
                        );
                    }
                    if (prop === 'set') {
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
                    // $locale.reset([href]) — restore the project's default locale
                    // (see resetLocaleReal). Also strips any leading locale slug
                    // from the URL so it won't re-detect on the next load.
                    if (prop === 'reset') {
                        return (href) => {
                            if (window.__manifestResetLocale) {
                                return window.__manifestResetLocale(href);
                            }
                            console.error('[Manifest Localization] resetLocale not available');
                            return false;
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

function setupLocalization() {

    const registered = registerLocaleMagic();

    if (window.Alpine) {
        initializeLocalizationPlugin();
    } else {
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

// Guard against duplicate initialization
let localizationPluginInitialized = false;

function ensureLocalizationPluginInitialized() {
    if (localizationPluginInitialized) return;
    if (!window.Alpine || typeof window.Alpine.magic !== 'function') return;

    localizationPluginInitialized = true;
    registerLocaleMagic();
    setupLocalization();
}

window.ensureLocalizationPluginInitialized = ensureLocalizationPluginInitialized;

document.addEventListener('alpine:init', () => {
    ensureLocalizationPluginInitialized();
}, { once: true });

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureLocalizationPluginInitialized);
} else {
    ensureLocalizationPluginInitialized();
}

// Alpine already up when this loads — init on next tick / poll
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

})();
