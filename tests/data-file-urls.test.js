/**
 * @vitest-environment happy-dom
 *
 * $openUrl / $openPreview / $openDownload and $thumbnailUrl open the SDK's URL as-is: no admin-mode suffix.
 */
import { readFileSync, readdirSync, statSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(dir, '../src/scripts/data')
const manifest = { data: { bucket: { appwriteBucketId: 'bid' } } }

let handle
beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    window.ManifestDataConfig = {
        ensureManifest: async () => manifest,
        isAppwriteCollection: () => true,
        getAppwriteConfig: async () => ({ databaseId: 'db' }),
        getAppwriteTableId: () => null,
        getAppwriteBucketId: (d) => d.appwriteBucketId || null,
        getScope: () => null,
        getScopeColumns: () => ({}),
    }
    window.ManifestDataAppwrite = {
        getFileURL: async (b, id) => `https://cloud.test/v1/storage/buckets/${b}/files/${id}/view?project=p`,
        getFilePreview: async (b, id) => `https://cloud.test/v1/storage/buckets/${b}/files/${id}/preview?project=p&width=800`,
        getFileDownload: async (b, id) => `https://cloud.test/v1/storage/buckets/${b}/files/${id}/download?project=p`,
    }
    new Function(readFileSync(path.join(DATA, 'shared/manifest.data.proxies.appwrite.js'), 'utf8'))()
    handle = window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('bucket', () => {})
})

describe('opened file URLs', () => {
    it('$openUrl and $openPreview open the SDK URL unchanged', async () => {
        const open = vi.spyOn(window, 'open').mockImplementation(() => null)
        await handle('$openUrl', 'f1')
        await handle('$openPreview', 'f1', 800)
        expect(open.mock.calls.map(c => c[0])).toEqual([
            'https://cloud.test/v1/storage/buckets/bid/files/f1/view?project=p',
            'https://cloud.test/v1/storage/buckets/bid/files/f1/preview?project=p&width=800',
        ])
        open.mockRestore()
    })

    it('$openDownload links the SDK URL unchanged', async () => {
        const url = await handle('$openDownload', 'f1', 'a.txt')
        expect(url).toBe('https://cloud.test/v1/storage/buckets/bid/files/f1/download?project=p')
    })

    it('no data subscript appends admin mode', () => {
        const walk = (d) => readdirSync(d).flatMap(f => statSync(path.join(d, f)).isDirectory() ? walk(path.join(d, f)) : [path.join(d, f)])
        const hits = walk(DATA).filter(f => readFileSync(f, 'utf8').includes('mode=admin'))
        expect(hits.map(f => path.relative(DATA, f))).toEqual([])
    })
})
