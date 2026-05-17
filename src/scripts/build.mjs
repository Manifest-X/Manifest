#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { glob } from 'glob';
import cssnano from 'cssnano';
import postcss from 'postcss';

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
        'manifest.appwrite.auth.users.oauth.js',
        'manifest.appwrite.auth.users.callbacks.js'
    ],

    // Data core subscripts (for manifest.data.js)
    // NOTE: manifest.data.api.js provides basic read-only API support needed for localization.
    // Full CRUD operations will be available via manifest.api.data.js plugin (planned).
    dataCoreSubscripts: [
        'core/manifest.data.config.js',
        'core/manifest.data.store.js',
        'core/manifest.data.loaders.js',
        'core/manifest.data.api.js',  // Basic read-only API support (for localization compatibility)
        'core/manifest.data.errors.js',
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

    // Data Appwrite presence subscripts (for manifest.appwrite.presence.js)
    dataAppwritePresenceSubscripts: [
        'presence/manifest.data.presence.utils.js',
        'presence/manifest.data.presence.elements.js',
        'presence/manifest.data.presence.events.js',
        'presence/manifest.data.presence.database.js',
        'presence/manifest.data.presence.realtime.js',
        'presence/manifest.data.presence.visual.js',
        'presence/manifest.data.presence.main.js'
    ],

    // Core plugins that should load first
    corePlugins: ['scripts/manifest.components.js'],

    // Files to ignore in rollup
    ignorePatterns: [
        'scripts/components/**',
        'scripts/router/**',
        'scripts/auth/**',
        'scripts/data/**',

        'scripts/manifest.js',           // Dynamic loader (source)
        'scripts/manifest.render.mjs',   // CLI prerender source (not browser plugin)
        'scripts/manifest.code.js',
        'scripts/manifest/slides.js',
        '**/tailwind.*.js',
        'scripts/rollup.js',
        'scripts/rollup.alpine.tailwind.js',
        'scripts/rollup.alpine.tailwind.temp.js',
    ],

    // Dependencies
    dependencies: {
        TAILWIND_V4_FILE: 'tailwind.v4.1.js',
    },

    // Stylesheet configuration
    stylesheets: {
        // Core files that need special handling
        coreFiles: ['manifest.reset.css'],

        // Files that need popover.css appended
        popoverDependent: ['manifest.dropdown.css', 'manifest.dialog.css', 'manifest.sidebar.css', 'manifest.tooltip.css'],

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

        // Output directory
        outputDir: 'styles'
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

    // Build Appwrite presence
    combineSubscripts(CONFIG.dataAppwritePresenceSubscripts, 'manifest.appwrite.presence.js', 'data');

    console.log('✓ Subscripts built successfully!\n');
}

// Copy compiled scripts to docs/temp-scripts
function copyScriptsToDocs() {
    console.log('Copying compiled scripts to docs/temp-scripts...\n');

    // Ensure docs/temp-scripts directory exists
    const docsTempScriptsDir = path.join('..', 'docs', 'temp-scripts');
    if (!fs.existsSync(docsTempScriptsDir)) {
        fs.mkdirSync(docsTempScriptsDir, { recursive: true });
    }

    // List of compiled scripts to copy
    const scriptsToCopy = [
        'manifest.code.js',
        'manifest.colorpicker.js',
        'manifest.components.js',
        'manifest.data.js',
        'manifest.dropdowns.js',
        'manifest.icons.js',
        'manifest.localization.js',
        'manifest.markdown.js',
        'manifest.resize.js',
        'manifest.router.js',
        'manifest.svg.js',
        'manifest.tabs.js',
        'manifest.color.js',
        'manifest.toasts.js',
        'manifest.tooltips.js',
        'manifest.url.parameters.js',
        'manifest.utilities.js',
        'manifest.appwrite.auth.js',
        'manifest.appwrite.data.js',
        'manifest.appwrite.presence.js'
    ];

    let copiedCount = 0;
    for (const script of scriptsToCopy) {
        const sourcePath = path.join('scripts', script);
        const destPath = path.join(docsTempScriptsDir, script);

        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`  ✓ Copied ${script}`);
            copiedCount++;
        } else {
            console.warn(`  ⚠ Warning: ${script} not found, skipping`);
        }
    }

    console.log(`\n✓ Copied ${copiedCount} script(s) to docs/temp-scripts\n`);
}

