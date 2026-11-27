#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { glob } from 'glob';
import cssnano from 'cssnano';
import postcss from 'postcss';
import { inlineSubscript } from './build.subscript.mjs';
import { tailwindSeed, TAILWIND_ENGINE_INPUT } from './manifest.tailwind.variants.mjs';
import { createRequire } from 'module';

// Package version (stamped into the data bundle)
const BUILD_VERSION = JSON.parse(fs.readFileSync(path.join('..', 'package.json'), 'utf8')).version;

// --scripts-out <dir>: build only the script bundles into <dir>; src/, lib/, packages/ untouched
const scriptsOutArg = process.argv.indexOf('--scripts-out');
const SCRIPTS_OUT = scriptsOutArg > -1 ? path.resolve(process.argv[scriptsOutArg + 1] || '') : null;
if (SCRIPTS_OUT) {
    const repoRoot = path.resolve('..');
    if (!process.argv[scriptsOutArg + 1] || SCRIPTS_OUT === repoRoot || SCRIPTS_OUT.startsWith(repoRoot + path.sep)) {
        console.error('--scripts-out needs a directory outside the repo');
        process.exit(1);
    }
}
const MONOLITH_DIR = SCRIPTS_OUT || 'scripts';
const LIB_DIR = SCRIPTS_OUT || path.join('..', 'lib');

// Configuration
const CONFIG = {
    // Component subscripts order
    componentSubscripts: [
        'manifest.components.registry.js',
        'manifest.components.loader.js',
        'manifest.components.processor.js',
        'manifest.components.routing.js',
        'manifest.components.swapping.js',
        'manifest.components.mutation.js',
        'manifest.components.prefetch.js',
        'manifest.components.main.js'
    ],

    // Routing subscripts order
    routingSubscripts: [
        'manifest.router.main.js',
        'manifest.router.position.js',
        'manifest.router.navigation.js',
        'manifest.router.visibility.js',
        'manifest.router.head.js',
        'manifest.router.anchors.js',
        'manifest.router.magic.js'
    ],

    // Utilities subscripts order
    utilitiesSubscripts: [
        '../manifest.tailwind.variants.mjs',
        'manifest.utilities.generators.js',
        'manifest.utilities.variants.js',
        'manifest.utilities.main.js',
        'manifest.utilities.sync.js',
        'manifest.utilities.cache.js',
        'manifest.utilities.helpers.js',
        'manifest.utilities.compile.js',
        'manifest.utilities.static.js',
        'manifest.utilities.observation.js',
        'manifest.utilities.device.js',
        'manifest.utilities.tailwind-cache.js',
        'manifest.utilities.init.js'
    ],

    // DOM-free subset combined into manifest.utilities.node.mjs (Node/Workers,
    // no document): generation logic only, no DOM/localStorage subscripts.
    utilitiesNodeSubscripts: [
        '../manifest.tailwind.variants.mjs',
        'manifest.utilities.generators.js',
        'manifest.utilities.variants.js',
        'manifest.utilities.main.js',
        'manifest.utilities.helpers.js',
        'manifest.utilities.compile.js'
    ],

    // Auth subscripts order
    authSubscripts: [
        'manifest.appwrite.auth.config.js',
        'manifest.appwrite.auth.store.js',
        'manifest.appwrite.auth.main.js',
        'manifest.appwrite.auth.frontend.js',
        'manifest.appwrite.auth.teams.core.js',
        'manifest.appwrite.auth.teams.defaults.js',
        'manifest.appwrite.auth.teams.roles.defaults.js',
        'manifest.appwrite.auth.teams.roles.js',
        'manifest.appwrite.auth.teams.userRoles.js',
        'manifest.appwrite.auth.teams.members.js',
        'manifest.appwrite.auth.teams.callbacks.js',
        'manifest.appwrite.auth.teams.convenience.js',
        'manifest.appwrite.auth.users.anonymous.js',
        'manifest.appwrite.auth.users.magic.js',
        'manifest.appwrite.auth.users.otp.js',
        'manifest.appwrite.auth.users.phone.js',
        'manifest.appwrite.auth.users.oauth.js',
        'manifest.appwrite.auth.users.callbacks.js'
    ],

    // Data core subscripts (for manifest.data.js)
    // manifest.data.api.js: basic read-only API support needed for localization
    dataCoreSubscripts: [
        'core/manifest.data.config.js',
        'core/manifest.data.store.js',
        'core/manifest.data.persist.js', // Persisted $x: IndexedDB snapshots (§12.2)
        'core/manifest.data.loaders.js',
        'core/manifest.data.api.js',  // Basic read-only API support (for localization compatibility)
        'shared/manifest.data.mutations.js',         // Unified mutation system (optimistic updates)
        'shared/manifest.data.proxies.core.js',      // Basic proxy utilities
        'shared/manifest.data.proxies.cache.js',     // Cache management
        'shared/proxies/handlers/manifest.data.proxies.handlers.circular.js', // Circular reference handler
        'shared/proxies/creation/manifest.data.proxies.simple.js', // Simple object handler
        'shared/proxies/creation/manifest.data.proxies.helpers.js', // Helper functions (findItemByPath, etc.)
        'shared/proxies/creation/manifest.data.proxies.array.js',   // Array proxy creation
        'shared/proxies/creation/manifest.data.proxies.object.js', // Object proxy creation
        'shared/proxies/creation/manifest.data.proxies.route.js',  // Route proxy creation
        'shared/manifest.data.proxies.files.js',      // File management ($files, $upload helpers)
        'shared/manifest.data.proxies.routes.js',    // Route/proxy coordinator (exports)
        'shared/manifest.data.proxies.appwrite.js',  // Appwrite methods handler
        'shared/manifest.data.proxies.magic.state.js',     // Magic method state properties
        'shared/manifest.data.proxies.magic.files.js',    // Magic method $files handler
        'shared/manifest.data.proxies.magic.upload.js',   // Magic method $upload handler
        'shared/manifest.data.proxies.magic.pagination.js', // Magic method pagination handlers
        'shared/manifest.data.proxies.magic.core.js',     // Magic method core registration (delegates CRUD to Appwrite handler)
        'shared/manifest.data.main.js'                // Core main (Appwrite loading is conditional)
    ],

    // Data Appwrite subscripts (for manifest.appwrite.data.js)
    // Note: Does NOT include shared files - those are in core plugin
    // This plugin requires manifest.data.js to be loaded first
    dataAppwriteSubscripts: [
        'appwrite/manifest.data.appwrite.js',
        'appwrite/manifest.data.realtime.js',  // Included in Appwrite plugin (not separate)
        'appwrite/manifest.data.queries.js',
        'appwrite/manifest.data.pagination.js'
    ],

    // Payments subscripts order (provider-agnostic x-pay / $pay)
    paymentsSubscripts: [
        'manifest.payments.config.js',
        'manifest.payments.adapters.js',
        'manifest.payments.store.js',
        'manifest.payments.core.js',
        'manifest.payments.magic.js',
        'manifest.payments.directive.js',
        'manifest.payments.main.js'
    ],

    // Status subscripts order (signal layer — no UI)
    statusSubscripts: [
        'manifest.status.config.js',
        'manifest.status.store.js',
        'manifest.status.signals.js',
        'manifest.status.main.js'
    ],

    // Chat subscripts order ($chat — conversation projection over an adapter; no UI)
    chatSubscripts: [
        'manifest.chat.persist.js',
        'manifest.chat.store.js',
        'manifest.chat.adapters.js',
        'manifest.chat.adapters.llm.js',
        'manifest.chat.adapters.appwrite.js',
        'manifest.chat.main.js'
    ],

    // Edit subscripts order (x-edit / $edit — element editing). Fragments of one IIFE:
    // core.js opens it, main.js closes it; order matters.
    editSubscripts: [
        'manifest.edit.core.js',
        'manifest.edit.log.js',
        'manifest.edit.blocks.js',
        'manifest.edit.drag.js',
        'manifest.edit.size.js',
        'manifest.edit.text.js',
        'manifest.edit.style.js',
        'manifest.edit.theme.js',
        'manifest.edit.activation.js',
        'manifest.edit.ui.js',
        'manifest.edit.main.js'
    ],

    // Native umbrella subscripts order (opt-in; Capacitor as one adapter, web
    // fallbacks throughout). core.js first: it stamps $device + boots the magics.
    nativeSubscripts: [
        'manifest.native.core.js',
        'manifest.native.share.js',
        'manifest.native.network.js',
        'manifest.native.secure.js',
        'manifest.native.links.js',
        'manifest.native.push.js',
        'manifest.native.app.js',
        'manifest.native.haptics.js',
        'manifest.native.biometric.js',
        'manifest.native.camera.js'
    ],

    // Shared JS snippets, synced into each carrying plugin between the
    // snippet's own marker lines so every plugin stays standalone.
    // Source of truth: scripts/snippets/. A carrier under a subscript dir
    // (path with '/') is synced in place in src so the bundle build and the
    // vm-loaded tests read the same bytes.
    scriptSnippets: {
        'manifest.expressions.js': ['manifest.tooltips.js', 'manifest.toasts.js'],
        'manifest.realtime.hub.js': [
            'data/appwrite/manifest.data.realtime.js',
            'auth/manifest.appwrite.auth.config.js',
            'manifest.appwrite.presences.js'
        ],
        'manifest.vendor.js': [
            'manifest.markdown.js',
            'manifest.svg.js',
            'manifest.code.js',
            'manifest.charts.js',
            'manifest.export.js',
            'data/core/manifest.data.loaders.js',
            'payments/manifest.payments.adapters.js'
        ]
    },

    // Core plugins that should load first
    corePlugins: ['scripts/manifest.components.js'],

    // Files to ignore in rollup
    ignorePatterns: [
        'scripts/components/**',
        'scripts/router/**',
        'scripts/auth/**',
        'scripts/data/**',
        'scripts/status/**',
        'scripts/payments/**',
        'scripts/edit/**',
        'scripts/chat/**',
        'scripts/device/**',
        'scripts/snippets/**',

        'scripts/manifest.js',           // Dynamic loader (source)
        'scripts/manifest.render.mjs',   // CLI prerender source (not browser plugin)
        'scripts/manifest.render.page.mjs',
        'scripts/manifest.code.js',
        'scripts/manifest/slides.js',
        '**/tailwind.*.js',
    ],

    // Dependencies
    dependencies: {
        TAILWIND_V4_FILE: 'tailwind.v4.3.1.js',
    },

    // Stylesheet configuration
    stylesheets: {
        // Core files that need special handling
        coreFiles: ['manifest.reset.css'],

        // Files that need popover.css appended
        popoverDependent: ['manifest.dropdown.css', 'manifest.dialog.css', 'manifest.sidebar.css', 'manifest.tooltip.css', 'manifest.colorpicker.css', 'manifest.datepicker.css'],

        // Shared snippets appended to standalone copies (the bundle gets each
        // once, in buildMainStylesheet). Source of truth: styles/snippets/.
        snippetDependent: {
            'manifest.dropdown.css': ['manifest.alignment.css'],
            'manifest.tooltip.css': ['manifest.alignment.css']
        },

        // Snippets folded into the bundle, after the element files they serve
        bundleSnippets: ['manifest.alignment.css'],

        // Files that need group.css appended
        groupDependent: [],

        // Files to distribute as standalone (excluded from main manifest.css)
        standaloneFiles: ['manifest.theme.css', 'manifest.code.css'],

        // Files that should be minified
        minifyFiles: ['manifest.css', 'manifest.code.css'],

        // Files that should only be copied to docs (not starter template)
        docsOnlyFiles: ['manifest.code.css'],

        // Directories to process
        sourceDirs: ['styles/core', 'styles/elements', 'styles/utilities'],

        // Output directory — build artifacts are written straight to lib/ to
        // avoid emitting intermediate copies into src/styles/ that then get
        // re-copied. lib/ is the canonical home for everything users consume
        // (npm package + jsDelivr).
        outputDir: '../lib'
    }
};

