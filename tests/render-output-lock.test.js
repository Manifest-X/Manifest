import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireOutputLock, outputLockPath } from '../src/scripts/manifest.render.mjs';

const RENDER = resolve(fileURLToPath(new URL('../src/scripts/manifest.render.mjs', import.meta.url)));

let dir;
let output;
const children = [];

function liveChild() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    children.push(child);
    return child;
}

function deadPid() {
    return spawnSync(process.execPath, ['-e', '']).pid;
}

function writeForeignLock(pid, extra = {}) {
    writeFileSync(outputLockPath(output), JSON.stringify({
        pid,
        hostname: hostname(),
        startedAt: '2026-09-21T10:00:00.000Z',
        argv: 'mnfst-render --root .',
        token: 'foreign',
        ...extra,
    }));
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mnfst-render-lock-'));
    output = join(dir, 'website');
});

afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
});

describe('acquireOutputLock', () => {
    it('writes a sibling lock with pid and start time, and removes it on release', () => {
        const lock = acquireOutputLock(output);
        expect(lock.path).toBe(output + '.mnfst-lock');
        const entry = JSON.parse(readFileSync(lock.path, 'utf8'));
        expect(entry.pid).toBe(process.pid);
        expect(entry.startedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
        expect(lock.held()).toBe(true);
        lock.release();
        expect(existsSync(lock.path)).toBe(false);
        expect(readdirSync(dir)).toEqual([]);
    });

    it('refuses a second acquire while the holder is alive, naming its pid and start time', () => {
        const child = liveChild();
        writeForeignLock(child.pid);
        let error;
        try { acquireOutputLock(output); } catch (err) { error = err; }
        expect(error?.code).toBe('MNFST_RENDER_LOCKED');
        expect(error.message).toContain(`pid ${child.pid}`);
        expect(error.message).toContain('2026-09-21T10:00:00.000Z');
        expect(error.message).toContain('--force-lock');
        expect(JSON.parse(readFileSync(outputLockPath(output), 'utf8')).token).toBe('foreign');
    });

    it('refuses against a lock held by this same process', () => {
        const first = acquireOutputLock(output);
        expect(() => acquireOutputLock(output)).toThrow(/already writing/);
        first.release();
    });

    it('takes over a stale lock whose pid is dead', () => {
        writeForeignLock(deadPid());
        const logs = [];
        const lock = acquireOutputLock(output, { onLog: (m) => logs.push(m) });
        expect(lock.held()).toBe(true);
        expect(logs.join('\n')).toMatch(/stale lock/);
        lock.release();
    });

    it('does not treat a lock from another host as stale', () => {
        writeForeignLock(deadPid(), { hostname: 'some-other-machine' });
        expect(() => acquireOutputLock(output)).toThrow(/on some-other-machine/);
    });

    it('--force-lock takes over a live lock, and the old holder sees it lost the lock', () => {
        const first = acquireOutputLock(output);
        const second = acquireOutputLock(output, { force: true });
        expect(second.held()).toBe(true);
        expect(first.held()).toBe(false);
        first.release();
        expect(existsSync(second.path)).toBe(true);
        second.release();
        expect(existsSync(second.path)).toBe(false);
    });

    it('lets exactly one of several racing processes acquire the lock', async () => {
        const script = `
            import { acquireOutputLock } from ${JSON.stringify('file://' + RENDER)};
            try {
                const lock = acquireOutputLock(${JSON.stringify(output)});
                console.log('won');
                setTimeout(() => lock.release(), 800);
            } catch (err) {
                console.log(err.code);
            }`;
        const runs = Array.from({ length: 6 }, () => new Promise((res) => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', script]);
            let out = '';
            child.stdout.on('data', (d) => { out += d; });
            child.on('close', () => res(out.trim()));
        }));
        const results = await Promise.all(runs);
        expect(results.filter((r) => r === 'won')).toHaveLength(1);
        expect(results.filter((r) => r === 'MNFST_RENDER_LOCKED')).toHaveLength(5);
        expect(existsSync(outputLockPath(output))).toBe(false);
    }, 20000);
});

describe('mnfst-render CLI', () => {
    it('fails fast against a locked output dir without touching website/ or staging', () => {
        writeFileSync(join(dir, 'manifest.json'), '{}');
        writeFileSync(join(dir, 'index.html'), '<!doctype html><title>t</title>');
        const child = liveChild();
        writeForeignLock(child.pid);
        const started = Date.now();
        const run = spawnSync(process.execPath, [RENDER, '--root', dir], { encoding: 'utf8', timeout: 15000 });
        expect(run.status).toBe(1);
        expect(Date.now() - started).toBeLessThan(10000);
        expect(run.stderr).toContain('another render is already writing');
        expect(run.stderr).toContain(`pid ${child.pid}`);
        expect(existsSync(output)).toBe(false);
        expect(existsSync(output + '.mnfst-staging')).toBe(false);
        expect(JSON.parse(readFileSync(outputLockPath(output), 'utf8')).token).toBe('foreign');
    }, 20000);
});
