import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    readGlobalModuleRoots,
    resolveDependency,
    importProjectOnly,
    missingBrowserMessage,
    tailwindMissingMessage,
    locateTailwind,
    tailwindCliCommand,
} from '../src/scripts/manifest.render.mjs';

const repoModules = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

function fakePackage(modulesDir, name, extra = {}) {
    const dir = join(modulesDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', main: 'index.js', ...extra }));
    writeFileSync(join(dir, 'index.js'), 'module.exports = {};\n');
    if (extra.bin) writeFileSync(join(dir, extra.bin.tailwindcss || extra.bin), '');
}

let tmp, project, bareProject, globalRoot;

beforeAll(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'mnfst-render-deps-')));
    project = join(tmp, 'project');
    bareProject = join(tmp, 'bare');
    globalRoot = join(tmp, 'global', 'lib', 'node_modules');
    mkdirSync(bareProject, { recursive: true });
    for (const name of ['puppeteer', 'tailwindcss']) {
        const extra = name === 'tailwindcss' ? { version: '4.1.0' } : {};
        fakePackage(join(project, 'node_modules'), name, extra);
        fakePackage(globalRoot, name, extra);
    }
    fakePackage(globalRoot, '@tailwindcss/cli', { bin: { tailwindcss: 'cli.mjs' } });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('resolveDependency', () => {
    it('prefers the project install and does not look up global roots', () => {
        let looked = false;
        const found = resolveDependency('puppeteer', project, () => { looked = true; return [globalRoot]; });
        expect(found.scope).toBe('project');
        expect(found.path.startsWith(join(project, 'node_modules', 'puppeteer'))).toBe(true);
        expect(looked).toBe(false);
    });

    it('falls back to the global root when the project lacks it', () => {
        const found = resolveDependency('puppeteer', bareProject, [globalRoot]);
        expect(found.scope).toBe('global');
        expect(found.path.startsWith(join(globalRoot, 'puppeteer'))).toBe(true);
    });

    it('returns null when missing everywhere', () => {
        expect(resolveDependency('puppeteer', bareProject, [])).toBeNull();
        expect(resolveDependency('puppeteer', bareProject, [join(tmp, 'nowhere')])).toBeNull();
    });
});

describe('readGlobalModuleRoots', () => {
    it('uses npm root -g, then NODE_PATH entries', () => {
        const calls = [];
        const spawn = (cmd, args, opts) => { calls.push([cmd, args, opts.timeout]); return { status: 0, stdout: `${globalRoot}\n` }; };
        const roots = readGlobalModuleRoots({ env: { NODE_PATH: ['/a', globalRoot, '/b'].join(delimiter) }, spawn });
        expect(roots).toEqual([globalRoot, '/a', '/b']);
        expect(calls).toEqual([['npm', ['root', '-g'], 3000]]);
    });

    it('fails soft when npm is missing or errors', () => {
        expect(readGlobalModuleRoots({ env: {}, spawn: () => { throw new Error('ENOENT'); } })).toEqual([]);
        expect(readGlobalModuleRoots({ env: {}, spawn: () => ({ status: null, error: new Error('ETIMEDOUT') }) })).toEqual([]);
        expect(readGlobalModuleRoots({ env: { NODE_PATH: '/a' }, spawn: () => ({ status: 1, stdout: '' }) })).toEqual(['/a']);
    });
});

describe('missing-dependency messages', () => {
    it('recommends one global install, per-project as the alternative', () => {
        expect(missingBrowserMessage()).toContain('npm i -g puppeteer');
        expect(missingBrowserMessage()).toContain('npm i -D puppeteer');
        expect(tailwindMissingMessage()).toContain('npm i -g tailwindcss @tailwindcss/cli');
        expect(tailwindMissingMessage()).toContain('npm i -D tailwindcss @tailwindcss/cli');
    });
});

describe('locateTailwind / tailwindCliCommand', () => {
    it('keeps the project npx invocation when tailwindcss is in the project', () => {
        const loc = locateTailwind(project, [globalRoot]);
        expect(loc).toEqual({ scope: 'project' });
        const env = { PATH: '/bin' };
        const run = tailwindCliCommand(loc, ['-i', 'in.css'], env);
        expect(run).toEqual({ cmd: 'npx', args: ['--yes', '@tailwindcss/cli@4', '-i', 'in.css'], env });
    });

    it('runs the global CLI with NODE_PATH at the global tailwindcss', () => {
        const loc = locateTailwind(bareProject, [globalRoot]);
        expect(loc).toEqual({ scope: 'global', modulesDir: globalRoot, cliBin: join(globalRoot, '@tailwindcss', 'cli', 'cli.mjs') });
        const run = tailwindCliCommand(loc, ['-i', 'in.css'], { NODE_PATH: '/x' });
        expect(run.cmd).toBe(process.execPath);
        expect(run.args).toEqual([loc.cliBin, '-i', 'in.css']);
        expect(run.env.NODE_PATH).toBe([globalRoot, '/x'].join(delimiter));
    });

    it('returns null when tailwindcss is missing everywhere', () => {
        expect(locateTailwind(bareProject, [])).toBeNull();
    });

    it('treats a global Tailwind older than v4 as missing', () => {
        const oldRoot = join(tmp, 'old-global', 'node_modules');
        fakePackage(oldRoot, 'tailwindcss', { version: '3.4.17' });
        expect(locateTailwind(bareProject, [oldRoot])).toBeNull();
    });
});

describe('project-only browser lookup', () => {
    it('never consults the global roots', async () => {
        await expect(importProjectOnly('puppeteer', bareProject)).rejects.toThrow('not installed in this project');
        expect(resolveDependency('puppeteer', bareProject, [globalRoot])?.scope).toBe('global');
    });

    it.skipIf(!existsSync(join(repoModules, '@tailwindcss', 'cli')))('compiles with a global-only install', () => {
        const site = join(tmp, 'site');
        mkdirSync(site, { recursive: true });
        writeFileSync(join(site, 'index.html'), '<div class="flex mt-4"></div>');
        writeFileSync(join(site, 'in.css'), '@import "tailwindcss";\n');
        const loc = locateTailwind(site, [repoModules]);
        expect(loc.scope).toBe('global');
        const run = tailwindCliCommand(loc, ['-i', join(site, 'in.css'), '-o', join(site, 'out.css')]);
        const r = spawnSync(run.cmd, run.args, { cwd: site, env: run.env, encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        const css = readFileSync(join(site, 'out.css'), 'utf8');
        expect(css).toContain('.flex');
        expect(css).toContain('.mt-4');
    }, 30000);
});