// Build subscripts into monolith files
function buildSubscripts() {
    console.log('Building subscripts into monolith files...\n');

    // Build components
    combineSubscripts(CONFIG.componentSubscripts, 'manifest.components.js', 'components');

    // Build routing
    combineSubscripts(CONFIG.routingSubscripts, 'manifest.router.js', 'router');

    // Build utilities
    combineSubscripts(CONFIG.utilitiesSubscripts, 'manifest.utilities.js', 'utilities');
    buildUtilitiesNodeModule();

    // Build auth
    combineSubscripts(CONFIG.authSubscripts, 'manifest.appwrite.auth.js', 'auth');

    // Build data core
    combineSubscripts(CONFIG.dataCoreSubscripts, 'manifest.data.js', 'data');

    // Build Appwrite data
    combineSubscripts(CONFIG.dataAppwriteSubscripts, 'manifest.appwrite.data.js', 'data');

    // Build payments
    combineSubscripts(CONFIG.paymentsSubscripts, 'manifest.payments.js', 'payments');

    // Build status
    combineSubscripts(CONFIG.statusSubscripts, 'manifest.status.js', 'status');

    // Build chat
    combineSubscripts(CONFIG.chatSubscripts, 'manifest.chat.js', 'chat');

    // Build edit
    combineSubscripts(CONFIG.editSubscripts, 'manifest.edit.js', 'edit');

    // Build native umbrella
    combineSubscripts(CONFIG.nativeSubscripts, 'manifest.device.js', 'device');

    console.log('✓ Subscripts built successfully!\n');
}

