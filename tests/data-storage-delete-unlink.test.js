// @vitest-environment happy-dom
/**
 * Bucket $delete / $remove: unlink table links only after the server deleted the
 * file, per id for arrays, across mapped link columns; partial array failures land
 * the successes; both methods update the source locally, never by relisting.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, afterEach } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'
import { isolateVm } from './helpers/vm-isolation.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(__dirname, '../src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.config.js',
    'appwrite/manifest.data.queries.js',
    'core/manifest.data.store.js',
    'shared/manifest.data.mutations.js',
    'shared/manifest.data.proxies.core.js',
    'shared/manifest.data.proxies.cache.js',
    'shared/proxies/creation/manifest.data.proxies.helpers.js',
    'shared/proxies/creation/manifest.data.proxies.array.js',
    'shared/proxies/creation/manifest.data.proxies.route.js',
    'shared/manifest.data.proxies.files.js',
    'shared/manifest.data.proxies.appwrite.js',
    'shared/manifest.data.proxies.magic.state.js',
    'shared/manifest.data.proxies.magic.core.js',
    'shared/manifest.data.main.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
let iso = null

afterEach(() => {
    iso?.release()
    iso = null
})

// Server: one bucket of files, one table whose rows link them in several columns
async function load({ data = {}, rows, files = ['a', 'b', 'c'], failDelete = [] } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', { _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, currentTeam: null, teams: [] })
    window.__manifestRenderReady = false

    const server = {
        files: files.map($id => ({ $id })),
        rows: new Map((rows || []).map(r => [r.$id, JSON.parse(JSON.stringify(r))])),
        listings: 0,
        updates: [],
        deletes: [],
    }
    const manifest = {
        appwrite: { projectId: 'p', endpoint: 'e', databaseId: 'db' },
        data: {
            projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db' },
            files: { appwriteBucketId: 'files' },
            ...data,
        }
    }
    window.ManifestDataAppwrite = {
        loadTableRows: async () => [...server.rows.values()].map(r => JSON.parse(JSON.stringify(r))),
        listBucketFiles: async () => { server.listings++; return server.files.map(f => ({ ...f })) },
        getTableRow: async (db, table, id) => JSON.parse(JSON.stringify(server.rows.get(id))),
        updateRow: async (db, table, id, patch) => {
            server.updates.push({ id, patch })
            Object.assign(server.rows.get(id), patch)
            return { $id: id, ...server.rows.get(id) }
        },
        deleteFile: async (bucket, id) => {
            await settle(5)
            server.deletes.push(id)
            if (failDelete.includes(id)) throw new Error(`denied ${id}`)
            server.files = server.files.filter(f => f.$id !== id)
            return {}
        },
    }
    delete window.ManifestDataRealtime
    window.ManifestComponentsRegistry = { manifest }

    iso = isolateVm()
    const ctx = {
        window, document, Alpine, console, ...iso.timers, clearTimeout, clearInterval,
        requestAnimationFrame: cb => window.requestAnimationFrame(cb),
        cancelAnimationFrame: id => window.cancelAnimationFrame(id),
        CustomEvent: window.CustomEvent, Event: window.Event, location: window.location, history: window.history,
        File: window.File, Blob: window.Blob, queueMicrotask,
    }
    vm.createContext(ctx)
    for (const [name, src] of SUBSCRIPTS) vm.runInContext(src, ctx, { filename: name })
    for (let i = 0; i < 50 && !Alpine.store('data')?._ready; i++) await settle(5)
    await settle(200)

    await window.ManifestDataMain.loadDataSource('files')
    if (rows) await window.ManifestDataMain.loadDataSource('projects')
    await settle(60)
    server.listings = 0
    return server
}

const fileIds = () => Array.from(Alpine.store('data').files ?? []).map(r => r.$id)
const row = id => Array.from(Alpine.store('data').projects ?? []).find(r => r.$id === id)
const call = (method, arg) => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('files', () => {})(method, arg)
const quiet = async fn => {
    const err = console.error, warn = console.warn
    console.error = () => {}; console.warn = () => {}
    try { return await fn() } finally { console.error = err; console.warn = warn }
}

describe.each(['$delete', '$remove'])('bucket %s', (method) => {
    it('a failed delete keeps the file and its links', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }], failDelete: ['a'] })
        await expect(quiet(() => call(method, 'a'))).rejects.toThrow('denied a')
        await settle(60)
        expect(server.updates).toEqual([])
        expect(server.rows.get('p1').fileIds).toEqual(['a', 'b'])
        expect(row('p1').fileIds).toEqual(['a', 'b'])
        expect(fileIds()).toEqual(['a', 'b', 'c'])
    })

    it('unlinks after the server deleted the file', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }] })
        const order = []
        const del = window.ManifestDataAppwrite.deleteFile, upd = window.ManifestDataAppwrite.updateRow
        window.ManifestDataAppwrite.deleteFile = async (...a) => { const r = await del(...a); order.push('delete'); return r }
        window.ManifestDataAppwrite.updateRow = async (...a) => { order.push('unlink'); return upd(...a) }
        await call(method, 'a')
        await settle(60)
        expect(order).toEqual(['delete', 'unlink'])
        expect(server.rows.get('p1').fileIds).toEqual(['b'])
        expect(row('p1').fileIds).toEqual(['b'])
    })

    it('an array unlinks every id', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b', 'c'] }, { $id: 'p2', fileIds: ['c'] }] })
        await call(method, ['a', { $id: 'c' }])
        await settle(60)
        expect(server.rows.get('p1').fileIds).toEqual(['b'])
        expect(server.rows.get('p2').fileIds).toEqual([])
        expect(fileIds()).toEqual(['b'])
    })

    it('unlinks from mapped link columns (storage string, storage object, belongsTo)', async () => {
        const server = await load({
            data: {
                projects: {
                    appwriteTableId: 'projects', appwriteDatabaseId: 'db',
                    storage: { files: 'imageIds', covers: { appwriteBucketId: 'files', column: 'coverIds' }, other: { appwriteBucketId: 'elsewhere', column: 'otherIds' } }
                },
                attachments: { appwriteBucketId: 'files', belongsTo: { table: 'projects', id: 'p1', fileIdsColumn: 'attachmentIds' } },
            },
            rows: [{ $id: 'p1', fileIds: ['a'], imageIds: ['a', 'b'], coverIds: ['a'], attachmentIds: ['a'], otherIds: ['a'] }]
        })
        await call(method, 'a')
        await settle(60)
        const p1 = server.rows.get('p1')
        expect(p1.fileIds).toEqual([])
        expect(p1.imageIds).toEqual(['b'])
        expect(p1.coverIds).toEqual([])
        expect(p1.attachmentIds).toEqual([])
        expect(p1.otherIds).toEqual(['a'])
    })

    it('a partial array failure lands the deletes the server made and unlinks only those', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }], failDelete: ['b'] })
        await expect(quiet(() => call(method, ['a', 'b']))).rejects.toThrow('denied b')
        await settle(60)
        expect(server.deletes.sort()).toEqual(['a', 'b'])
        expect(fileIds()).toEqual(['b', 'c'])
        expect(server.rows.get('p1').fileIds).toEqual(['b'])
    })

    it('updates the source locally, never by relisting', async () => {
        const server = await load()
        const deleted = []
        window.addEventListener('manifest:file-deleted', e => { if (e.detail.bucketId) deleted.push(e.detail.fileId) })
        await call(method, ['a', 'b'])
        await settle(60)
        expect(fileIds()).toEqual(['c'])
        expect(server.listings).toBe(0)
        expect(deleted).toEqual(['a', 'b'])
    })
})

describe('bucket delete return values', () => {
    it('a single id returns its result, an array returns one per id, an empty array is a no-op', async () => {
        const server = await load()
        expect(await call('$delete', 'a')).toEqual({})
        expect(await call('$remove', ['b', 'c'])).toEqual([{}, {}])
        expect(await call('$remove', [])).toEqual([])
        expect(server.deletes).toEqual(['a', 'b', 'c'])
    })
})