// Build stylesheets
async function buildStylesheets() {
    console.log('Building stylesheets...\n');

    // Step 1: Build the main manifest.css file
    buildMainStylesheet();

    // Step 2: Minify CSS files
    await minifyCssFiles();

    // Step 3: Distribute standalone files
    distributeStandaloneFiles();

    // Step 4: Handle special popover-dependent files
    handlePopoverDependentFiles();

    // Step 5: Handle special group-dependent files
    handleGroupDependentFiles();

    // Step 6: Sync derived files into all publishable packages
    //   - templates/starter   → packages/create-starter/templates/
    //   - src/scripts/manifest.render.mjs → packages/render/manifest.render.mjs
    // Each package owns its own sync logic via scripts/sync-*.mjs and exposes
    // it as `npm run prepare:source`. Each also has a prepack hook as a safety
    // net for direct `npm publish`.
    syncPackage('create-starter', 'starter template');
    syncPackage('render', 'render source');
    syncPackage('types', 'types template');

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

        // Strip base layer popover styles from popover-dependent files when compiling into main manifest.css
        if (CONFIG.stylesheets.popoverDependent.includes(elementFile)) {
            content = stripBaseLayerPopoverStyles(content);
        }

        mainContent.push(content);
        console.log(`  ✓ Added element: ${elementFile}`);
    }

    // Step 3: Add utilities files in alphabetical order
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
function stripBaseLayerPopoverStyles(content) {
    // Remove the base layer popover styles that are already included in manifest.reset.css
    // This function finds @layer base blocks that contain :where([popover]) and removes them

    const lines = content.split('\n');
    const result = [];
    let inBaseLayer = false;
    let braceCount = 0;
    let foundPopover = false;
    let baseLayerStart = -1;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check if this line contains @layer base
        if (line.includes('@layer base')) {
            inBaseLayer = true;
            braceCount = 0;
            foundPopover = false;
            baseLayerStart = i;
        }

        if (inBaseLayer) {
            // Count braces to track nesting
            for (const char of line) {
                if (char === '{') braceCount++;
                if (char === '}') braceCount--;
            }

            // Check if this line contains :where([popover])
            if (line.includes(':where([popover])')) {
                foundPopover = true;
            }

            // If we've closed all braces and found popover styles, skip this block
            if (braceCount === 0 && foundPopover) {
                inBaseLayer = false;
                foundPopover = false;
                baseLayerStart = -1;
                continue; // Skip adding this line
            }

            // If we've closed all braces but didn't find popover styles, add the block
            if (braceCount === 0 && !foundPopover) {
                // Add all lines from baseLayerStart to current line
                for (let j = baseLayerStart; j <= i; j++) {
                    result.push(lines[j]);
                }
                inBaseLayer = false;
                foundPopover = false;
                baseLayerStart = -1;
                continue;
            }

            // If we're still inside the block, continue without adding
            if (braceCount > 0) {
                continue;
            }
        }

        // Add line if we're not in a base layer block
        if (!inBaseLayer) {
            result.push(line);
        }
    }

    // Clean up extra blank lines that might have been left after removing @layer base blocks
    const cleanedResult = [];
    for (let i = 0; i < result.length; i++) {
        const line = result[i];
        const nextLine = result[i + 1];
        const prevLine = result[i - 1];

        // Skip blank lines that are followed by another blank line
        if (line.trim() === '' && nextLine && nextLine.trim() === '') {
            continue;
        }

        // Skip blank lines that are at the start of a file
        if (line.trim() === '' && cleanedResult.length === 0) {
            continue;
        }

        // Skip blank lines that come right after a comment (like /* Dropdowns */)
        if (line.trim() === '' && prevLine && prevLine.trim().startsWith('/*') && prevLine.trim().endsWith('*/')) {
            continue;
        }

        cleanedResult.push(line);
    }

    return cleanedResult.join('\n');
}