// Sync shared JS snippets into the plugins that carry them
function syncScriptSnippets() {
    console.log('Syncing script snippets...');
    for (const [snippet, plugins] of Object.entries(CONFIG.scriptSnippets)) {
        const name = snippet.replace(/^manifest\.|\.js$/g, '');
        const startMarker = `// mnfst:${name}:start`;
        const endMarker = `// mnfst:${name}:end`;
        const body = fs.readFileSync(path.join('scripts/snippets', snippet), 'utf8').trim();
        if (!body.startsWith(startMarker) || !body.endsWith(endMarker)) {
            console.error(`  \u2716 ${snippet}: must open with ${startMarker} and close with ${endMarker}`);
            process.exit(1);
        }
        for (const plugin of plugins) {
            const sourcePath = path.join('scripts', plugin);
            const content = fs.readFileSync(sourcePath, 'utf8');
            const start = content.indexOf(startMarker);
            const end = start === -1 ? -1 : content.indexOf(endMarker, start);
            if (end === -1) {
                console.error(`  \u2716 ${plugin}: missing ${name} snippet markers`);
                process.exit(1);
            }
            const synced = content.slice(0, start) + body + content.slice(end + endMarker.length);
            // Subscript carriers sync in place (buildSubscripts then embeds the
            // fresh body); root-level plugins write to the output dir as before
            const isSubscript = plugin.includes('/');
            const outputPath = isSubscript ? sourcePath : path.join(MONOLITH_DIR, plugin);
            if (synced !== content || (SCRIPTS_OUT && !isSubscript)) fs.writeFileSync(outputPath, synced);
            console.log(`  \u2713 ${snippet} \u2192 ${plugin}`);
        }
    }
    console.log('');
}

// Build stylesheets
async function buildStylesheets() {
    console.log('Building stylesheets...\n');

    // Ensure lib/ exists — stylesheet output now writes there directly.
    const libDir = path.join('..', 'lib');
    if (!fs.existsSync(libDir)) {
        fs.mkdirSync(libDir, { recursive: true });
    }

    // Step 1: Build the main manifest.css file
    buildMainStylesheet();

    // Step 2: Minify CSS files
    await minifyCssFiles();

    // Step 3: Distribute standalone files
    distributeStandaloneFiles();

    // Step 4: Handle special popover-dependent files

    // Step 5: Handle special group-dependent files
    handleGroupDependentFiles();

    // Step 6: Sync derived files into all publishable packages
    //   - templates/starter   → packages/create-starter/templates/
    //   - src/scripts/manifest.render.mjs, manifest.render.page.mjs → packages/render/
    // Each package owns its own sync logic via scripts/sync-*.mjs and exposes
    // it as `npm run prepare:source`. Each also has a prepack hook as a safety
    // net for direct `npm publish`.
    syncPackage('create-starter', 'starter template');
    syncPackage('docs', 'docs template');
    syncPackage('render', 'render source');
    syncPackage('types', 'types template');

}


// Remove the inlined popover base when concatenating into manifest.css — the
// reset provides it there. Every copy must match styles/snippets/manifest.popover.css
// exactly, so the standalone stylesheets can never drift apart.
const POPOVER_START = '/* mnfst:popover-base:start';
const POPOVER_END = '/* mnfst:popover-base:end */';
let canonicalPopoverBase = null;

function stripPopoverBase(content, fileName) {
    const start = content.indexOf(POPOVER_START);
    if (start === -1) return content;
    const end = content.indexOf(POPOVER_END, start);
    if (end === -1) {
        console.error(`  \u2716 ${fileName}: popover-base start marker has no matching end`);
        process.exit(1);
    }
    if (canonicalPopoverBase === null) {
        const snippet = fs.readFileSync('styles/snippets/manifest.popover.css', 'utf8');
        canonicalPopoverBase = normalizeCss(snippet.split('*/').slice(1).join('*/'));
    }
    const block = content.slice(content.indexOf('*/', start) + 2, end);
    if (normalizeCss(block) !== canonicalPopoverBase) {
        console.error(`  \u2716 ${fileName}: popover base drifted from styles/snippets/manifest.popover.css`);
        process.exit(1);
    }
    return (content.slice(0, start) + content.slice(end + POPOVER_END.length)).trim();
}

function normalizeCss(css) {
    return css.replace(/\s+/g, ' ').trim();
}

// Build the main manifest.css file
function buildMainStylesheet() {
    console.log('Building main manifest.css...');

    const mainContent = [];

    // Add header comment
    mainContent.push('/*  Manifest CSS\n/*  By Andrew Matlock under MIT license\n/*  https://manifestx.dev\n/*  Modify referenced variables in manifest.theme.css\n*/');

    // Step 1: Add core files in order
    for (const coreFile of CONFIG.stylesheets.coreFiles) {
        const corePath = path.join('styles/core', coreFile);
        if (fs.existsSync(corePath)) {
            const content = fs.readFileSync(corePath, 'utf8').trim();
            mainContent.push(content);
            console.log(`  ✓ Added core: ${coreFile}`);
        }
    }

    // Step 2: Add elements files in alphabetical order (excluding standalone files)
    const elementFiles = glob.sync('styles/elements/*.css')
        .map(file => path.basename(file))
        .filter(file => !CONFIG.stylesheets.standaloneFiles.includes(file))
        .sort();

    for (const elementFile of elementFiles) {
        const elementPath = path.join('styles/elements', elementFile);
        let content = fs.readFileSync(elementPath, 'utf8').trim();

        // Popover-dependent stylesheets carry the popover base inline so they
        // work standalone; the bundle gets it once, from the reset.
        content = stripPopoverBase(content, elementFile);

        mainContent.push(content);
        console.log(`  ✓ Added element: ${elementFile}`);
    }

    // Step 3: Add shared element snippets once, after the files they serve
    // (standalone copies get the same content appended in copyFilesToDist).
    for (const snippet of CONFIG.stylesheets.bundleSnippets) {
        const snippetPath = path.join('styles/snippets', snippet);
        if (!fs.existsSync(snippetPath)) {
            console.warn(`  ⚠ Warning: ${snippet} not found, skipping`);
            continue;
        }
        mainContent.push(fs.readFileSync(snippetPath, 'utf8').trim());
        console.log(`  ✓ Added snippet: ${snippet}`);
    }

    // Step 4: Add utilities files in alphabetical order
    const utilityFiles = glob.sync('styles/utilities/*.css')
        .map(file => path.basename(file))
        .sort();

    for (const utilityFile of utilityFiles) {
        const utilityPath = path.join('styles/utilities', utilityFile);
        const content = fs.readFileSync(utilityPath, 'utf8').trim();
        mainContent.push(content);
        console.log(`  ✓ Added utility: ${utilityFile}`);
    }

    // Write the main stylesheet with single line breaks between files
    const outputPath = path.join(CONFIG.stylesheets.outputDir, 'manifest.css');
    fs.writeFileSync(outputPath, mainContent.join('\n\n'));
    console.log(`  ✓ Created manifest.css`);
    console.log('');
}

