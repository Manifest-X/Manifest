/**
 * @vitest-environment happy-dom
 *
 * ManifestDataConfig.getManifest: the synchronous accessor table $upload and $files read
 * storage config through. Real config, no stubs.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.join(dir, '../src/scripts/data', f), 'utf8')
const CONFIG = read('core/manifest.data.config.js')
const FILES = read('shared/manifest.data.proxies.files.js')

const manifest = {
    data: {
        posts: { appwriteTableId: 'posts', storage: { media: 'fileIds' } },
        multi: { appwriteTableId: 'multi', storage: { media: 'fileIds', docs: 'docIds' } },
        media: { appwriteBucketId: 'media-bucket' },
        docs: { appwriteBucketId: 'docs-bucket' },
    },
}

const loadConfig = () => new Function(CONFIG)()

beforeEach(() => {
    delete window.ManifestComponentsRegistry
    delete window.__manifestLoaded
    delete window.__manifestPromise
    delete window.ManifestDataConfig
    delete window.ManifestDataProxiesFiles
})

afterEach(() => vi.unstubAllGlobals())

describe('getManifest', () => {
    it('is exported as a function', () => {
        loadConfig()
        expect(typeof window.ManifestDataConfig.getManifest).toBe('function')
    })

    it('returns null before any manifest is loaded', () => {
        loadConfig()
        expect(window.ManifestDataConfig.getManifest()).toBe(null)
    })

    it('returns the loader manifest', () => {
        window.ManifestComponentsRegistry = { manifest }
        loadConfig()
        expect(window.ManifestDataConfig.getManifest()).toBe(manifest)
    })

    it('ignores an incomplete __manifestLoaded stub', () => {
        window.__manifestLoaded = { foo: 1 }
        loadConfig()
        expect(window.ManifestDataConfig.getManifest()).toBe(null)
    })

    it('returns the manifest ensureManifest fetched without a loader', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ json: async () => JSON.parse(JSON.stringify(manifest)) })))
        loadConfig()
        const fetched = await window.ManifestDataConfig.ensureManifest()
        expect(window.ManifestDataConfig.getManifest()).toBe(fetched)
        expect(fetch).toHaveBeenCalledTimes(1)
    })
})

describe('table $upload storage resolution', () => {
    beforeEach(() => {
        window.ManifestComponentsRegistry = { manifest }
        loadConfig()
        new Function(FILES)()
    })

    it('resolves the single bucket as the default', () => {
        expect(window.ManifestDataProxiesFiles.getDefaultBucketForTable('posts')).toBe('media')
    })

    it('needs a bucket name when several are configured', () => {
        expect(window.ManifestDataProxiesFiles.getDefaultBucketForTable('multi')).toBe(null)
    })

    it('parses a bucket reference', () => {
        expect(window.ManifestDataProxiesFiles.parseStorageConfig(manifest.data.posts, 'media'))
            .toEqual({ bucketId: 'media-bucket', scope: null, column: 'fileIds' })
    })
})
