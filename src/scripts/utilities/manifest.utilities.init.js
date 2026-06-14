// Utilities initialization
// Initialize compiler and set up event listeners

// Detect operating system and stamp it on <html data-os> so OS variants
// (mac:, ios:, windows:, …) and the *-only visibility classes can resolve in
// pure CSS. There is no CSS media feature for OS, so this one-time read is the
// minimum required. Runs synchronously at script load (documentElement exists
// during head parsing) to set the marker before first paint. Honors a value
// already present (e.g. written by the prerenderer or set manually).
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

// Register the device/OS variants with Tailwind too. The Manifest compiler
// applies these variants to its own theme-derived/semantic utilities, but
// standard Tailwind utilities (px-4, flex, …) are emitted by Tailwind's own
// engine, which only knows its built-in variants. A `<style type="text/tailwindcss">`
// carrying @custom-variant definitions teaches Tailwind the same variants, so
// touch:px-4 / mac:flex / cursor:gap-2 resolve like sm:/hover:. Tailwind's
// browser build reprocesses when this style is added, so load order is moot.
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
            '@custom-variant apple (&:where([data-os="macos"] *, [data-os="ios"] *));'
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

