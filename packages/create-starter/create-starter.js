#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Default Manifest MCP endpoint. Override via --mcp-url for staging/local dev.
const DEFAULT_MCP_URL = 'https://mcp.manifestx.dev/mcp';

// Parse CLI args: extract flags first, then join remaining tokens as the project name.
// Supports `--key=xxx` / `--key xxx`, `--mcp-url=xxx` / `--mcp-url xxx`.
function parseArgs(argv) {
  let apiKey = null;
  let mcpUrl = DEFAULT_MCP_URL;
  let projectId = null;    // --project-id: non-secret id for the committed .mcp.json
  let here = false;        // --here: install into the current directory, no subfolder
  let displayName = null;  // --name: project display name (defaults to the folder name)
  let force = false;       // --force: overwrite same-named files in --here mode
  const remaining = [];

  const VALUE_FLAGS = ['--key', '--mcp-url', '--name', '--project-id'];
  const set = (flag, value) => {
    if (!value || !value.trim() || value.startsWith('--')) fail(`${flag} requires a value (e.g. ${flag}=value)`);
    if (flag === '--key') apiKey = value;
    else if (flag === '--mcp-url') mcpUrl = value;
    else if (flag === '--project-id') projectId = value;
    else displayName = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (VALUE_FLAGS.includes(arg)) {
      set(arg, argv[i + 1]);
      i++;
    } else if (flag !== arg && VALUE_FLAGS.includes(flag)) {
      set(flag, arg.slice(eq + 1));
    } else if (arg === '--here' || arg === '.') {
      here = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg.startsWith('-')) {
      fail(`unknown option "${flag}". Run npx mnfst-starter --help for the supported options.`);
    } else {
      remaining.push(arg);
    }
  }

  return {
    apiKey: apiKey ? apiKey.trim() : null,
    mcpUrl: mcpUrl.trim(),
    projectId: projectId ? projectId.trim() : null,
    here,
    force,
    displayName: displayName ? displayName.trim() : null,
    projectName: remaining.join(' ').trim(),
  };
}

function fail(message, usage = false) {
  console.error(`Error: ${message}`);
  if (usage) {
    console.error('');
    printUsage(console.error);
  }
  process.exit(1);
}

function printUsage(log = console.log) {
  log('Usage: npx mnfst-starter [<project-name> | --here [--force]] [--name "<name>"] [--project-id=<id>] [--key=<api-key>] [--mcp-url=<url>]');
  log('');
  log('Examples:');
  log('  npx mnfst-starter MyProject                 # scaffold into ./MyProject');
  log('  npx mnfst-starter "Playcom Platform"');
  log('  npx mnfst-starter --here                    # scaffold into the current folder');
  log('  npx mnfst-starter --here --name "My Site"   # current folder, explicit name');
  log('  npx mnfst-starter my-site --name "My Site"  # ./my-site, named "My Site"');
  log('');
  log('--here never overwrites existing files unless --force is given; --force');
  log('lists what it overwrote and keeps an existing manifest.json name unless --name is given.');
  log('');
  log('--project-id and/or --key (normally passed by Manifest\'s manifest_init)');
  log('wire the project to the Manifest MCP server: .mcp.json and');
  log('.claude/settings.json are merged, and --key is saved to .env (gitignored)');
  log('for headless/CI publishing.');
}

const { apiKey, mcpUrl, projectId, here, force, displayName, projectName } = parseArgs(process.argv.slice(2));

if (here && projectName) console.error(`Warning: "${projectName}" ignored with --here; use --name to set the project name.`);
if (!here && force) console.error('Warning: --force only applies with --here; ignored.');

// --here: --name, else an existing manifest.json name (kept on --force), else the folder name.
// New folder: the positional is the folder; --name, if given, is the project name.
const existingManifest = here && !displayName ? readManifestName(path.join(process.cwd(), 'manifest.json')) : null;
const existingManifestName = existingManifest && existingManifest.name ? existingManifest : null;
const folder = here ? null : projectName;
const name = here ? (displayName || path.basename(process.cwd())) : (displayName || projectName);

if (!here && !folder) {
  fail(displayName
    ? `no folder name given; --name only sets the project name. Add a folder (npx mnfst-starter my-site --name "${displayName}") or use --here.`
    : 'give a folder name for the new project, or use --here to scaffold into the current folder.', true);
}
if (!name) fail('could not work out a project name; pass --name "<name>".', true);

// Only the folder becomes a path; the display name may be any text.
if (folder && !validName(folder)) {
  fail('Folder name must contain only letters, numbers, spaces, dots, underscores, and hyphens. Cannot start/end with dots or spaces, or contain consecutive dots. Use --name for any other project name.');
}

// Validate API key shape if provided (defence-in-depth — wrong key still works at runtime as anonymous,
// but a typo'd key looking like `--keymfst_xxx` would otherwise silently fail).
if (apiKey && !/^mfst_(free|live|test)_[A-Za-z0-9]{20,}$/.test(apiKey)) {
  console.error('Error: API key does not look like a valid Manifest key (expected mfst_<env>_<chars>).');
  process.exit(1);
}