// Handle files that need popover.css appended
function handlePopoverDependentFiles() {
    console.log('Processing popover-dependent files...');
    console.log('  ✓ Popover-dependent files are handled in main manifest.css build');
    console.log('  ✓ Individual files available in styles/elements/ for standalone use');
    console.log('');
}

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

        // Copy to main styles directory
        const outputPath = path.join(CONFIG.stylesheets.outputDir, standaloneFile);
        fs.copyFileSync(sourcePath, outputPath);
        console.log(`  ✓ Copied ${standaloneFile} to styles/`);

        // Copy minified version if it exists
        const minifiedFile = standaloneFile.replace('.css', '.min.css');
        const minifiedSourcePath = path.join(CONFIG.stylesheets.outputDir, minifiedFile);
        if (fs.existsSync(minifiedSourcePath)) {
            const minifiedOutputPath = path.join(CONFIG.stylesheets.outputDir, minifiedFile);
            fs.copyFileSync(minifiedSourcePath, minifiedOutputPath);
            console.log(`  ✓ Copied ${minifiedFile} to styles/`);
        }

        // Note: Files are no longer copied to docs or templates/starter
        // These directories now maintain their own local file versions
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
        fs.writeFileSync(outputPath, combinedContent.join('\n\n'));
        console.log(`  ✓ Created ${outputFile}`);
    } else {
        console.log(`  ⚠ No files found for ${systemName}, skipping ${outputFile}`);
    }
    console.log('');
}

// Build rollup entry files (no longer needed - keeping function stub for potential future use)
function buildRollupFiles() {
    console.log('Skipping rollup build - using dynamic loader (manifest.js) instead\n');
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
        { source: 'styles/manifest.css', dest: '../lib/manifest.css' },
        { source: 'styles/manifest.min.css', dest: '../lib/manifest.min.css' },
        { source: 'styles/manifest.theme.css', dest: '../lib/manifest.theme.css' },
        { source: 'styles/manifest.code.css', dest: '../lib/manifest.code.css' },
        { source: 'styles/manifest.code.min.css', dest: '../lib/manifest.code.min.css' },

        // Individual plugin files
        { source: 'scripts/manifest.appwrite.auth.js', dest: '../lib/manifest.appwrite.auth.js' },
        { source: 'scripts/manifest.appwrite.data.js', dest: '../lib/manifest.appwrite.data.js' },
        { source: 'scripts/manifest.appwrite.presence.js', dest: '../lib/manifest.appwrite.presence.js' },
        { source: 'scripts/manifest.code.js', dest: '../lib/manifest.code.js' },
        { source: 'scripts/manifest.components.js', dest: '../lib/manifest.components.js' },
        { source: 'scripts/manifest.colorpicker.js', dest: '../lib/manifest.colorpicker.js' },
        { source: 'scripts/manifest.data.js', dest: '../lib/manifest.data.js' },
        { source: 'scripts/manifest.dropdowns.js', dest: '../lib/manifest.dropdowns.js' },
        { source: 'scripts/manifest.icons.js', dest: '../lib/manifest.icons.js' },
        { source: 'scripts/manifest.localization.js', dest: '../lib/manifest.localization.js' },
        { source: 'scripts/manifest.markdown.js', dest: '../lib/manifest.markdown.js' },
        { source: 'scripts/manifest.resize.js', dest: '../lib/manifest.resize.js' },
        { source: 'scripts/manifest.router.js', dest: '../lib/manifest.router.js' },
        { source: 'scripts/manifest.slides.js', dest: '../lib/manifest.slides.js' },
        { source: 'scripts/manifest.svg.js', dest: '../lib/manifest.svg.js' },
        { source: 'scripts/manifest.tabs.js', dest: '../lib/manifest.tabs.js' },
        { source: 'scripts/manifest.color.js', dest: '../lib/manifest.color.js' },
        { source: 'scripts/manifest.toasts.js', dest: '../lib/manifest.toasts.js' },
        { source: 'scripts/manifest.tooltips.js', dest: '../lib/manifest.tooltips.js' },
        { source: 'scripts/manifest.url.parameters.js', dest: '../lib/manifest.url.parameters.js' },
        { source: 'scripts/manifest.utilities.js', dest: '../lib/manifest.utilities.js' },
        { source: 'scripts/manifest.virtual.js', dest: '../lib/manifest.virtual.js' },
        { source: 'scripts/manifest.export.js', dest: '../lib/manifest.export.js' },

        // Individual CSS files
        { source: 'styles/elements/manifest.accordion.css', dest: '../lib/manifest.accordion.css' },
        { source: 'styles/elements/manifest.avatar.css', dest: '../lib/manifest.avatar.css' },
        { source: 'styles/elements/manifest.button.css', dest: '../lib/manifest.button.css' },
        { source: 'styles/elements/manifest.checkbox.css', dest: '../lib/manifest.checkbox.css' },
        { source: 'styles/elements/manifest.colorpicker.css', dest: '../lib/manifest.colorpicker.css' },
        { source: 'styles/elements/manifest.dialog.css', dest: '../lib/manifest.dialog.css' },
        { source: 'styles/elements/manifest.divider.css', dest: '../lib/manifest.divider.css' },
        { source: 'styles/elements/manifest.dropdown.css', dest: '../lib/manifest.dropdown.css' },
        { source: 'styles/elements/manifest.form.css', dest: '../lib/manifest.form.css' },
        { source: 'styles/elements/manifest.input.css', dest: '../lib/manifest.input.css' },
        { source: 'styles/elements/manifest.radio.css', dest: '../lib/manifest.radio.css' },
        { source: 'styles/elements/manifest.range.css', dest: '../lib/manifest.range.css' },
        { source: 'styles/elements/manifest.resize.css', dest: '../lib/manifest.resize.css' },
        { source: 'styles/elements/manifest.sidebar.css', dest: '../lib/manifest.sidebar.css' },
        { source: 'styles/elements/manifest.slides.css', dest: '../lib/manifest.slides.css' },
        { source: 'styles/elements/manifest.switch.css', dest: '../lib/manifest.switch.css' },
        { source: 'styles/elements/manifest.table.css', dest: '../lib/manifest.table.css' },
        { source: 'styles/elements/manifest.toast.css', dest: '../lib/manifest.toast.css' },
        { source: 'styles/elements/manifest.tooltip.css', dest: '../lib/manifest.tooltip.css' },
        { source: 'styles/elements/manifest.typography.css', dest: '../lib/manifest.typography.css' },
        { source: 'styles/utilities/manifest.utilities.css', dest: '../lib/manifest.utilities.css' }
    ];

    let copiedCount = 0;
    for (const file of filesToCopy) {
        if (fs.existsSync(file.source)) {
            fs.copyFileSync(file.source, file.dest);
            console.log(`  ✓ Copied ${file.source} → ${file.dest}`);
            copiedCount++;
        } else {
            console.warn(`  ⚠ Warning: ${file.source} not found, skipping`);
        }
    }

    console.log(`\n✓ Copied ${copiedCount} file(s) to lib directory\n`);
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

        console.log('✅ Build process completed successfully!');

    } catch (error) {
        console.error('❌ Build failed:', error.message);
        process.exit(1);
    }
}

