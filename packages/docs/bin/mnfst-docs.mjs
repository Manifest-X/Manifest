#!/usr/bin/env node
// Scaffold a Manifest docs site, or add docs to an existing project.
//   npx mnfst-docs [name]        new folder
//   npx mnfst-docs --here        current folder
//   npx mnfst-docs --components  components only (for an existing project)

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`
mnfst-docs — documentation site template for Manifest

  npx mnfst-docs [name]      create a docs site in ./name
  npx mnfst-docs --here      create it in the current folder
  npx mnfst-docs --components  copy just the components into ./components

After scaffolding:
  npx mnfst-run .            serve locally
  npx mnfst-render .         prerender to /website

Docs: https://manifestx.dev/docs
`);
    process.exit(0);
}

const componentsOnly = argv.includes('--components');
const here = argv.includes('--here') || argv.includes('.');
const name = argv.find((a) => !a.startsWith('-') && a !== '.') || 'docs';
const target = here || componentsOnly ? process.cwd() : resolve(process.cwd(), name);

if (componentsOnly) {
    const dest = join(target, 'components');
    mkdirSync(dest, { recursive: true });
    cpSync(join(packageRoot, 'components'), dest, { recursive: true });
    const files = readdirSync(join(packageRoot, 'components'));
    console.log(`Copied ${files.length} components into ${dest}`);
    console.log('\nRegister them in manifest.json:');
    console.log(`  "preloadedComponents": [${files.map((f) => `\n    "components/${f}"`).join(',')}\n  ]`);
    console.log('\nThen mount: <x-docs x-route="docs"></x-docs>');
    process.exit(0);
}

if (!here && existsSync(target) && readdirSync(target).length) {
    console.error(`Error: ${target} already exists and is not empty.`);
    process.exit(1);
}

mkdirSync(target, { recursive: true });
cpSync(join(packageRoot, 'template'), target, { recursive: true });
// Components ship at the package root (short CDN paths); a scaffolded project
// expects them under components/, where manifest.json registers them.
cpSync(join(packageRoot, 'components'), join(target, 'components'), { recursive: true });

// The template README documents the template itself; a scaffolded project
// shouldn't inherit it as its own readme.
const readme = join(target, 'README.md');
if (existsSync(readme)) {
    writeFileSync(readme, `# ${here ? 'Docs' : name}\n\nBuilt with the Manifest docs template.\n\n    npx mnfst-run .      # serve\n    npx mnfst-render .   # prerender to /website\n\nArticles live in \`articles/\`; navigation is \`data/docs.yaml\`.\n`);
}

if (!here) {
    const manifestPath = join(target, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.name = name;
    manifest.short_name = name;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n');
}

console.log(`Docs site created in ${target}`);
console.log('\nNext:');
if (!here) console.log(`  cd ${name}`);
console.log('  npx mnfst-run .      # serve');
console.log('  npx mnfst-render .   # prerender to /website');