const starterDir = path.join(__dirname, 'templates');
// Must match templates/starter; .gitignore is merged separately.
const filesToCopy = [
  'components',
  'assets',
  '_redirects',
  'favicon.ico',
  'index.html',
  'LICENSE.md',
  'locales.csv',
  'manifest.json',
  'manifest.theme.css',
  'privacy.md',
  'README.md'
];
const mcpWiring = Boolean(projectId || apiKey);

const projectPath = here ? process.cwd() : path.resolve(process.cwd(), folder);

let overwritten = [];
if (here) {
  overwritten = filesToCopy.flatMap((f) => collisions(path.join(starterDir, f), path.join(projectPath, f), f));
  if (overwritten.length && !force) {
    console.error('Error: these files already exist in this folder and would be overwritten:');
    overwritten.forEach((f) => console.error('  ' + f));
    console.error('Move them aside, or re-run with --force to overwrite them.');
    process.exit(1);
  }
} else if (fs.existsSync(projectPath)) {
  console.error(`Error: Directory "${folder}" already exists`);
  process.exit(1);
}

// Read existing JSON config up front so a malformed file aborts before any write.
const mcpJsonPath = path.join(projectPath, '.mcp.json');
const settingsPath = path.join(projectPath, '.claude', 'settings.json');
const existingMcp = mcpWiring ? readJson(mcpJsonPath) : null;
const existingSettings = mcpWiring ? readJson(settingsPath) : null;

const finalName = existingManifestName ? existingManifestName.name : name;
console.log(here ? `Creating Manifest project "${finalName}" in the current folder` : `Creating Manifest project: ${finalName}` + (folder !== finalName ? ` in ./${folder}` : ''));
if (overwritten.length) {
  console.error(`Overwriting ${overwritten.length} existing file${overwritten.length === 1 ? '' : 's'}:`);
  overwritten.forEach((f) => console.error('  ' + f));
}
if (existingManifestName) console.error(`Keeping the existing manifest.json name "${existingManifestName.name}"; pass --name to change it.`);
if (existingManifest && existingManifest.invalid) console.error(`Warning: the existing manifest.json is not a valid JSON object, so its name could not be kept; using "${name}". Pass --name to set it.`);

