#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Default Manifest MCP endpoint. Override via --mcp-url for staging/local dev.
const DEFAULT_MCP_URL = 'https://manifest-mcp.manifest-c5f.workers.dev/mcp';

// Parse CLI args: extract flags first, then join remaining tokens as the project name.
// Supports `--key=xxx` / `--key xxx`, `--mcp-url=xxx` / `--mcp-url xxx`.
// Falls back to the MANIFEST_API_KEY env var when --key is not given.
function parseArgs(argv) {
  let apiKey = process.env.MANIFEST_API_KEY || null;
  let mcpUrl = DEFAULT_MCP_URL;
  let projectId = null;    // --project-id: non-secret id for the committed .mcp.json
  let here = false;        // --here: install into the current directory, no subfolder
  let displayName = null;  // --name: project display name when using --here
  const remaining = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--key' || arg === '--mcp-url' || arg === '--name' || arg === '--project-id') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(`Error: ${arg} requires a value (e.g. ${arg}=value)`);
        process.exit(1);
      }
      if (arg === '--key') apiKey = value;
      else if (arg === '--mcp-url') mcpUrl = value;
      else if (arg === '--project-id') projectId = value;
      else displayName = value;
      i++;
    } else if (arg.startsWith('--key=')) {
      apiKey = arg.slice('--key='.length);
    } else if (arg.startsWith('--mcp-url=')) {
      mcpUrl = arg.slice('--mcp-url='.length);
    } else if (arg.startsWith('--project-id=')) {
      projectId = arg.slice('--project-id='.length);
    } else if (arg.startsWith('--name=')) {
      displayName = arg.slice('--name='.length);
    } else if (arg === '--here' || arg === '.') {
      here = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      remaining.push(arg);
    }
  }

  return {
    apiKey: apiKey ? apiKey.trim() : null,
    mcpUrl: mcpUrl.trim(),
    projectId: projectId ? projectId.trim() : null,
    here,
    displayName: displayName ? displayName.trim() : null,
    projectName: remaining.join(' ').trim(),
  };
}

function printUsage() {
  console.log('Usage: npx mnfst-starter [<project-name> | --here] [--name "<name>"] [--key=<api-key>] [--mcp-url=<url>]');
  console.log('');
  console.log('Examples:');
  console.log('  npx mnfst-starter MyProject                 # scaffold into ./MyProject');
  console.log('  npx mnfst-starter "Playcom Platform"');
  console.log('  npx mnfst-starter --here                    # scaffold into the current folder');
  console.log('  npx mnfst-starter --here --name "My Site"   # current folder, explicit name');
  console.log('  npx mnfst-starter MyProject --key=mfst_free_abc123');
  console.log('');
  console.log('When --key (or MANIFEST_API_KEY env var) is provided, the project is');
  console.log('initialised with .env (gitignored, holds the key) and .mcp.json');
  console.log('(checked in, references ${MANIFEST_API_KEY}) so Claude Code can connect');
  console.log('to the Manifest MCP server on first launch.');
}

const { apiKey, mcpUrl, projectId, here, displayName, projectName } = parseArgs(process.argv.slice(2));

// In --here mode the project name comes from --name or the current folder's name;
// otherwise it's the positional argument (which also becomes the subfolder name).
const name = here ? (displayName || path.basename(process.cwd())) : projectName;

if (!name) {
  printUsage();
  process.exit(1);
}

// Validate project name - allow letters, numbers, spaces, dots, underscores, hyphens; prevent path tricks
if (!/^[a-zA-Z0-9._ -]+$/.test(name) || name.includes('..') || name.startsWith('.') || name.endsWith('.') || /^\s|\s$/.test(name)) {
  console.error('Error: Project name must contain only letters, numbers, spaces, dots, underscores, and hyphens. Cannot start/end with dots or spaces, or contain consecutive dots.');
  process.exit(1);
}

// Validate API key shape if provided (defence-in-depth — wrong key still works at runtime as anonymous,
// but a typo'd key looking like `--keymfst_xxx` would otherwise silently fail).
if (apiKey && !/^mfst_(free|live|test)_[A-Za-z0-9]{20,}$/.test(apiKey)) {
  console.error('Error: API key does not look like a valid Manifest key (expected mfst_<env>_<chars>).');
  console.error('Got: ' + apiKey.slice(0, 16) + '...');
  process.exit(1);
}

