// Utilities initialization: create compiler, set up event listeners

// Stamp <html data-os> so OS variants (mac:, ios:, …) resolve in pure CSS
// (no CSS media feature for OS). Runs synchronously before first paint;
// honors an existing value (prerenderer or manual).
function detectOS() {
    try {
        const html = document.documentElement;
        if (!html || html.getAttribute('data-os')) return;
        const ua = navigator.userAgent || '';
        const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
        const touch = (navigator.maxTouchPoints || 0) > 1;
        let os = '';
        if (/Android/i.test(ua)) os = 'android';
        // iPadOS reports as "Mac" — disambiguate by the presence of touch points.
        else if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && touch)) os = 'ios';
        else if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) os = 'macos';
        else if (/Win/i.test(platform) || /Windows/i.test(ua)) os = 'windows';
        else if (/Linux|X11|CrOS/i.test(platform) || /Linux/i.test(ua)) os = 'linux';
        if (os) html.setAttribute('data-os', os);
    } catch (e) {
        // Non-fatal: OS-scoped utilities simply won't match.
    }
}
detectOS();

// Teach Tailwind the same device/OS variants via @custom-variant so its own
// utilities (px-4, flex) get touch:/mac:/cursor: like sm:/hover: — the Manifest
// compiler only applies them to its own utilities.
function injectTailwindVariants() {
    try {
        if (document.getElementById('manifest-tailwind-variants')) return;
        const style = document.createElement('style');
        style.id = 'manifest-tailwind-variants';
        style.setAttribute('type', 'text/tailwindcss');
        style.textContent = [
            '@custom-variant touch (@media (pointer: coarse));',
            '@custom-variant cursor (@media (pointer: fine) and (hover: hover));',
            '@custom-variant pointer (@media (any-pointer: fine));',
            '@custom-variant mac (&:where([data-os="macos"] *));',
            '@custom-variant windows (&:where([data-os="windows"] *));',
            '@custom-variant linux (&:where([data-os="linux"] *));',
            '@custom-variant ios (&:where([data-os="ios"] *));',
            '@custom-variant android (&:where([data-os="android"] *));',
            '@custom-variant apple (&:where([data-os="macos"] *, [data-os="ios"] *));',
            '@custom-variant online (&:where([data-online="true"] *));',
            '@custom-variant offline (&:where([data-online="false"] *));',
            '@custom-variant standalone (&:where([data-standalone] *));',
            '@custom-variant native (&:where([data-native] *));',
            '@custom-variant web (&:where(html:not([data-native]) *));'
        ].join('\n');
        (document.head || document.documentElement).appendChild(style);
    } catch (e) {
        // Non-fatal: Tailwind-utility variants simply won't be available.
    }
}
injectTailwindVariants();

// Initialize immediately without waiting for DOMContentLoaded
const compiler = new TailwindCompiler();

// Expose utilities compiler for optional integration
window.ManifestUtilities = compiler;

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
    });
} else {
}

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

// Recompile on DOMContentLoaded for late-added elements
document.addEventListener('DOMContentLoaded', () => {
    if (!compiler.usesStaticPrerenderUtilities && !compiler.isCompiling) {
        compiler.compile();
    }
});