// Copy specific files to docs directory
function copyToDocs() {
    console.log('Copying files to docs...');

    // Ensure docs directories exist
    const docsScriptsDir = path.join('..', 'docs', 'scripts');
    const docsStylesDir = path.join('..', 'docs', 'styles');

    if (!fs.existsSync(docsScriptsDir)) {
        fs.mkdirSync(docsScriptsDir, { recursive: true });
    }
    if (!fs.existsSync(docsStylesDir)) {
        fs.mkdirSync(docsStylesDir, { recursive: true });
    }

    // Copy manifest.css to docs/styles
    const cssSource = path.join('styles', 'manifest.css');
    const cssMinSource = path.join('styles', 'manifest.min.css');
    const cssDest = path.join(docsStylesDir, 'manifest.css');
    const cssMinDest = path.join(docsStylesDir, 'manifest.min.css');

    if (fs.existsSync(cssSource)) {
        fs.copyFileSync(cssSource, cssDest);
        console.log('  ✓ Copied manifest.css to docs/styles');
    } else {
        console.warn('  ⚠ Warning: manifest.css not found');
    }

    if (fs.existsSync(cssMinSource)) {
        fs.copyFileSync(cssMinSource, cssMinDest);
        console.log('  ✓ Copied manifest.min.css to docs/styles');
    } else {
        console.warn('  ⚠ Warning: manifest.min.css not found');
    }

    // Copy standalone files to docs/styles
    for (const standaloneFile of CONFIG.stylesheets.standaloneFiles) {
        const source = path.join('styles', standaloneFile);
        const dest = path.join(docsStylesDir, standaloneFile);

        if (fs.existsSync(source)) {
            fs.copyFileSync(source, dest);
            console.log(`  ✓ Copied ${standaloneFile} to docs/styles`);
        } else {
            console.warn(`  ⚠ Warning: ${standaloneFile} not found`);
        }

        // Copy minified version if it exists
        const minifiedFile = standaloneFile.replace('.css', '.min.css');
        const minifiedSource = path.join('styles', minifiedFile);
        const minifiedDest = path.join(docsStylesDir, minifiedFile);

        if (fs.existsSync(minifiedSource)) {
            fs.copyFileSync(minifiedSource, minifiedDest);
            console.log(`  ✓ Copied ${minifiedFile} to docs/styles`);
        }
    }

    console.log('');
}

