// Tailwind custom variants (browser engine, node bake, render CLI)
export const TAILWIND_CUSTOM_VARIANTS = [
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
];
export const TAILWIND_DARK_VARIANT = '@custom-variant dark (&:where(.dark, .dark *));';
export const AUTHOR_DARK_RE = /@custom-variant\s+dark[\s({]/;

// Engine entry CSS for a page with no author text/tailwindcss blocks (the bake's input; the browser engine's equivalent)
export const TAILWIND_ENGINE_INPUT = `@layer theme, base, components, utilities;\n@import "tailwindcss/theme" layer(theme);\n@import "tailwindcss/utilities" layer(utilities);\n${[...TAILWIND_CUSTOM_VARIANTS, TAILWIND_DARK_VARIANT].join('\n')}\n`;

// Seed: "<engine version>:<FNV-1a of the input and the bundled engine file's hash, base 36>"
export function tailwindSeed(version, input = TAILWIND_ENGINE_INPUT, engineHash = '') {
    if (typeof version !== 'string' || !version || typeof input !== 'string' || typeof engineHash !== 'string' || !engineHash) return null;
    const text = `${input}\u0000${engineHash}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
    return `${version}:${(h >>> 0).toString(36)}`;
}
