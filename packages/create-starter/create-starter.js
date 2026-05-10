#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Default Manifest MCP endpoint. Override via --mcp-url for staging/local dev.
const DEFAULT_MCP_URL = 'https://mcp.manifestx.dev/mcp';

// Parse CLI args: extract flags first, then join remaining tokens as the project name.
// Supports `--key=xxx` / `--key xxx`, `--mcp-url=xxx` / `--mcp-url xxx`.
// Falls back to the MANIFEST_API_KEY env var when --key is not given.
function parseArgs(argv) {
  let apiKey = process.env.MANIFEST_API_KEY || null;
  let mcpUrl = DEFAULT_MCP_URL;
  const remaining = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--key' || arg === '--mcp-url') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        console.error(`Error: ${arg} requires a value (e.g. ${arg}=mfst_free_xxx)`);
        process.exit(1);
      }
      if (arg === '--key') apiKey = value;
      else mcpUrl = value;
      i++;
    } else if (arg.startsWith('--key=')) {
      apiKey = arg.slice('--key='.length);
    } else if (arg.startsWith('--mcp-url=')) {
      mcpUrl = arg.slice('--mcp-url='.length);
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
    projectName: remaining.join(' ').trim(),
  };
}

function printUsage() {
  console.log('Usage: npx mnfst-starter <project-name> [--key=<api-key>] [--mcp-url=<url>]');
  console.log('');
  console.log('Examples:');
  console.log('  npx mnfst-starter MyProject');
  console.log('  npx mnfst-starter "Playcom Platform"');
  console.log('  npx mnfst-starter MyProject --key=mfst_free_abc123');
  console.log('');
  console.log('When --key (or MANIFEST_API_KEY env var) is provided, the project is');
  console.log('initialised with .env (gitignored, holds the key) and .mcp.json');
  console.log('(checked in, references ${MANIFEST_API_KEY}) so Claude Code can connect');
  console.log('to the Manifest MCP server on first launch.');
}

const { apiKey, mcpUrl, projectName } = parseArgs(process.argv.slice(2));

if (!projectName) {
  printUsage();
  process.exit(1);
}

// Validate project name - allow letters, numbers, spaces, dots, underscores, hyphens; prevent path tricks
if (!/^[a-zA-Z0-9._ -]+$/.test(projectName) || projectName.includes('..') || projectName.startsWith('.') || projectName.endsWith('.') || /^\s|\s$/.test(projectName)) {
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

const projectPath = path.resolve(process.cwd(), projectName);

// Check if directory already exists
if (fs.existsSync(projectPath)) {
  console.error(`Error: Directory "${projectName}" already exists`);
  process.exit(1);
}

console.log(`Creating Manifest project: ${projectName}`);

try {
  // Create project directory
  fs.mkdirSync(projectPath, { recursive: true });

  // Copy all files from starter template (must match templates/starter; exclude local-only e.g. bs-config.js)
  const starterDir = path.join(__dirname, 'templates');
  const filesToCopy = [
    'components',
    'icons',
    '_redirects',
    '.gitignore',
    'favicon.ico',
    'index.html',
    'LICENSE.md',
    'locales.csv',
    'manifest.json',
    'manifest.theme.css',
    'privacy.md',
    'README.md',
    'robots.txt',
    'sitemap.xml'
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

  fs.writeFileSync(path.join(projectPath, '.gitignore'), gitignore);

  // If an API key was supplied, scaffold the Manifest MCP integration:
  //   .env         — gitignored, holds the actual key
  //   .mcp.json    — checked in, references ${MANIFEST_API_KEY} so Claude Code
  //                  reads the key from the loaded environment at launch
  if (apiKey) {
    const envContent = [
      '# Manifest MCP — populated by `npx mnfst-starter --key=...`.',
      '# Treat this like a password. Do NOT commit (already in .gitignore).',
      '# To rotate, run a new starter or update via the Manifest dashboard.',
      `MANIFEST_API_KEY=${apiKey}`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(projectPath, '.env'), envContent);

    const mcpConfig = {
      mcpServers: {
        manifest: {
          type: 'http',
          url: mcpUrl,
          headers: {
            'X-API-Key': '${MANIFEST_API_KEY}',
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(projectPath, '.mcp.json'),
      JSON.stringify(mcpConfig, null, 2) + '\n',
    );
  }

  console.log(`Project created successfully.`);
  console.log(`Location: ${projectPath}`);
  if (apiKey) {
    console.log('');
    console.log('Manifest MCP wired up:');
    console.log('  .env       — your API key (gitignored)');
    console.log('  .mcp.json  — MCP server config (safe to commit)');
    console.log('');
    console.log('Next: `cd ' + projectName + ' && claude` to open in Claude Code,');
    console.log('then `/init` to install the curated Manifest skills for your project.');
  } else {
    console.log(`See README.md for more details.`);
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
