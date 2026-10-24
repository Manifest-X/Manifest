import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyProjectIntoDist } from '../src/scripts/manifest.render.mjs';

let root;
let output;

function scaffold(files) {
    for (const f of files) {
        const p = join(root, f);
        mkdirSync(join(p, '..'), { recursive: true });
        writeFileSync(p, '');
    }
}

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mnfst-render-cap-'));
    output = join(root, 'website');
    mkdirSync(output);
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

describe('copyProjectIntoDist with Capacitor', () => {
    it.each(['capacitor.config.json', 'capacitor.config.ts', 'capacitor.config.js'])(
        'skips ios/, android/ and Capacitor configs when %s exists',
        (config) => {
            scaffold([
                config,
                'manifest.json',
                'pages/home.html',
                'ios/App/App/public/index.html',
                'android/app/build.gradle',
            ]);
            copyProjectIntoDist(root, output);
            expect(existsSync(join(output, 'manifest.json'))).toBe(true);
            expect(existsSync(join(output, 'pages/home.html'))).toBe(true);
            expect(existsSync(join(output, 'ios'))).toBe(false);
            expect(existsSync(join(output, 'android'))).toBe(false);
            expect(existsSync(join(output, config))).toBe(false);
        },
    );

    it('keeps ios/ and android/ folders in a project without a Capacitor config', () => {
        scaffold(['manifest.json', 'ios/index.html', 'android/index.html']);
        copyProjectIntoDist(root, output);
        expect(existsSync(join(output, 'ios/index.html'))).toBe(true);
        expect(existsSync(join(output, 'android/index.html'))).toBe(true);
    });

    it('never copies the output dir into itself', () => {
        scaffold(['capacitor.config.json', 'manifest.json']);
        copyProjectIntoDist(root, output);
        expect(existsSync(join(output, 'website'))).toBe(false);
    });
});

describe('copyProjectIntoDist dot-folders', () => {
    it('ships .well-known (AASA, assetlinks) but no other dot entries', () => {
        scaffold([
            'manifest.json',
            '.well-known/apple-app-site-association',
            '.well-known/assetlinks.json',
            '.env',
            '.git/HEAD',
            '.claude/settings.json',
            '.app-www/index.html',
        ]);
        copyProjectIntoDist(root, output);
        expect(existsSync(join(output, '.well-known/apple-app-site-association'))).toBe(true);
        expect(existsSync(join(output, '.well-known/assetlinks.json'))).toBe(true);
        for (const d of ['.env', '.git', '.claude', '.app-www']) expect(existsSync(join(output, d))).toBe(false);
    });

    it('ships .well-known in a Capacitor-wrapped project too', () => {
        scaffold(['capacitor.config.json', 'manifest.json', '.well-known/apple-app-site-association']);
        copyProjectIntoDist(root, output);
        expect(existsSync(join(output, '.well-known/apple-app-site-association'))).toBe(true);
    });
});
