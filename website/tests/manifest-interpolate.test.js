/**
 * Tests for manifest.json env-var interpolation.
 *
 * The source is a browser-global script (window.ManifestDataConfig = {...}).
 * We evaluate it in a vm context with minimal mocks so we can test the pure
 * interpolation functions without a real browser.
 */

import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import vm from 'vm'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let interpolateEnvVars
let interpolateManifest
let mockWindow

beforeAll(() => {
    const source = readFileSync(
        path.resolve(__dirname, '../src/scripts/manifest.data.js'),
        'utf-8'
    )

    mockWindow = {}
    const ctx = {
        window: mockWindow,
        document: {
            createElement: () => ({ onload: null, onerror: null, src: '' }),
            head: { appendChild: () => {} },
            querySelector: () => null,
        },
        console,
        fetch: () => Promise.resolve(),
        Promise,
        process,
    }

    // The full file expects Alpine etc. — we only need the config block at the
    // top, which runs synchronously and registers window.ManifestDataConfig.
    // Wrap in try/catch so failures further down (Alpine.directive calls) don't
    // mask our test target.
    try {
        vm.runInNewContext(source, ctx)
    } catch {
        // Expected — later parts of the script reference Alpine, document APIs
        // we haven't mocked. Config block at the top has already executed.
    }

    interpolateEnvVars = mockWindow.ManifestDataConfig?.interpolateEnvVars
    interpolateManifest = mockWindow.ManifestDataConfig?.interpolateManifest
})

afterEach(() => {
    delete process.env.__TEST_VAR
    delete process.env.__TEST_TOKEN
    delete mockWindow.env
})

describe('interpolateEnvVars (single string)', () => {
    it('replaces ${VAR} from process.env', () => {
        process.env.__TEST_VAR = 'hello'
        expect(interpolateEnvVars('value=${__TEST_VAR}')).toBe('value=hello')
    })

    it('replaces ${VAR} from window.env when process.env is missing', () => {
        mockWindow.env = { __TEST_VAR: 'world' }
        expect(interpolateEnvVars('value=${__TEST_VAR}')).toBe('value=world')
    })

    it('prefers process.env over window.env', () => {
        process.env.__TEST_VAR = 'from-process'
        mockWindow.env = { __TEST_VAR: 'from-window' }
        expect(interpolateEnvVars('value=${__TEST_VAR}')).toBe('value=from-process')
    })

    it('leaves unmatched ${VAR} untouched', () => {
        expect(interpolateEnvVars('${UNDEFINED_VAR}/path')).toBe('${UNDEFINED_VAR}/path')
    })

    it('handles multiple replacements in one string', () => {
        process.env.__TEST_VAR = 'a'
        process.env.__TEST_TOKEN = 'b'
        expect(interpolateEnvVars('${__TEST_VAR}-${__TEST_TOKEN}')).toBe('a-b')
    })

    it('passes through non-string values unchanged', () => {
        expect(interpolateEnvVars(42)).toBe(42)
        expect(interpolateEnvVars(null)).toBe(null)
        expect(interpolateEnvVars(undefined)).toBe(undefined)
    })
})

describe('interpolateManifest (recursive walker)', () => {
    it('walks nested objects and replaces strings in place', () => {
        process.env.__TEST_VAR = 'real-id'
        const manifest = {
            appwrite: {
                projectId: '${__TEST_VAR}',
                endpoint: 'https://cloud.appwrite.io/v1',
            },
        }
        interpolateManifest(manifest)
        expect(manifest.appwrite.projectId).toBe('real-id')
        expect(manifest.appwrite.endpoint).toBe('https://cloud.appwrite.io/v1')
    })

    it('walks arrays and replaces strings in place', () => {
        process.env.__TEST_VAR = 'replaced'
        const manifest = {
            data: {
                things: ['${__TEST_VAR}', 'plain', '${__TEST_VAR}-${__TEST_VAR}'],
            },
        }
        interpolateManifest(manifest)
        expect(manifest.data.things).toEqual(['replaced', 'plain', 'replaced-replaced'])
    })

    it('does not interpolate object keys', () => {
        process.env.__TEST_VAR = 'foo'
        const manifest = { '${__TEST_VAR}': 'bar' }
        interpolateManifest(manifest)
        expect(Object.keys(manifest)).toEqual(['${__TEST_VAR}'])
        expect(manifest['${__TEST_VAR}']).toBe('bar')
    })

    it('is idempotent — second call is a no-op on already-interpolated strings', () => {
        process.env.__TEST_VAR = 'one'
        const manifest = { x: '${__TEST_VAR}' }
        interpolateManifest(manifest)
        expect(manifest.x).toBe('one')
        interpolateManifest(manifest)
        expect(manifest.x).toBe('one')
    })

    it('preserves non-string types (numbers, booleans, null)', () => {
        const manifest = { count: 42, enabled: true, missing: null }
        interpolateManifest(manifest)
        expect(manifest).toEqual({ count: 42, enabled: true, missing: null })
    })

    it('handles deeply nested per-source Appwrite credentials', () => {
        process.env.__TEST_TOKEN = 'override-key'
        const manifest = {
            appwrite: { projectId: 'global', endpoint: 'https://e' },
            data: {
                projects: {
                    appwriteDatabaseId: 'db1',
                    appwriteTableId: 't1',
                    appwriteDevKey: '${__TEST_TOKEN}',
                },
            },
        }
        interpolateManifest(manifest)
        expect(manifest.data.projects.appwriteDevKey).toBe('override-key')
    })
})
