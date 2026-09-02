#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { glob } from 'glob';
import cssnano from 'cssnano';
import postcss from 'postcss';

// Package version (stamped into the data bundle)
const BUILD_VERSION = JSON.parse(fs.readFileSync(path.join('..', 'package.json'), 'utf8')).version;

// Configuration
const CONFIG = {
    // Component subscripts order
    componentSubscripts: [
        'manifest.components.registry.js',
        'manifest.components.loader.js',
        'manifest.components.processor.js',
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
        'manifest.utilities.generators.js',
        'manifest.utilities.variants.js',
        'manifest.utilities.main.js',
        'manifest.utilities.sync.js',
        'manifest.utilities.cache.js',
        'manifest.utilities.helpers.js',
        'manifest.utilities.compile.js',
        'manifest.utilities.observation.js',
        'manifest.utilities.device.js',
        'manifest.utilities.init.js'
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
        'shared/manifest.data.proxies.directives.js', // Directives
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
        'scripts/native/**',

        'scripts/manifest.js',           // Dynamic loader (source)
        'scripts/manifest.render.mjs',   // CLI prerender source (not browser plugin)
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
    combineSubscripts(CONFIG.nativeSubscripts, 'manifest.native.js', 'native');

    console.log('✓ Subscripts built successfully!\n');
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
    //   - src/scripts/manifest.render.mjs → packages/render/manifest.render.mjs
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
            const content = fs.readFileSync(filePath, 'utf8');
            combinedContent.push(content);
            console.log(`  ✓ Added ${file}`);
            filesFound++;
        } else {
            console.warn(`  ⚠ Warning: ${file} not found`);
        }
    }

    // Only write the file if we found at least one subscript
    if (filesFound > 0) {
        const outputPath = path.join('scripts', outputFile);
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

// Copy files to lib directory for clean jsdelivr URLs
function copyFilesToDist() {
    console.log('Copying files to lib directory...\n');

    // Create lib directory if it doesn't exist
    const distDir = path.join('..', 'lib');
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
        { source: 'scripts/manifest.resize.js', dest: '../lib/manifest.resize.js' },
        { source: 'scripts/manifest.router.js', dest: '../lib/manifest.router.js' },
        { source: 'scripts/manifest.slides.js', dest: '../lib/manifest.slides.js' },
        { source: 'scripts/manifest.status.js', dest: '../lib/manifest.status.js' },
        { source: 'scripts/manifest.chat.js', dest: '../lib/manifest.chat.js' },
        { source: 'scripts/manifest.native.js', dest: '../lib/manifest.native.js' },
        { source: 'scripts/manifest.svg.js', dest: '../lib/manifest.svg.js' },
        { source: 'scripts/manifest.tabs.js', dest: '../lib/manifest.tabs.js' },
        { source: 'scripts/manifest.text.edit.js', dest: '../lib/manifest.text.edit.js' },
        { source: 'scripts/manifest.color.js', dest: '../lib/manifest.color.js' },
        { source: 'scripts/manifest.toasts.js', dest: '../lib/manifest.toasts.js' },
        { source: 'scripts/manifest.tooltips.js', dest: '../lib/manifest.tooltips.js' },
        { source: 'scripts/manifest.url.parameters.js', dest: '../lib/manifest.url.parameters.js' },
        { source: 'scripts/manifest.utilities.js', dest: '../lib/manifest.utilities.js' },
        { source: 'scripts/manifest.virtual.js', dest: '../lib/manifest.virtual.js' },

        // Tailwind bundle — loader requests `${base}/manifest.tailwind.min.js`
        // and jsDelivr auto-minifies, so we only need to ship the unminified
        // source under the canonical name. Source-of-truth is the versioned
        // file in src/scripts/ (CONFIG.dependencies.TAILWIND_V4_FILE).
        { source: `scripts/${CONFIG.dependencies.TAILWIND_V4_FILE}`, dest: '../lib/manifest.tailwind.js' },

        // Individual CSS files
        { source: 'styles/elements/manifest.accordion.css', dest: '../lib/manifest.accordion.css' },
        { source: 'styles/elements/manifest.avatar.css', dest: '../lib/manifest.avatar.css' },
        { source: 'styles/elements/manifest.button.css', dest: '../lib/manifest.button.css' },
        { source: 'styles/elements/manifest.chart.css', dest: '../lib/manifest.chart.css' },
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
        { source: 'styles/elements/manifest.resize.css', dest: '../lib/manifest.resize.css' },
        { source: 'styles/elements/manifest.sidebar.css', dest: '../lib/manifest.sidebar.css' },
        { source: 'styles/elements/manifest.slides.css', dest: '../lib/manifest.slides.css' },
        { source: 'styles/elements/manifest.switch.css', dest: '../lib/manifest.switch.css' },
        { source: 'styles/elements/manifest.table.css', dest: '../lib/manifest.table.css' },
        { source: 'styles/elements/manifest.text.edit.css', dest: '../lib/manifest.text.edit.css' },
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
    for (const file of filesToCopy) {
        if (fs.existsSync(file.source)) {
            const baseName = path.basename(file.source);
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

// Compute SHA-384 of every plugin file in lib/ and write lib/manifest.integrity.json.
// Covers the self-host path only (loader serves unminified `.js`, matching these hashes).
// The default CDN path loads jsDelivr-auto-minified `.min.js`, whose bytes differ from the
// shipped `.js`, so those can't be SRI-pinned from a build-time hash.
function emitIntegrityMap() {
    console.log('Emitting SRI integrity map...');

    const libDir = path.join('..', 'lib');
    const files = fs.readdirSync(libDir).filter(f =>
        (f.endsWith('.js') || f.endsWith('.min.js')) && f !== 'manifest.js'
    );

    function hashFile(filePath) {
        const body = fs.readFileSync(filePath);
        const digest = createHash('sha384').update(body).digest('base64');
        return `sha384-${digest}`;
    }

    const integrity = {};
    for (const f of files) {
        integrity[f] = hashFile(path.join(libDir, f));
    }

    // Hash the loader itself so self-hosters can SRI-pin the loader <script> tag too.
    const loaderPath = path.join(libDir, 'manifest.js');
    integrity['manifest.js'] = hashFile(loaderPath);

    const mapPath = path.join(libDir, 'manifest.integrity.json');
    fs.writeFileSync(mapPath, JSON.stringify(integrity, null, 2) + '\n');
    console.log(`  ✓ Wrote ${mapPath}`);
    console.log(`\n  Loader integrity (for <script integrity=> on user HTML):`);
    console.log(`    ${integrity['manifest.js']}\n`);
}

// Main build function
async function build() {
    console.log('🚀 Starting Manifest build process...\n');

    try {
        // Step 1: Build subscripts
        buildSubscripts();

        // Step 2: Build stylesheets
        await buildStylesheets();

        // Step 4: Copy files to lib directory
        copyFilesToDist();

        // Step 5: Emit SRI integrity map + inline into loader
        emitIntegrityMap();

        console.log('✅ Build process completed successfully!');

    } catch (error) {
        console.error('❌ Build failed:', error.message);
        process.exit(1);
    }
}

// Run the build
build();
