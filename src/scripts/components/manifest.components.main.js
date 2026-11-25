// Main initialization for Manifest Components
async function initializeComponents() {
    // Registry.initialize() may fetch manifest.json (async) when the loader
    // hasn't cached it yet; await it so the steps below see registry.manifest.
    if (window.ManifestComponentsRegistry) await window.ManifestComponentsRegistry.initialize();
    if (window.ManifestComponentsLoader) window.ManifestComponentsLoader.initialize();
    if (window.ManifestComponentsProcessor) window.ManifestComponentsProcessor.initialize();
    if (window.ManifestComponentsSwapping) window.ManifestComponentsSwapping.initialize();
    if (window.ManifestComponentsMutation) window.ManifestComponentsMutation.initialize();
    if (window.ManifestComponentsUtils) window.ManifestComponentsUtils.initialize?.();
    window.__manifestComponentsInitialized = true;
    window.dispatchEvent(new CustomEvent('manifest:components-ready'));
}

// Component HTML needs neither data nor Alpine: fetch it while they load (swapping still waits for data)
async function prefetchComponents() {
    const registry = window.ManifestComponentsRegistry;
    const loader = window.ManifestComponentsLoader;
    if (!registry || !loader || !loader.prefetchPlaceholders) return;
    try {
        await registry.initialize();
        if (window.__manifestComponentsInitialized) return;
        registry.preloaded.forEach(name => loader.loadComponent(name));
        const placeholders = [];
        for (const el of document.getElementsByTagName('*')) {
            if (el.localName.startsWith('x-') && !el.hasAttribute('data-pre-rendered') && !el.hasAttribute('data-processed')) placeholders.push(el);
        }
        const gate = window.ManifestComponentsRouting;
        loader.prefetchPlaceholders(placeholders, gate ? gate.gate() : null);
    } catch (_) { /* a hint: the main init loads whatever this missed */ }
}

// When data plugin is loaded: wait for manifest:data-ready so $x.content is ready before components render.
// When data plugin is absent: init immediately (no artificial delay).
function waitForDataThenInitialize() {
    const hasDataPlugin = typeof window.ManifestDataConfig !== 'undefined';
    if (hasDataPlugin) prefetchComponents();

    if (!hasDataPlugin) {
        initializeComponents();
        return;
    }

    window.addEventListener('manifest:data-ready', () => {
        initializeComponents();
    }, { once: true });

    // Fallback: if data plugin never fires (e.g. slow network, error), initialize anyway
    const fallbackMs = 5000;
    setTimeout(() => {
        if (!window.__manifestComponentsInitialized) {
            initializeComponents();
        }
    }, fallbackMs);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForDataThenInitialize);
} else {
    waitForDataThenInitialize();
}

window.ManifestComponents = {
    initialize: initializeComponents
};