// Minify CSS files
async function minifyCssFiles() {
    console.log('Minifying CSS files...');

    for (const cssFile of CONFIG.stylesheets.minifyFiles) {
        await minifyCssFile(cssFile);
    }
}

// Minify a single CSS file
async function minifyCssFile(cssFileName) {
    console.log(`Minifying ${cssFileName}...`);

    // Determine source directory based on file
    let sourceDir = CONFIG.stylesheets.outputDir;
    if (cssFileName === 'manifest.code.css') {
        sourceDir = 'styles/elements';
    }

    const cssPath = path.join(sourceDir, cssFileName);

    if (!fs.existsSync(cssPath)) {
        console.warn(`  ⚠ Warning: ${cssFileName} not found, skipping minification`);
        return;
    }

    try {
        const cssContent = fs.readFileSync(cssPath, 'utf8');

        // Configure cssnano options - conservative settings for framework CSS
        const processor = postcss([
            cssnano({
                preset: ['default', {
                    // Safe optimizations that don't remove CSS
                    discardComments: {
                        removeAll: true,
                    },
                    normalizeWhitespace: true,
                    colormin: true,
                    convertValues: true,
                    mergeIdents: true,
                    mergeLonghand: true,
                    mergeRules: true,
                    minifyFontValues: true,
                    minifyGradients: true,
                    minifyParams: true,
                    minifySelectors: true,
                    normalizeCharset: true,
                    normalizeDisplayValues: true,
                    normalizePositions: true,
                    normalizeRepeatStyle: true,
                    normalizeString: true,
                    normalizeTimingFunctions: true,
                    normalizeUnicode: true,
                    normalizeUrl: true,
                    orderedValues: true,
                    reduceIdents: true,
                    reduceInitial: true,
                    reduceTransforms: true,
                    svgo: true,
                    uniqueSelectors: true,

                    // Disable potentially dangerous optimizations for framework CSS
                    discardDuplicates: false,    // Keep duplicates (might be intentional)
                    discardEmpty: false,         // Keep empty rules (might be placeholders)
                    discardOverridden: false,    // Keep overridden rules (might be needed for specificity)
                }]
            })
        ]);

        const result = await processor.process(cssContent, { from: cssPath });

        if (result.warnings && result.warnings.length > 0) {
            console.warn(`  ⚠ Warning: ${cssFileName} minification had warnings:`, result.warnings);
        }

        // Write the minified CSS
        const minifiedFileName = cssFileName.replace('.css', '.min.css');
        const minifiedPath = path.join(CONFIG.stylesheets.outputDir, minifiedFileName);
        fs.writeFileSync(minifiedPath, result.css);

        // Calculate compression ratio
        const originalSize = Buffer.byteLength(cssContent, 'utf8');
        const minifiedSize = Buffer.byteLength(result.css, 'utf8');
        const compressionRatio = ((originalSize - minifiedSize) / originalSize * 100).toFixed(1);

        console.log(`  ✓ Created ${minifiedFileName}`);
        console.log(`  ✓ Size: ${(originalSize / 1024).toFixed(1)}KB → ${(minifiedSize / 1024).toFixed(1)}KB (${compressionRatio}% reduction)`);
        console.log('');

    } catch (error) {
        console.error(`  ❌ Error minifying ${cssFileName}:`, error.message);
    }
}

// Strip base layer popover styles from content (used when compiling into main manifest.css)
// Run a package's own `prepare:source` script — each package owns the truth of
// what gets synced into it (templates, render source, etc.). Build orchestrates.
function syncPackage(packageName, label) {
    console.log(`Syncing ${label} to packages/${packageName}...`);
    try {
        const packageDir = path.join('..', 'packages', packageName);
        execSync('npm run prepare:source', { cwd: packageDir, stdio: 'inherit' });
        console.log(`  ✓ ${label} synced successfully`);
    } catch (error) {
        console.warn(`  ⚠ Warning: Failed to sync ${label}:`, error.message);
    }
    console.log('');
}

// Distribute standalone files
function distributeStandaloneFiles() {
    console.log('Distributing standalone files...');

    for (const standaloneFile of CONFIG.stylesheets.standaloneFiles) {
        // Determine source directory based on file
        let sourceDir = 'styles/elements';
        if (standaloneFile === 'manifest.theme.css') {
            sourceDir = 'styles/core';
        }

        const sourcePath = path.join(sourceDir, standaloneFile);

        if (!fs.existsSync(sourcePath)) {
            console.warn(`  ⚠ Warning: ${standaloneFile} not found, skipping distribution`);
            continue;
        }

        // Copy to output directory (lib/)
        const outputPath = path.join(CONFIG.stylesheets.outputDir, standaloneFile);
        fs.copyFileSync(sourcePath, outputPath);
        console.log(`  ✓ Copied ${standaloneFile} → ${outputPath}`);

        // Note: standalone .min.css siblings (e.g. manifest.code.min.css) are
        // produced by minifyCssFile() writing directly to outputDir; no extra
        // copy step needed here.
    }

    console.log('');
}

// Handle files that need group.css appended
function handleGroupDependentFiles() {
    console.log('Processing group-dependent files...');

    const groupPath = path.join('styles/snippets', 'group.css');
    if (!fs.existsSync(groupPath)) {
        console.warn('  ⚠ Warning: group.css not found, skipping dependent files');
        return;
    }

    const groupContent = fs.readFileSync(groupPath, 'utf8');

    // Add manifest.select.css to the list of group-dependent files
    const groupDependent = [...CONFIG.stylesheets.groupDependent, 'manifest.select.css'];

    for (const dependentFile of groupDependent) {
        const sourcePath = path.join('styles/elements', dependentFile);
        const outputPath = path.join(CONFIG.stylesheets.outputDir, dependentFile);

        if (fs.existsSync(sourcePath)) {
            const originalContent = fs.readFileSync(sourcePath, 'utf8');
            const combinedContent = originalContent + '\n\n' + groupContent;

            fs.writeFileSync(outputPath, combinedContent);
            console.log(`  ✓ Processed ${dependentFile} with group.css`);
        } else {
            console.warn(`  ⚠ Warning: ${dependentFile} not found`);
        }
    }
    console.log('');
}