// Copy files to root for clean npm package structure
function copyFilesToRoot() {
    console.log('Copying files to root for clean npm package structure...');

    const filesToCopy = [
        { source: 'scripts/manifest.js', dest: 'manifest.js' },  // Dynamic loader
        { source: 'styles/manifest.css', dest: 'manifest.css' },
        { source: 'styles/manifest.min.css', dest: 'manifest.min.css' },
        { source: 'styles/manifest.theme.css', dest: 'manifest.theme.css' },
        { source: 'styles/manifest.code.css', dest: 'manifest.code.css' },
        { source: 'styles/manifest.code.min.css', dest: 'manifest.code.min.css' }
    ];

    for (const file of filesToCopy) {
        const sourcePath = path.join('..', file.source);
        const destPath = path.join('..', file.dest);

        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`  ✓ Copied ${file.source} → ${file.dest}`);
        } else {
            console.warn(`  ⚠ Warning: ${file.source} not found, skipping`);
        }
    }

    console.log('');
}

// Copy files to package root with clean filenames for npm package
function createDistDirectory() {
    console.log('Copying files to package root with clean filenames...');

    const filesToCopy = [
        { source: 'scripts/manifest.js', dest: 'manifest.js' },  // Dynamic loader
        { source: 'styles/manifest.css', dest: 'manifest.css' },
        { source: 'styles/manifest.min.css', dest: 'manifest.min.css' },
        { source: 'styles/manifest.theme.css', dest: 'manifest.theme.css' },
        { source: 'styles/manifest.code.css', dest: 'manifest.code.css' },
        { source: 'styles/manifest.code.min.css', dest: 'manifest.code.min.css' }
    ];

    for (const file of filesToCopy) {
        const sourcePath = path.join('..', file.source);
        const destPath = path.join('..', file.dest);

        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`  ✓ Copied ${file.source} → ${file.dest}`);
        } else {
            console.warn(`  ⚠ Warning: ${file.source} not found, skipping`);
        }
    }

    console.log('');
}

// Copy files to package root for clean jsdelivr URLs (only during build)
function copyFilesToPackageRoot() {
    console.log('Copying files to package root for clean jsdelivr URLs...');

    const filesToCopy = [
        { source: 'scripts/manifest.js', dest: 'manifest.js' },  // Dynamic loader
        { source: 'styles/manifest.css', dest: 'manifest.css' },
        { source: 'styles/manifest.min.css', dest: 'manifest.min.css' },
        { source: 'styles/manifest.theme.css', dest: 'manifest.theme.css' },
        { source: 'styles/manifest.code.css', dest: 'manifest.code.css' },
        { source: 'styles/manifest.code.min.css', dest: 'manifest.code.min.css' }
    ];

    for (const file of filesToCopy) {
        const sourcePath = path.join('..', file.source);
        const destPath = path.join('..', file.dest);

        if (fs.existsSync(sourcePath)) {
            fs.copyFileSync(sourcePath, destPath);
            console.log(`  ✓ Copied ${file.source} → ${file.dest}`);
        } else {
            console.warn(`  ⚠ Warning: ${file.source} not found, skipping`);
        }
    }

    console.log('');
}

// Run the build
build(); 