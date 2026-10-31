/**
 * @vitest-environment happy-dom
 *
 * Alpine.magic(name, callback) only writes, so calling it with one argument as a getter
 * overwrites the magic with undefined and every later `$name` throws.
 */
import { readFileSync, readdirSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.join(dir, '../src/scripts')
const read = (f) => readFileSync(path.join(SCRIPTS, f), 'utf8')
const load = (f) => new Function(read(f))()
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setTimeout(r, 0)) }

const xIntact = () => expect(Alpine.evaluate(document.body, '$x.a')).toBe(1)

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
})

beforeEach(() => {
    Alpine.magic('x', () => ({ a: 1 }))
})

describe('source scan', () => {
    it('has no one-argument Alpine.magic call', () => {
        const pattern = /\.magic(\?\.)?\(\s*(['"`][^'"`]*['"`]|[\w$.]+)\s*\)/g
        const hits = readdirSync(SCRIPTS, { recursive: true })
            .filter(f => f.endsWith('.js') && !f.endsWith('.min.js'))
            .flatMap(f => {
                const src = read(f)
                return [...src.matchAll(pattern)].map(m => `${f}:${src.slice(0, m.index).split('\n').length}`)
            })
        expect(hits).toEqual([])
    })
})

describe('auth: $x. team default names', () => {
    it('resolves from the data store and leaves $x alone', async () => {
        Alpine.store('data', { brand: { team: 'Acme' } })
        load('auth/manifest.appwrite.auth.teams.defaults.js')
        const { resolvePersonalTeamName } = window.ManifestAppwriteAuthTeamsDefaults
        expect(await resolvePersonalTeamName('$x.brand.team')).toBe('Acme')
        expect(await resolvePersonalTeamName('$x.missing.team')).toBe(null)
        xIntact()
    })
})

describe('export: source without window.$x', () => {
    let blobs
    beforeAll(async () => {
        load('manifest.export.js')
        await settle()
    })
    beforeEach(() => {
        blobs = []
        URL.createObjectURL = (b) => { blobs.push(b); return 'blob:x' }
        URL.revokeObjectURL = () => {}
        delete window.$x
    })

    it('reads the $x magic without overwriting it', async () => {
        Alpine.magic('x', () => ({ a: 1, rows: [{ id: 7 }] }))
        await Alpine.evaluate(document.body, "$export({ format: 'json', source: 'rows' })")
        await settle()
        expect(blobs).toHaveLength(1)
        expect(JSON.parse(await blobs[0].text())).toEqual([{ id: 7 }])
        xIntact()
    })
})

describe('window.$x getter', () => {
    afterEach(() => { delete window.$x })

    it('does not touch the magic before the proxy factory exists', () => {
        load('data/shared/manifest.data.proxies.magic.core.js')
        delete window._$xProxyFactory
        expect(window.$x).toBeTruthy()
        xIntact()
    })
})

describe('$upload', () => {
    let createFile
    beforeEach(() => {
        createFile = vi.fn(async (bucketId, fileId) => ({ $id: fileId }))
        window.ManifestDataAppwrite = { createFile, getTableRow: async () => ({ fileIds: [] }) }
        window.ManifestDataConfig = {
            ensureManifest: async () => ({ data: { t: { storage: { bucket: 'fileIds' } }, bucket: { appwriteBucketId: 'bid' } } }),
            isAppwriteCollection: () => true,
            getAppwriteConfig: async () => ({ databaseId: 'db' }),
            getAppwriteTableId: (d) => (d.storage ? 'tid' : null),
            getAppwriteBucketId: (d) => d.appwriteBucketId || null,
            getScope: () => null,
            getScopeColumns: () => ({}),
        }
        window.ManifestDataProxiesFiles = {
            parseStorageConfig: () => ({ column: 'fileIds' }),
            linkFileToEntry: vi.fn(async () => {}),
        }
        window.ManifestDataMutations = { addEntryToStore: () => {}, removeEntryFromStore: () => {} }
        // Bundle-scope sibling of the subscript loaded alone here
        globalThis.clearAccessCache = () => {}
        Alpine.store('data', {})
        load('data/shared/manifest.data.proxies.appwrite.js')
        load('data/shared/manifest.data.proxies.magic.upload.js')
    })

    it('uploads to a bucket no expression has read, leaving $x alone', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const upload = window.ManifestDataProxiesMagic.createUploadMethod('t', () => {})
        const file = new Blob(['x'])
        const result = await upload('e1', file, 'bucket')
        warn.mockRestore()
        expect(createFile).toHaveBeenCalledOnce()
        const [bucketId, fileId, sent, , onProgress] = createFile.mock.calls[0]
        expect(bucketId).toBe('bid')
        expect(sent).toBe(file)
        expect(onProgress).toBeUndefined()
        expect(result).toEqual({ $id: fileId })
        xIntact()
    })

    it('loads an unread bucket before writing to it', async () => {
        const order = []
        createFile.mockImplementation(async (b, id) => { order.push('create'); return { $id: id } })
        const reload = vi.fn(async () => { order.push('load') })
        await window.ManifestDataProxiesMagic.createUploadMethod('t', reload)('e1', new Blob(['x']), 'bucket')
        expect(reload).toHaveBeenCalledWith('bucket')
        expect(order).toEqual(['load', 'create'])
    })

    it('skips that load once the bucket is in the store', async () => {
        window.ManifestDataStore = { getRawData: () => [] }
        const reload = vi.fn(async () => {})
        await window.ManifestDataProxiesMagic.createUploadMethod('t', reload)('e1', new Blob(['x']), 'bucket')
        delete window.ManifestDataStore
        expect(reload).not.toHaveBeenCalled()
        expect(createFile).toHaveBeenCalledOnce()
    })

    it('still uploads when the first load resolves empty', async () => {
        const reload = vi.fn(async () => null)
        await window.ManifestDataProxiesMagic.createUploadMethod('t', reload)('e1', new Blob(['x']), 'bucket')
        expect(createFile).toHaveBeenCalledOnce()
    })
})

describe('x-markdown pre-registration path', () => {
    beforeEach(() => {
        globalThis.marked = { use() {}, setOptions() {}, parse: (md) => `<p>${md}</p>` }
        document.body.innerHTML = ''
    })
    afterEach(() => { delete window._$xProxyFactory })

    it('leaves $x alone and inits as soon as the data proxy is registered', async () => {
        window._$xProxyFactory = () => ({})
        const initTree = vi.spyOn(Alpine, 'initTree').mockImplementation(() => {})
        const el = document.createElement('div')
        el.setAttribute('x-markdown', "'# Hello'")
        document.body.appendChild(el)
        new Function(read('manifest.markdown.js'))()
        await settle()
        await new Promise(r => setTimeout(r, 30))
        const inited = initTree.mock.calls.length
        initTree.mockRestore()
        expect(el.innerHTML).toContain('# Hello')
        expect(inited).toBeGreaterThan(0)
        xIntact()
    })
})

describe('$files(getter) manager', () => {
    let listFiles, row, manager
    const key = 't:e1:bucket'
    const make = () => window.ManifestDataProxiesFiles.createReactiveFileManager('t', 'e1', 'bucket', 'fileIds')

    beforeAll(() => {
        window.ManifestDataConfig = {
            ensureManifest: async () => ({ data: { t: { storage: { bucket: { appwriteBucketId: 'bid', column: 'fileIds' } } } } }),
            getAppwriteTableId: () => 'tid',
            getAppwriteBucketId: () => 'bid',
            getAppwriteConfig: async () => ({ databaseId: 'db' }),
            getScope: () => null,
        }
        load('data/shared/manifest.data.proxies.files.js')
    })

    beforeEach(() => {
        row = { $id: 'e1', title: 'one', fileIds: ['f1'] }
        Alpine.store('data', { t: [row] })
        listFiles = vi.fn(async () => ({ files: [{ $id: 'f1' }, { $id: 'f2' }] }))
        window.ManifestDataAppwrite = {
            getTableRow: async () => Alpine.store('data').t[0],
            _getAppwriteDataServices: async () => ({ storage: { listFiles } }),
        }
    })

    afterEach(() => {
        manager?.destroy()
        window.ManifestDataProxiesFiles.reactiveFileManagers.delete(key)
    })

    it('leaves $x alone', async () => {
        manager = make()
        await settle()
        xIntact()
    })

    it('reloads when the entry fileIds change in the store', async () => {
        manager = make()
        await settle()
        expect(manager.files.map(f => f.$id)).toEqual(['f1'])
        Alpine.store('data').t[0].fileIds = ['f1', 'f2']
        await settle()
        expect(manager.files.map(f => f.$id)).toEqual(['f1', 'f2'])
    })

    it('reloads on manifest:file-created for a linked file only', async () => {
        manager = make()
        await settle()
        const before = listFiles.mock.calls.length
        window.dispatchEvent(new CustomEvent('manifest:file-created', { detail: { fileId: 'other' } }))
        await new Promise(r => requestAnimationFrame(r))
        await settle()
        expect(listFiles.mock.calls.length).toBe(before)
        window.dispatchEvent(new CustomEvent('manifest:file-created', { detail: { fileId: 'f1' } }))
        await new Promise(r => requestAnimationFrame(r))
        await settle()
        expect(listFiles.mock.calls.length).toBeGreaterThan(before)
    })

    it('does not loop on a fileId the bucket no longer lists', async () => {
        Alpine.store('data').t[0].fileIds = ['f1', 'gone']
        manager = make()
        await settle(100)
        expect(manager.files.map(f => f.$id)).toEqual(['f1'])
        const calls = listFiles.mock.calls.length
        expect(calls).toBeGreaterThan(0)
        expect(calls).toBeLessThanOrEqual(3)
        await settle(100)
        expect(listFiles.mock.calls.length).toBe(calls)
    })

    it('reloads when asked during a load that read an older row', async () => {
        manager = make()
        await settle()
        const server = { fileIds: ['f1'] }
        const pending = []
        window.ManifestDataAppwrite.getTableRow = () => {
            const snapshot = { fileIds: [...server.fileIds] }
            return new Promise(r => pending.push(() => r(snapshot)))
        }
        const flush = async () => { while (pending.length) pending.shift()(); await settle() }

        // Store updates optimistically; the server has not committed yet
        Alpine.store('data').t[0].fileIds = ['f1', 'f2']
        await settle()
        pending.shift()()
        await settle()

        // Commit lands, and its update event arrives while a load is in flight
        expect(pending.length).toBe(1)
        server.fileIds = ['f1', 'f2']
        window.dispatchEvent(new CustomEvent('manifest:project-files-updated', { detail: { tableName: 't', entryId: 'e1' } }))
        await new Promise(r => requestAnimationFrame(r))
        await settle()
        const stale = pending.shift()
        stale()
        await settle()
        for (let i = 0; i < 5 && pending.length; i++) await flush()
        expect(manager.files.map(f => f.$id)).toEqual(['f1', 'f2'])
    })

    it('stops when a stale-id unlink keeps failing and rolling back', async () => {
        const F = window.ManifestDataProxiesFiles
        const unlink = F.unlinkFileFromEntry
        const row = Alpine.store('data').t[0]
        row.fileIds = ['f1', 'gone']
        listFiles.mockImplementation(async () => ({ files: [{ $id: 'f1' }] }))
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices()
        services.storage.getFile = async () => { throw Object.assign(new Error('not found'), { code: 404 }) }
        window.ManifestDataAppwrite._getAppwriteDataServices = async () => services
        F.unlinkFileFromEntry = async () => {
            Alpine.store('data').t[0].fileIds = ['f1']
            await settle(2)
            Alpine.store('data').t[0].fileIds = ['f1', 'gone']
            throw new Error('denied')
        }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            manager = make()
            await settle(200)
            const calls = listFiles.mock.calls.length
            await settle(200)
            expect(listFiles.mock.calls.length).toBe(calls)
            expect(calls).toBeLessThanOrEqual(4)
        } finally {
            F.unlinkFileFromEntry = unlink
            warn.mockRestore()
            err.mockRestore()
        }
    })

    it('stops when unlinks of several stale ids keep failing', async () => {
        const F = window.ManifestDataProxiesFiles
        const unlink = F.unlinkFileFromEntry
        const original = ['f1', 'g1', 'g2']
        Alpine.store('data').t[0].fileIds = [...original]
        listFiles.mockImplementation(async () => ({ files: [{ $id: 'f1' }] }))
        const services = await window.ManifestDataAppwrite._getAppwriteDataServices()
        services.storage.getFile = async () => { throw Object.assign(new Error('not found'), { code: 404 }) }
        window.ManifestDataAppwrite._getAppwriteDataServices = async () => services
        // Parallel unlinks land in varying order, so each load shows a different intermediate value
        F.unlinkFileFromEntry = async () => {
            const id = original[1 + (listFiles.mock.calls.length % 2)]
            Alpine.store('data').t[0].fileIds = original.filter(x => x !== id)
            await settle(2)
            Alpine.store('data').t[0].fileIds = [...original]
            throw new Error('denied')
        }
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const err = vi.spyOn(console, 'error').mockImplementation(() => {})
        try {
            manager = make()
            await settle(200)
            const calls = listFiles.mock.calls.length
            await settle(200)
            expect(listFiles.mock.calls.length).toBe(calls)
            expect(calls).toBeLessThanOrEqual(4)
        } finally {
            F.unlinkFileFromEntry = unlink
            warn.mockRestore()
            err.mockRestore()
        }
    })

    it('makes one load when created', async () => {
        manager = make()
        await settle()
        expect(listFiles.mock.calls.length).toBe(1)
    })

    it('does not reload for an unrelated row edit', async () => {
        manager = make()
        await settle()
        const calls = listFiles.mock.calls.length
        Alpine.store('data').t[0].title = 'two'
        await settle()
        expect(listFiles.mock.calls.length).toBe(calls)
    })
})