function readSubscript(filePath) {
    return inlineSubscript(filePath, fs.readFileSync(filePath, 'utf8'));
}

// Combine subscripts into a single file
function combineSubscripts(subscriptFiles, outputFile, systemName) {
    console.log(`Building ${systemName} monolith...`);

    const combinedContent = [];
    const componentDir = path.join('scripts', systemName);

    // Combine all subscripts
    let filesFound = 0;
    for (const file of subscriptFiles) {
        const filePath = path.join(componentDir, file);
        if (fs.existsSync(filePath)) {
            const content = readSubscript(filePath);
            combinedContent.push(content);
            console.log(`  ✓ Added ${file}`);
            filesFound++;
        } else {
            console.warn(`  ⚠ Warning: ${file} not found`);
        }
    }

    // Only write the file if we found at least one subscript
    if (filesFound > 0) {
        const outputPath = path.join(MONOLITH_DIR, outputFile);
        // Wrap the combined bundle in an IIFE so subscript top-level declarations
        // stay out of window scope. Cross-plugin surface is explicit window.*
        // exports only; subscript sources stay bare for direct/vm loading.
        // Data bundle carries the package version (persisted $x invalidates on major/minor change)
        const stamp = systemName === 'data' ? `const MANIFEST_BUILD_VERSION = '${BUILD_VERSION}';\n\n` : '';
        const wrapped = `/* ${outputFile} — built from scripts/${systemName}/ */\n\n(function () {\n\n${stamp}${combinedContent.join('\n\n')}\n\n})();\n`;
        fs.writeFileSync(outputPath, wrapped);
        console.log(`  ✓ Created ${outputFile}`);
    } else {
        console.log(`  ⚠ No files found for ${systemName}, skipping ${outputFile}`);
    }
    console.log('');
}

// Combine the DOM-free utilities subscripts with the Node/Workers wrapper
// (scripts/utilities/manifest.utilities.node.mjs) into a single, dependency-free
// ES module. Same generator source as the browser bundle — never fork the logic.
// Installed only when absent — never overwrites a real DOM (browser/happy-dom).
// Insurance so the generation subscripts (shared verbatim with the browser
// build) stay callable in a bare Node/Workers runtime even if a future
// change adds a DOM read the compile path doesn't already avoid.
const DOM_SHIMS = `if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
if (typeof globalThis.document === 'undefined') {
    const inertElement = () => ({ style: {}, textContent: '', classList: { add(){}, remove(){}, contains: () => false }, setAttribute(){}, appendChild(){}, insertBefore(){} });
    globalThis.document = {
        documentElement: { outerHTML: '' },
        head: { firstChild: null, lastElementChild: null, innerHTML: '', appendChild(){}, insertBefore(){} },
        querySelectorAll: () => [],
        querySelector: () => null,
        getElementById: () => null,
        getElementsByTagName: () => [],
        createElement: inertElement,
        addEventListener(){},
        styleSheets: []
    };
}
if (typeof globalThis.getComputedStyle === 'undefined') globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
if (typeof globalThis.localStorage === 'undefined') globalThis.localStorage = { getItem: () => null, setItem(){}, removeItem(){} };
if (typeof globalThis.performance === 'undefined') globalThis.performance = { now: () => Date.now() };
if (typeof globalThis.requestAnimationFrame === 'undefined') globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
`;

function buildUtilitiesNodeModule() {
    console.log('Building utilities node module...\n');

    const componentDir = path.join('scripts', 'utilities');
    const wrapperPath = path.join(componentDir, 'manifest.utilities.node.mjs');
    if (!fs.existsSync(wrapperPath)) {
        console.warn('  ⚠ Warning: manifest.utilities.node.mjs wrapper not found, skipping\n');
        return;
    }

    const core = [];
    for (const file of CONFIG.utilitiesNodeSubscripts) {
        const filePath = path.join(componentDir, file);
        if (fs.existsSync(filePath)) {
            core.push(readSubscript(filePath));
            console.log(`  ✓ Added ${file}`);
        } else {
            console.warn(`  ⚠ Warning: ${file} not found`);
        }
    }

    const wrapper = fs.readFileSync(wrapperPath, 'utf8').replace("const TAILWIND_ENGINE_HASH = '';", `const TAILWIND_ENGINE_HASH = '${TAILWIND_ENGINE_HASH}';`);
    if (!wrapper.includes(`TAILWIND_ENGINE_HASH = '${TAILWIND_ENGINE_HASH}'`)) throw new Error('node module engine hash marker not found');
    const header = '/* manifest.utilities.node.mjs — built from scripts/utilities/ (DOM-free) */\n\n';
    const combined = `${header}${DOM_SHIMS}\n${core.join('\n\n')}\n\n${wrapper}`;

    const outputPath = path.join(MONOLITH_DIR, 'manifest.utilities.node.mjs');
    fs.writeFileSync(outputPath, combined);
    console.log('  ✓ Created manifest.utilities.node.mjs\n');
}