const projectPath = here ? process.cwd() : path.resolve(process.cwd(), name);

if (here) {
  // In-place: refuse only if this is already a Manifest project, to avoid
  // clobbering one. Otherwise scaffold into the (possibly non-empty) folder.
  if (fs.existsSync(path.join(projectPath, 'manifest.json'))) {
    console.error('Error: this folder already contains a manifest.json — it looks like a Manifest project already. Aborting to avoid overwriting it.');
    process.exit(1);
  }
} else if (fs.existsSync(projectPath)) {
  console.error(`Error: Directory "${name}" already exists`);
  process.exit(1);
}

console.log(here ? `Creating Manifest project "${name}" in the current folder` : `Creating Manifest project: ${name}`);

try {
  // Create project directory
  fs.mkdirSync(projectPath, { recursive: true });

  // Copy all files from starter template (must match templates/starter; exclude local-only e.g. bs-config.js)
  const starterDir = path.join(__dirname, 'templates');
  const filesToCopy = [
    'components',
    'assets',
    '_redirects',
    // .gitignore is handled separately (merge-not-clobber) so --here into an
    // existing repo preserves the user's own ignore rules.
    'favicon.ico',
    'index.html',
    'LICENSE.md',
    'locales.csv',
    'manifest.json',
    'manifest.theme.css',
    'privacy.md',
    'README.md'
  ];

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
      mf.name = name;
      mf.short_name = name.length > 12 ? name.slice(0, 12) : name;
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

# Output of 'npm pack'
*.tgz

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

  // Scaffold the Manifest MCP integration ONLY when this came through the
  // MCP/AI flow — signalled by --project-id (preferred) or --key. A plain
  // `npx mnfst-starter MyProject` (general framework users) writes none of this.
  //
  //   .mcp.json  — checked in. Carries the NON-SECRET project_id
  //                (X-Manifest-Project); teammates connect via their own
  //                sign-in + team membership, no shared key. (Legacy: if only a
  //                key is given, falls back to the X-API-Key header form.)
  //   .env       — gitignored, holds the actual key for headless/automation use
  //                (scheduled agents, CI). Optional.
  //   .claude/settings.json — pre-approves the manifest MCP tools.
  const mcpWiring = Boolean(projectId || apiKey);
  if (mcpWiring) {
    if (apiKey) {
      const envContent = [
        '# Manifest API key — for headless/automation use (scheduled agents, CI).',
        '# Treat this like a password. Do NOT commit (already in .gitignore).',
        '# Interactive contributors connect via sign-in + team membership instead.',
        '',
        '# Server-side only: NOT prefixed with PUBLIC_, so mnfst-run does NOT inject',
        '# it into window.env. Only PUBLIC_* vars reach the browser — any other env',
        '# var you add here stays server-side. To expose a value to manifest.json',
        '# (e.g. a public API URL), name it PUBLIC_… and reference it as ${PUBLIC_…}.',
        `MANIFEST_API_KEY=${apiKey}`,
        '',
      ].join('\n');
      fs.writeFileSync(path.join(projectPath, '.env'), envContent);
    }

    const headers = projectId
      ? { 'X-Manifest-Project': projectId }
      : { 'X-API-Key': '${MANIFEST_API_KEY}' };
    const mcpConfig = { mcpServers: { manifest: { type: 'http', url: mcpUrl, headers } } };
    fs.writeFileSync(
      path.join(projectPath, '.mcp.json'),
      JSON.stringify(mcpConfig, null, 2) + '\n',
    );

    // Pre-approve the Manifest MCP tools, and wire the design-guard hook. The
    // hook script (.claude/hooks/ui-guard.mjs) is delivered by
    // manifest_install_skills; here we only register it (no-ops until present).
    const claudeDir = path.join(projectPath, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const guardCommand = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/ui-guard.mjs"';
    const settings = {
      permissions: { allow: ['mcp__manifest'] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: guardCommand }] }],
        PreToolUse: [
          { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: guardCommand }] },
        ],
      },
    };
    fs.writeFileSync(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify(settings, null, 2) + '\n',
    );
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