try {
  // Create project directory
  fs.mkdirSync(projectPath, { recursive: true });

  filesToCopy.forEach(file => {
    const srcPath = path.join(starterDir, file);
    const destPath = path.join(projectPath, file);

    if (fs.existsSync(srcPath)) {
      if (fs.statSync(srcPath).isDirectory()) {
        copyDir(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  });

  // Apply the project name to manifest.json (template ships a placeholder name).
  const manifestPath = path.join(projectPath, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (existingManifestName) {
        mf.name = existingManifestName.name;
        if (existingManifestName.short_name) mf.short_name = existingManifestName.short_name;
        else delete mf.short_name;
      } else {
        mf.name = name;
        const chars = Array.from(name);
        mf.short_name = chars.length > 12 ? chars.slice(0, 12).join('').trimEnd() : name;
      }
      fs.writeFileSync(manifestPath, JSON.stringify(mf, null, 2) + '\n');
    } catch {
      // Non-fatal: ship the template manifest.json as-is rather than break setup.
    }
  }

  // Create .gitignore
  const gitignore = `# Dependencies (if you add them later)
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build outputs (if you add a build process)
dist/
build/
*.tgz

# Manifest render cache
.mnfst-cache/

# Development files
.vscode/
.idea/
*.swp
*.swo
*~
bs-config.js

# OS generated files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db

# Temporary files
*.tmp
*.temp

# Logs
logs
*.log
# Runtime data
pids
*.pid
*.seed
*.pid.lock

# Coverage directory used by tools like istanbul
coverage/

# nyc test coverage
.nyc_output

# Dependency directories
jspm_packages/

# Optional npm cache directory
.npm

# Optional REPL history
.node_repl_history

# Yarn Integrity file
.yarn-integrity

# dotenv environment variables file
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# parcel-bundler cache (https://parceljs.org/)
.cache
.parcel-cache

# next.js build output
.next

# nuxt.js build output
.nuxt

# vuepress build output
.vuepress/dist

# Serverless directories
.serverless

# FuseBox cache
.fusebox/

# DynamoDB Local files
.dynamodb/
`;

  // Write .gitignore WITHOUT clobbering an existing one (--here may scaffold
  // into a folder that's already a git repo with the user's own rules). If it
  // exists, append only the entries it's missing — critically `.env*`, so the
  // API key never gets committed — under a clear header, preserving everything
  // the user already had.
  const gitignorePath = path.join(projectPath, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    const existing = fs.readFileSync(gitignorePath, 'utf8');
    const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
    const missing = gitignore
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !have.has(l));
    if (missing.length) {
      const addition = '\n# Added by Manifest\n' + missing.join('\n') + '\n';
      fs.appendFileSync(gitignorePath, (existing.endsWith('\n') ? '' : '\n') + addition);
    }
  } else {
    fs.writeFileSync(gitignorePath, gitignore);
  }

  // MCP wiring only when called via manifest_init (--project-id and/or --key).
  // .mcp.json and .claude/settings.json are merged, never replaced.
  if (mcpWiring) {
    if (apiKey) writeEnvKey(path.join(projectPath, '.env'), apiKey);

    const headers = projectId
      ? { 'X-Manifest-Project': projectId }
      : { 'X-API-Key': '${MANIFEST_API_KEY}' };
    const mcpConfig = existingMcp || {};
    mcpConfig.mcpServers = { ...(mcpConfig.mcpServers || {}), manifest: { type: 'http', url: mcpUrl, headers } };
    fs.writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2) + '\n');

    // Pre-approve the Manifest tools. Guard hooks are registered by
    // manifest_install_skills, which ships their scripts; only wire ui-guard
    // here when its script is already present.
    const settings = existingSettings || {};
    settings.permissions = settings.permissions || {};
    const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : [];
    if (!allow.includes('mcp__manifest')) allow.push('mcp__manifest');
    settings.permissions.allow = allow;
    if (fs.existsSync(path.join(projectPath, '.claude', 'hooks', 'ui-guard.mjs'))) {
      const hook = { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ui-guard.mjs"' };
      addHook(settings, 'UserPromptSubmit', undefined, hook);
      addHook(settings, 'PreToolUse', 'Write|Edit|MultiEdit', hook);
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  }

  console.log(`Project created successfully.`);
  console.log(`Location: ${projectPath}`);
  if (mcpWiring) {
    console.log('');
    console.log('Manifest MCP wired up:');
    console.log('  .mcp.json  — connects this project (safe to commit)');
    if (apiKey) console.log('  .env       — API key for headless/automation (gitignored)');
    console.log('');
    console.log('Next: preview it locally with `npx mnfst-run` (http://localhost:5001),');
    console.log('or open the folder in Claude Code and ask it to build your site.');
  } else {
    console.log(`See README.md for more details, or run \`npx mnfst-run\` to preview locally.`);
  }

} catch (error) {
  console.error('Error creating project:', error.message);
  process.exit(1);
}

function validName(n) {
  return /^[a-zA-Z0-9._ -]+$/.test(n) && !n.includes('..') && !n.startsWith('.') && !n.endsWith('.') && !/^\s|\s$/.test(n);
}

// { name, short_name } from an existing manifest.json; { invalid } if unreadable; null if absent or unnamed
function readManifestName(file) {
  if (!fs.existsSync(file)) return null;
  let mf;
  try {
    mf = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { invalid: true };
  }
  if (!mf || typeof mf !== 'object' || Array.isArray(mf)) return { invalid: true };
  if (typeof mf.name === 'string' && mf.name.trim()) {
    return { name: mf.name, short_name: typeof mf.short_name === 'string' ? mf.short_name : null };
  }
  return null;
}

// Template files (relative paths) that already exist at dest
function collisions(src, dest, rel) {
  if (!fs.existsSync(src) || !fs.existsSync(dest)) return [];
  if (!fs.statSync(src).isDirectory()) return [rel];
  if (!fs.statSync(dest).isDirectory()) return [rel];
  return fs.readdirSync(src).flatMap((e) => collisions(path.join(src, e), path.join(dest, e), rel + '/' + e));
}

function readJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  console.error(`Error: ${path.relative(process.cwd(), file) || file} is not a valid JSON object; fix or remove it, then re-run.`);
  process.exit(1);
}

function addHook(settings, event, matcher, hook) {
  settings.hooks = settings.hooks || {};
  const entries = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const present = entries.some((e) => (e.hooks || []).some((h) => h.command === hook.command) && e.matcher === matcher);
  if (!present) entries.push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
  settings.hooks[event] = entries;
}

// Set MANIFEST_API_KEY in .env, keeping any other variables
function writeEnvKey(file, key) {
  const line = `MANIFEST_API_KEY=${key}`;
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8');
    const re = /^\s*(export\s+)?MANIFEST_API_KEY\s*=.*$/m;
    const next = re.test(existing)
      ? existing.replace(re, line)
      : existing + (existing === '' || existing.endsWith('\n') ? '' : '\n') + '\n# Manifest API key (headless/CI publishing). Do not commit.\n' + line + '\n';
    fs.writeFileSync(file, next);
    return;
  }
  fs.writeFileSync(file, [
    '# Manifest API key — for headless/automation use (scheduled agents, CI).',
    '# Treat this like a password. Do NOT commit (already in .gitignore).',
    '# Interactive contributors connect via sign-in + team membership instead.',
    '',
    '# Server-side only: NOT prefixed with PUBLIC_, so mnfst-run does NOT inject',
    '# it into window.env. Only PUBLIC_* vars reach the browser — any other env',
    '# var you add here stays server-side. To expose a value to manifest.json',
    '# (e.g. a public API URL), name it PUBLIC_… and reference it as ${PUBLIC_…}.',
    line,
    '',
  ].join('\n'));
}

// Helper function to copy directories recursively
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}