// Engine-skip gate lists, from the installed tailwindcss (pinned to the bundled engine's version) with Manifest's variants
async function engineGateLists() {
    const require = createRequire(import.meta.url);
    const tw = require('tailwindcss');
    const installed = require('tailwindcss/package.json').version;
    if (installed !== TAILWIND_ENGINE_VERSION) throw new Error(`tailwindcss ${installed} != bundled engine ${TAILWIND_ENGINE_VERSION}`);
    const themeCss = fs.readFileSync(require.resolve('tailwindcss/theme.css'), 'utf8');
    const utilitiesCss = fs.readFileSync(require.resolve('tailwindcss/utilities.css'), 'utf8');
    const ds = await tw.__unstable__loadDesignSystem(TAILWIND_ENGINE_INPUT, {
        base: '/',
        loadStylesheet: async (id) => ({ base: '/', content: id === 'tailwindcss/theme' ? themeCss : utilitiesCss })
    });
    const emits = (list) => ds.candidatesToCss(list).map(Boolean);
    const isBare = (c) => !/[-:[\/!.]/.test(c);

    // Every bare name the engine knows: listed bare classes plus the roots of listed ones (rounded from rounded-md)
    const roots = new Set();
    for (const [c] of ds.getClassList()) {
        if (isBare(c)) roots.add(c);
        const root = c.replace(/^-/, '').split('-')[0];
        if (root && isBare(root)) roots.add(root);
    }
    const rootList = [...roots];
    const rootEmits = emits(rootList);
    const bare = rootList.filter((c, i) => rootEmits[i]).sort();

    // Framework classes: selectors in lib/*.css and classes module sources write
    const names = new Set();
    const cssDir = path.join('..', 'lib');
    for (const f of fs.readdirSync(cssDir).filter(f => f.endsWith('.css') && !f.endsWith('.min.css'))) {
        const css = fs.readFileSync(path.join(cssDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
        for (const m of css.matchAll(/([^{};]+)\{/g)) {
            if (m[1].trim().startsWith('@')) continue;
            for (const c of m[1].matchAll(/\.((?:\\.|[\w-])+)/g)) names.add(c[1].replace(/\\(.)/g, '$1'));
        }
    }
    const addList = (text) => { for (const t of text.split(/\s+/)) if (t && !/[${}]/.test(t)) names.add(t); };
    const sources = glob.sync('scripts/**/*.js', { ignore: ['scripts/tailwind.*.js', 'scripts/**/*.min.js'] });
    for (const f of sources) {
        const js = fs.readFileSync(f, 'utf8');
        for (const m of js.matchAll(/classList\.(?:add|remove|toggle|replace|contains)\(([^)]*)\)/g)) {
            for (const q of m[1].matchAll(/(['"`])([^'"`]*)\1/g)) addList(q[2]);
        }
        for (const m of js.matchAll(/(?:className\s*\+?=\s*|setAttribute\(\s*['"]class['"]\s*,\s*)(['"`])([^'"`]*)\1/g)) addList(m[2]);
        for (const m of js.matchAll(/\bclass=\\?(["'])([^"'\\]*)\\?\1/g)) addList(m[2]);
    }
    const candidates = [...names].filter(c => !isBare(c) && /^[\w-][\w:-]*$/.test(c));
    const candidateEmits = emits(candidates);
    const framework = candidates.filter((c, i) => !candidateEmits[i]).sort();
    return { bare, framework };
}

async function stampEngineGateLists() {
    console.log('Stamping engine-skip gate lists...');
    const { bare, framework } = await engineGateLists();
    const file = path.join(MONOLITH_DIR, 'manifest.utilities.js');
    const text = fs.readFileSync(file, 'utf8');
    const stamped = text
        .replace('const TAILWIND_BARE_UTILITIES = new Set([]);', `const TAILWIND_BARE_UTILITIES = new Set(${JSON.stringify(bare)});`)
        .replace('const FRAMEWORK_CLASSES = new Set([]);', `const FRAMEWORK_CLASSES = new Set(${JSON.stringify(framework)});`);
    if (stamped === text || stamped.includes('new Set([]);')) throw new Error('engine gate list markers not found in manifest.utilities.js');
    fs.writeFileSync(file, stamped);
    console.log(`  ✓ ${bare.length} bare utilities, ${framework.length} framework classes\n`);
}

// Copy files to lib directory for clean jsdelivr URLs
function copyFilesToDist() {
    console.log('Copying files to lib directory...\n');

    // Create lib directory if it doesn't exist
    const distDir = LIB_DIR;
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }

    const filesToCopy = [
        // Main files
        { source: 'scripts/manifest.js', dest: '../lib/manifest.js' },  // Dynamic loader (source)
        { source: 'scripts/manifest.d.ts', dest: '../lib/manifest.d.ts' },  // Ambient type declarations
        { source: 'scripts/manifest.schema.json', dest: '../lib/manifest.schema.json' },  // manifest.json JSON Schema
        // Note: manifest.css, manifest.min.css, manifest.theme.css, manifest.code.css,
        // and manifest.code.min.css are written directly to ../lib/ by buildStylesheets()
        // — no intermediate copy in src/styles/ to forward from.

        // Individual plugin files
        { source: 'scripts/manifest.appwrite.auth.js', dest: '../lib/manifest.appwrite.auth.js' },
        { source: 'scripts/manifest.appwrite.data.js', dest: '../lib/manifest.appwrite.data.js' },
        { source: 'scripts/manifest.appwrite.presences.js', dest: '../lib/manifest.appwrite.presences.js' },
        { source: 'scripts/manifest.code.js', dest: '../lib/manifest.code.js' },
        { source: 'scripts/manifest.combobox.js', dest: '../lib/manifest.combobox.js' },
        { source: 'scripts/manifest.computed.js', dest: '../lib/manifest.computed.js' },
        { source: 'scripts/manifest.bindings.js', dest: '../lib/manifest.bindings.js' },
        { source: 'scripts/manifest.components.js', dest: '../lib/manifest.components.js' },
        { source: 'scripts/manifest.colorpicker.js', dest: '../lib/manifest.colorpicker.js' },
        { source: 'scripts/manifest.datepicker.js', dest: '../lib/manifest.datepicker.js' },
        { source: 'scripts/manifest.defer.js', dest: '../lib/manifest.defer.js' },
        { source: 'scripts/manifest.charts.js', dest: '../lib/manifest.charts.js' },
        { source: 'scripts/manifest.data.js', dest: '../lib/manifest.data.js' },
        { source: 'scripts/manifest.dropdowns.js', dest: '../lib/manifest.dropdowns.js' },
        { source: 'scripts/manifest.edit.js', dest: '../lib/manifest.edit.js' },
        { source: 'scripts/manifest.export.js', dest: '../lib/manifest.export.js' },
        { source: 'scripts/manifest.icons.js', dest: '../lib/manifest.icons.js' },
        { source: 'scripts/manifest.localization.js', dest: '../lib/manifest.localization.js' },
        { source: 'scripts/manifest.markdown.js', dest: '../lib/manifest.markdown.js' },
        { source: 'scripts/manifest.payments.js', dest: '../lib/manifest.payments.js' },
        { source: 'scripts/manifest.router.js', dest: '../lib/manifest.router.js' },
        { source: 'scripts/manifest.slides.js', dest: '../lib/manifest.slides.js' },
        { source: 'scripts/manifest.status.js', dest: '../lib/manifest.status.js' },
        { source: 'scripts/manifest.submissions.js', dest: '../lib/manifest.submissions.js' },
        { source: 'scripts/manifest.chat.js', dest: '../lib/manifest.chat.js' },
        { source: 'scripts/manifest.device.js', dest: '../lib/manifest.device.js' },
        { source: 'scripts/manifest.device.js', dest: '../lib/manifest.native.js' },   // alias kept for one release
        { source: 'scripts/manifest.svg.js', dest: '../lib/manifest.svg.js' },
        { source: 'scripts/manifest.sw.js', dest: '../lib/manifest.sw.js' },  // Service worker module (version-stamped below)
        { source: 'scripts/manifest.tabs.js', dest: '../lib/manifest.tabs.js' },
        { source: 'scripts/manifest.rich.text.js', dest: '../lib/manifest.rich.text.js' },
        { source: 'scripts/manifest.color.js', dest: '../lib/manifest.color.js' },
        { source: 'scripts/manifest.toasts.js', dest: '../lib/manifest.toasts.js' },
        { source: 'scripts/manifest.tooltips.js', dest: '../lib/manifest.tooltips.js' },
        { source: 'scripts/manifest.url.parameters.js', dest: '../lib/manifest.url.parameters.js' },
        { source: 'scripts/manifest.utilities.js', dest: '../lib/manifest.utilities.js' },
        { source: 'scripts/manifest.utilities.node.mjs', dest: '../lib/manifest.utilities.node.mjs' },
        { source: 'scripts/manifest.virtual.js', dest: '../lib/manifest.virtual.js' },

        // Tailwind bundle — loader requests `${base}/manifest.tailwind.min.js`
        // and jsDelivr auto-minifies, so we only need to ship the unminified
        // source under the canonical name. Source-of-truth is the versioned
        // file in src/scripts/ (CONFIG.dependencies.TAILWIND_V4_FILE).
        { source: `scripts/${CONFIG.dependencies.TAILWIND_V4_FILE}`, dest: '../lib/manifest.tailwind.js' },

        // Individual CSS files
        { source: 'styles/core/manifest.reset.css', dest: '../lib/manifest.reset.css' },
        { source: 'styles/elements/manifest.accordion.css', dest: '../lib/manifest.accordion.css' },
        { source: 'styles/elements/manifest.avatar.css', dest: '../lib/manifest.avatar.css' },
        { source: 'styles/elements/manifest.button.css', dest: '../lib/manifest.button.css' },
        { source: 'styles/elements/manifest.chart.css', dest: '../lib/manifest.chart.css' },
        { source: 'styles/elements/manifest.chat.css', dest: '../lib/manifest.chat.css' },
        { source: 'styles/elements/manifest.checkbox.css', dest: '../lib/manifest.checkbox.css' },
        { source: 'styles/elements/manifest.combobox.css', dest: '../lib/manifest.combobox.css' },
        { source: 'styles/elements/manifest.colorpicker.css', dest: '../lib/manifest.colorpicker.css' },
        { source: 'styles/elements/manifest.datepicker.css', dest: '../lib/manifest.datepicker.css' },
        { source: 'styles/elements/manifest.dialog.css', dest: '../lib/manifest.dialog.css' },
        { source: 'styles/elements/manifest.divider.css', dest: '../lib/manifest.divider.css' },
        { source: 'styles/elements/manifest.dropdown.css', dest: '../lib/manifest.dropdown.css' },
        { source: 'styles/elements/manifest.edit.css', dest: '../lib/manifest.edit.css' },
        { source: 'styles/elements/manifest.form.css', dest: '../lib/manifest.form.css' },
        { source: 'styles/elements/manifest.input.css', dest: '../lib/manifest.input.css' },
        { source: 'styles/elements/manifest.radio.css', dest: '../lib/manifest.radio.css' },
        { source: 'styles/elements/manifest.range.css', dest: '../lib/manifest.range.css' },
        { source: 'styles/elements/manifest.sidebar.css', dest: '../lib/manifest.sidebar.css' },
        { source: 'styles/elements/manifest.slides.css', dest: '../lib/manifest.slides.css' },
        { source: 'styles/elements/manifest.switch.css', dest: '../lib/manifest.switch.css' },
        { source: 'styles/elements/manifest.table.css', dest: '../lib/manifest.table.css' },
        { source: 'styles/elements/manifest.rich.text.css', dest: '../lib/manifest.rich.text.css' },
        { source: 'styles/elements/manifest.toast.css', dest: '../lib/manifest.toast.css' },
        { source: 'styles/elements/manifest.tooltip.css', dest: '../lib/manifest.tooltip.css' },
        { source: 'styles/elements/manifest.typography.css', dest: '../lib/manifest.typography.css' },
        { source: 'styles/utilities/manifest.utilities.css', dest: '../lib/manifest.utilities.css' },
        { source: 'styles/utilities/manifest.colors.css', dest: '../lib/manifest.colors.css' }
    ];

    // Popover-dependent standalone stylesheets get the shared popover base
    // prepended (single source: styles/snippets/manifest.popover.css; the
    // bundle carries it via the reset).
    let copiedCount = 0;
    const pkgVersion = JSON.parse(fs.readFileSync('../package.json', 'utf8')).version;
    for (const entry of filesToCopy) {
        const file = SCRIPTS_OUT ? scriptsOutEntry(entry) : entry;
        if (file.source === file.dest) { copiedCount++; continue; }
        if (fs.existsSync(file.source)) {
            const baseName = path.basename(file.source);
            // The worker keys its caches by its own version; stamp it at build.
            if (baseName === 'manifest.sw.js') {
                const src = fs.readFileSync(file.source, 'utf8');
                fs.writeFileSync(file.dest, src.replace("const BUILD_VERSION = '0.0.0-dev';", `const BUILD_VERSION = '${pkgVersion}';`));
                console.log(`  ✓ Copied ${file.source} → ${file.dest} (stamped ${pkgVersion})`);
                copiedCount++;
                continue;
            }
            const snippets = CONFIG.stylesheets.snippetDependent[baseName] || [];
            if (snippets.length) {
                const src = fs.readFileSync(file.source, 'utf8');
                const tail = snippets
                    .map(name => `\n${fs.readFileSync(path.join('styles/snippets', name), 'utf8')}`)
                    .join('');
                fs.writeFileSync(file.dest, `${src}${tail}`);
                const notes = snippets.join(', ');
                console.log(`  ✓ Copied ${file.source} → ${file.dest} (+${notes})`);
                copiedCount++;
                continue;
            }
            fs.copyFileSync(file.source, file.dest);
            console.log(`  ✓ Copied ${file.source} → ${file.dest}`);
            copiedCount++;
        } else {
            console.warn(`  ⚠ Warning: ${file.source} not found, skipping`);
        }
    }

    console.log(`\n✓ Copied ${copiedCount} file(s) to lib directory\n`);
}

// Redirect a lib copy into SCRIPTS_OUT, reading monoliths from there
function scriptsOutEntry({ source, dest }) {
    const built = path.join(SCRIPTS_OUT, path.basename(source));
    return {
        source: source.startsWith('scripts/') && fs.existsSync(built) ? built : source,
        dest: path.join(SCRIPTS_OUT, path.basename(dest))
    };
}

// Every browser script gets a shipped .min.js, so all CDN mirrors serve the same bytes (SRI)
const MIN_SKIP = new Set(['manifest.js']);
async function minifyScripts() {
    console.log('Minifying scripts...');
    const { minify } = await import('terser');
    const files = fs.readdirSync(LIB_DIR).filter(f => f.endsWith('.js') && !f.endsWith('.min.js') && !MIN_SKIP.has(f));
    for (const f of files) await minifyScript(f, minify);
    console.log(`  ✓ Minified ${files.length} file(s)\n`);
}
async function minifyScript(f, minify) {
    minify = minify || (await import('terser')).minify;
    const src = fs.readFileSync(path.join(LIB_DIR, f), 'utf8');
    const out = f.replace(/\.js$/, '.min.js');
    const { code, map } = await minify({ [f]: src }, { sourceMap: { filename: out, url: `${out}.map` } });
    fs.writeFileSync(path.join(LIB_DIR, out), code + '\n');
    fs.writeFileSync(path.join(LIB_DIR, `${out}.map`), map + '\n');
}

function sri(body) {
    return `sha384-${createHash('sha384').update(body).digest('base64')}`;
}

// Third-party files (scripts/vendor.lock.json, from npm tarballs via scripts/vendor-lock.mjs).
// Large families (grammars, locale packs) go in a second map, fetched only when one is needed.
const VENDOR_FAMILY = /\/(languages|langs)\//;
function vendorHashes() {
    const lock = JSON.parse(fs.readFileSync('scripts/vendor.lock.json', 'utf8'));
    const loaderSrc = fs.readFileSync('scripts/manifest.js', 'utf8');
    const alpine = loaderSrc.match(/const DEFAULT_ALPINE_VERSION = '([^']+)'/)?.[1];
    const alpineDir = path.join('..', 'node_modules', 'alpinejs');
    const installed = JSON.parse(fs.readFileSync(path.join(alpineDir, 'package.json'), 'utf8')).version;
    if (!alpine || installed !== alpine) throw new Error(`DEFAULT_ALPINE_VERSION ${alpine} != installed alpinejs ${installed}`);
    const key = `alpinejs@${alpine}/dist/cdn.min.js`;
    if (lock[key] !== sri(fs.readFileSync(path.join(alpineDir, 'dist', 'cdn.min.js')))) throw new Error(`${key} missing from vendor.lock.json or stale: run node scripts/vendor-lock.mjs`);
    const core = {}, family = {};
    for (const [k, v] of Object.entries(lock)) (VENDOR_FAMILY.test(k) ? family : core)[k] = v;
    return { core, family };
}

// Engine version, from the bundled engine's file name: part of the Tailwind output cache fingerprint
const TAILWIND_ENGINE_VERSION = (CONFIG.dependencies.TAILWIND_V4_FILE.match(/v(\d+\.\d+\.\d+)/) || [])[1];
if (!TAILWIND_ENGINE_VERSION) throw new Error('Tailwind engine version not found in TAILWIND_V4_FILE');
// Engine-skip seed: engine version, its input and the bundled engine file (with Manifest's patches); the node bake carries the same hash
const TAILWIND_ENGINE_HASH = createHash('sha256').update(fs.readFileSync(path.join('scripts', CONFIG.dependencies.TAILWIND_V4_FILE))).digest('hex').slice(0, 16);
const TAILWIND_SEED = tailwindSeed(TAILWIND_ENGINE_VERSION, undefined, TAILWIND_ENGINE_HASH);

// manifest.modules.integrity.json: what the loader injects; its hash and the version are stamped
// into the loader. manifest.integrity.json: every browser file, loader included.
async function emitIntegrity() {
    console.log('Emitting SRI integrity maps...');
    const lib = LIB_DIR;
    const read = f => fs.readFileSync(path.join(lib, f));
    const scripts = fs.readdirSync(lib).filter(f => f.endsWith('.js') && f !== 'manifest.js' && f !== 'manifest.min.js').sort();
    const modules = {};
    for (const f of scripts) modules[f] = sri(read(f));
    const vendor = vendorHashes();
    const familyJson = JSON.stringify(vendor.family, null, 2) + '\n';
    fs.writeFileSync(path.join(lib, 'manifest.vendor.integrity.json'), familyJson);
    Object.assign(modules, vendor.core, { 'manifest.vendor.integrity.json': sri(familyJson) });
    const modulesJson = JSON.stringify(modules, null, 2) + '\n';
    fs.writeFileSync(path.join(lib, 'manifest.modules.integrity.json'), modulesJson);

    const loaderPath = path.join(lib, 'manifest.js');
    const loader = fs.readFileSync(loaderPath, 'utf8');
    const stamped = loader
        .replace("const LOADER_VERSION = '0.0.0-dev';", `const LOADER_VERSION = '${BUILD_VERSION}';`)
        .replace("const MODULES_INTEGRITY = '';", `const MODULES_INTEGRITY = '${sri(modulesJson)}';`)
        .replace("const TAILWIND_ENGINE_VERSION = '';", `const TAILWIND_ENGINE_VERSION = '${TAILWIND_ENGINE_VERSION}';`)
        .replace("const TAILWIND_SEED = '';", `const TAILWIND_SEED = '${TAILWIND_SEED}';`);
    if (stamped === loader || !stamped.includes(sri(modulesJson)) || !stamped.includes(`TAILWIND_ENGINE_VERSION = '${TAILWIND_ENGINE_VERSION}'`) || !stamped.includes(`TAILWIND_SEED = '${TAILWIND_SEED}'`)) throw new Error('loader integrity stamp markers not found');
    fs.writeFileSync(loaderPath, stamped);
    await minifyScript('manifest.js');

    const all = {};
    for (const f of fs.readdirSync(lib).filter(f => /\.(js|css)$/.test(f) || /^manifest\.(modules|vendor)\.integrity\.json$/.test(f)).sort()) all[f] = sri(read(f));
    fs.writeFileSync(path.join(lib, 'manifest.integrity.json'), JSON.stringify(all, null, 2) + '\n');
    console.log(`  ✓ Wrote manifest.modules.integrity.json, manifest.vendor.integrity.json, manifest.integrity.json`);
    console.log(`\n  Loader integrity (for <script integrity=> on user HTML):`);
    console.log(`    manifest.js      ${all['manifest.js']}`);
    console.log(`    manifest.min.js  ${all['manifest.min.js']}\n`);
}

// Main build function
async function build() {
    console.log('🚀 Starting Manifest build process...\n');

    try {
        // Step 1: Sync shared snippets (subscript carriers in place), then build subscripts
        if (SCRIPTS_OUT) fs.mkdirSync(SCRIPTS_OUT, { recursive: true });
        syncScriptSnippets();
        buildSubscripts();

        // Step 2: Build stylesheets
        if (!SCRIPTS_OUT) await buildStylesheets();

        // Step 3: Engine-skip gate lists (after the stylesheets they read)
        await stampEngineGateLists();

        // Step 4: Copy files to lib directory
        copyFilesToDist();

        // Step 5: Minify scripts, emit SRI maps, stamp the loader
        await minifyScripts();
        await emitIntegrity();

        console.log('✅ Build process completed successfully!');

    } catch (error) {
        console.error('❌ Build failed:', error.message);
        process.exit(1);
    }
}

// Run the build
build();
