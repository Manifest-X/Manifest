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
    'shared/manifest.data.proxies.magic.upload.js',
    'shared/manifest.data.main.js',
].map(f => [f, readFileSync(path.join(DATA, f), 'utf8')])

const settle = (ms = 20) => new Promise(r => setTimeout(r, ms))
let iso = null

afterEach(() => {
    iso?.release()
    iso = null
})

// Server: one bucket of files, one table whose rows link them in several columns
async function load({ data = {}, rows, files = ['a', 'b', 'c'], failDelete = [], delays = {}, loadRows = true } = {}) {
    window.Alpine = Alpine
    Alpine.store('auth', { _initialized: true, isAuthenticated: true, isAnonymous: false, user: { $id: 'u1' }, currentTeam: null, teams: [] })
    window.__manifestRenderReady = false

    const server = {
        files: files.map(f => typeof f === 'string' ? { $id: f } : f),
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
            await settle(delays[id] ?? 5)
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
    if (rows && loadRows) await window.ManifestDataMain.loadDataSource('projects')
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

describe('failed array deletes return in their original order', () => {
    it.each([
        ['first settles first', ['a', 'c'], { a: 5, c: 40 }],
        ['last settles first', ['a', 'c'], { a: 40, c: 5 }],
        ['adjacent, later id settles first', ['b', 'a'], { a: 40, b: 5 }],
        ['adjacent, earlier id settles first', ['b', 'a'], { a: 5, b: 40 }],
    ])('unsorted source: %s', async (label, ids, delays) => {
        await load({ files: ['a', 'b', 'c', 'd'], failDelete: ids, delays })
        await expect(quiet(() => call('$remove', ids))).rejects.toThrow('denied')
        await settle(60)
        expect(fileIds()).toEqual(['a', 'b', 'c', 'd'])
    })

    it('a table array $delete restores order too', async () => {
        await load({ rows: [{ $id: 'p1' }, { $id: 'p2' }, { $id: 'p3' }, { $id: 'p4' }] })
        window.ManifestDataAppwrite.deleteRow = async (db, table, id) => { await settle(id === 'p1' ? 5 : 40); throw new Error(`denied ${id}`) }
        const tableCall = window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('projects', () => {})
        await expect(quiet(() => tableCall('$delete', ['p1', 'p3']))).rejects.toThrow('denied')
        await settle(60)
        expect(Array.from(Alpine.store('data').projects).map(r => r.$id)).toEqual(['p1', 'p2', 'p3', 'p4'])
    })

    it('a sorted source re-sorts a returning row', async () => {
        window.Appwrite = { Query: { orderAsc: attr => JSON.stringify({ method: 'orderAsc', attribute: attr }) } }
        try {
            await load({
                data: { files: { appwriteBucketId: 'files', queries: [['orderAsc', 'name']] } },
                files: ['a', 'b', 'c', 'd'].map(id => ({ $id: id, name: id })),
                failDelete: ['a', 'c'], delays: { a: 5, c: 40 }
            })
            expect(window.ManifestDataMain.orderFor('files')).toBeTruthy()
            await expect(quiet(() => call('$remove', ['a', 'c']))).rejects.toThrow('denied')
            await settle(60)
            expect(fileIds()).toEqual(['a', 'b', 'c', 'd'])
        } finally {
            delete window.Appwrite
        }
    })
})

describe('the default fileIds column follows its owning bucket', () => {
    it("is not unlinked when the table maps it to another bucket", async () => {
        const server = await load({
            data: {
                projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', storage: { photos: { appwriteBucketId: 'other' }, files: 'docIds' } },
            },
            rows: [{ $id: 'p1', fileIds: ['a'], docIds: ['a'] }]
        })
        await call('$remove', 'a')
        await settle(60)
        expect(server.rows.get('p1').fileIds).toEqual(['a'])
        expect(server.rows.get('p1').docIds).toEqual([])
    })

    it('a mapping whose bucket cannot be resolved is skipped', async () => {
        const server = await load({
            data: {
                projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', storage: { missing: 'ghostIds', loose: { column: 'looseIds' } } },
            },
            rows: [{ $id: 'p1', fileIds: ['a'], ghostIds: ['a'], looseIds: ['a'] }]
        })
        await call('$remove', 'a')
        await settle(60)
        const p1 = server.rows.get('p1')
        expect(p1.ghostIds).toEqual(['a'])
        expect(p1.looseIds).toEqual(['a'])
        expect(p1.fileIds).toEqual([])
    })
})

describe('failed delete restores stay linear and release their snapshot', () => {
    it('a restore costs one pass over the source, however far its nearest neighbour is', async () => {
        await load()
        const { restoreIndex } = window.ManifestDataMutations
        const order = Array.from({ length: 10000 }, (_, i) => 'r' + i)
        const positions = new Map(order.map((id, i) => [id, i]))
        const arr = order.slice(1, 1000).concat(order.slice(9000)).map($id => ({ $id }))
        const t = Date.now()
        for (let k = 0; k < 50; k++) expect(restoreIndex(arr, positions, 'r' + (8999 - k), -1)).toBe(999)
        expect(Date.now() - t).toBeLessThan(1000)
        expect(restoreIndex(arr, positions, 'r0', -1)).toBe(0)
        expect(restoreIndex(arr, new Map(), 'x', 3)).toBe(3)
    })

    it('a failing array $remove restores 400 rows in order', async () => {
        const files = Array.from({ length: 1000 }, (_, i) => 'f' + i)
        const fail = files.slice(300, 700)
        await load({ files, failDelete: fail, delays: Object.fromEntries(fail.map(id => [id, 1])) })
        await quiet(() => call('$remove', [...fail].reverse()).catch(() => {}))
        await settle(60)
        expect(fileIds()).toEqual(files)
    }, 30000)

    it('a rollback that throws does not pin the order snapshot', async () => {
        await load({ files: ['a', 'b', 'c', 'd'], failDelete: ['b', 'c'] })
        const ds = window.ManifestDataStore
        const real = ds.createReactiveReferences
        ds.createReactiveReferences = () => { ds.createReactiveReferences = real; throw new Error('rollback broke') }
        await expect(quiet(() => call('$remove', 'b'))).rejects.toThrow()
        await ds.landRows('files', ['d', 'c', 'b', 'a'].map($id => ({ $id })), { mode: 'replace', generation: ds.sourceGeneration('files') })
        await settle(60)
        expect(fileIds()).toEqual(['d', 'c', 'b', 'a'])
        await expect(quiet(() => call('$remove', 'c'))).rejects.toThrow('denied c')
        await settle(60)
        expect(fileIds()).toEqual(['d', 'c', 'b', 'a'])
    })
})

describe.each(['$delete', '$remove'])('bucket %s across a sign-out', (method) => {
    const signOut = () => {
        Object.assign(Alpine.store('auth'), { isAuthenticated: false, user: null })
        window.dispatchEvent(new CustomEvent('manifest:auth:logout'))
    }

    it('skips the unlink when the user signed out during the delete', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }], delays: { a: 60 } })
        const done = call(method, 'a')
        await settle(15)
        signOut()
        await done
        await settle(120)
        expect(server.deletes).toEqual(['a'])
        expect(server.updates).toEqual([])
        expect(server.rows.get('p1').fileIds).toEqual(['a', 'b'])
    })

    it('skips the unlink when the user signed out while the unlink read its row', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }] })
        const getRow = window.ManifestDataAppwrite.getTableRow
        let reads = 0
        window.ManifestDataAppwrite.getTableRow = async (...a) => {
            reads++
            signOut()
            await settle(30)
            return getRow(...a)
        }
        await call(method, 'a')
        await settle(120)
        expect(reads).toBe(1)
        expect(server.updates).toEqual([])
        expect(server.rows.get('p1').fileIds).toEqual(['a', 'b'])
    })
})

describe('bucket delete input without a file id', () => {
    it.each([
        ['an object without $id', {}],
        ['an array holding one', ['a', {}]],
        ['an object with an empty $id', { $id: '' }],
    ])('%s is refused before any delete', async (label, input) => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a'] }] })
        for (const method of ['$delete', '$remove']) {
            await expect(call(method, input)).rejects.toThrow(`${method} requires file ID`)
        }
        await settle(60)
        expect(server.deletes).toEqual([])
        expect(server.updates).toEqual([])
        expect(fileIds()).toEqual(['a', 'b', 'c'])
    })
})

const callArgs = (method, args) => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('files', () => {})(method, ...args)

describe('link writes across a sign-out', () => {
    const signOut = () => {
        Object.assign(Alpine.store('auth'), { isAuthenticated: false, user: null })
        window.dispatchEvent(new CustomEvent('manifest:auth:logout'))
    }
    const signOutOnRead = () => {
        const getRow = window.ManifestDataAppwrite.getTableRow
        const reads = { n: 0 }
        window.ManifestDataAppwrite.getTableRow = async (...a) => {
            if (++reads.n === 1) { signOut(); await settle(30) }
            return getRow(...a)
        }
        return reads
    }

    it.each(['$unlinkFrom', '$removeFrom'])('%s skips the write when the user signed out while it read the row', async (method) => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }] })
        window.ManifestDataAppwrite._getAppwriteDataServices = async () => ({ storage: { listFiles: async () => ({ files: [] }) } })
        const reads = signOutOnRead()
        await quiet(() => callArgs(method, ['projects', 'p1', 'a']).catch(() => {}))
        await settle(120)
        expect(reads.n).toBeGreaterThanOrEqual(1)
        expect(server.updates).toEqual([])
        expect(server.rows.get('p1').fileIds).toEqual(['a', 'b'])
    })

    it.each(['$unlinkFrom', '$removeFrom'])('%s still unlinks for a steady identity', async (method) => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }] })
        window.ManifestDataAppwrite._getAppwriteDataServices = async () => ({ storage: { listFiles: async () => ({ files: [{ $id: 'b' }] }) } })
        await callArgs(method, ['projects', 'p1', { $id: 'a' }])
        await settle(60)
        expect(server.updates).toEqual([{ id: 'p1', patch: { fileIds: ['b'] } }])
    })

    it('a write queued behind another lands only for the identity that queued it', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b'] }] })
        const { unlinkFileFromEntry } = window.ManifestDataProxiesFiles
        const getRow = window.ManifestDataAppwrite.getTableRow
        window.ManifestDataAppwrite.getTableRow = async (...a) => { await settle(30); return getRow(...a) }
        const first = unlinkFileFromEntry('projects', 'p1', 'a')
        const second = unlinkFileFromEntry('projects', 'p1', 'b')
        await settle(5)
        await first
        signOut()
        await settle(5)
        await second
        await settle(60)
        expect(server.updates).toEqual([{ id: 'p1', patch: { fileIds: ['b'] } }])
    })

    const staleSetup = async ({ onMissing } = {}) => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'gone'] }] })
        window.ManifestDataAppwrite._getAppwriteDataServices = async () => ({
            storage: {
                listFiles: async () => ({ files: [{ $id: 'a' }] }),
                getFile: async () => {
                    onMissing?.()
                    await settle(30)
                    const err = new Error('File could not be found'); err.code = 404; throw err
                },
            }
        })
        return server
    }

    it('the stale-id cleanup unlinks a missing file for a steady identity', async () => {
        const server = await staleSetup()
        const files = await quiet(() => callArgs('$filesFor', ['projects', 'p1']))
        await settle(60)
        expect(files.map(f => f.$id)).toEqual(['a'])
        expect(server.updates).toEqual([{ id: 'p1', patch: { fileIds: ['a'] } }])
    })

    it('the stale-id cleanup is skipped when the user signed out during the check', async () => {
        const server = await staleSetup({ onMissing: signOut })
        await quiet(() => callArgs('$filesFor', ['projects', 'p1']))
        await settle(120)
        expect(server.updates).toEqual([])
        expect(server.rows.get('p1').fileIds).toEqual(['a', 'gone'])
    })
})

describe('link methods normalise file references', () => {
    it.each(['$unlinkFrom', '$removeFrom'])('%s refuses an object without $id', async (method) => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a'] }] })
        await expect(callArgs(method, ['projects', 'p1', {}])).rejects.toThrow(`${method} requires table name, entry ID, and file ID`)
        await expect(callArgs(method, ['projects', 'p1', { $id: '' }])).rejects.toThrow('file ID')
        expect(server.updates).toEqual([])
    })

    it('unlinkFileFromAllEntries takes ids and file objects, skipping ones without an id', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a', 'b', 'c'] }] })
        const affected = await window.ManifestDataProxiesFiles.unlinkFileFromAllEntries([{ $id: 'a' }, {}, null, 'c'])
        await settle(60)
        expect(affected).toEqual({ projects: ['p1'] })
        expect(server.rows.get('p1').fileIds).toEqual(['b'])
    })
})

describe('link writes across a sign-out', () => {
    const signOut = () => {
        Object.assign(Alpine.store('auth'), { isAuthenticated: false, user: null })
        window.dispatchEvent(new CustomEvent('manifest:auth:logout'))
    }
    const signOutOnRead = () => {
        const getRow = window.ManifestDataAppwrite.getTableRow
        const reads = { n: 0 }
        window.ManifestDataAppwrite.getTableRow = async (...a) => {
            if (++reads.n === 1) { signOut(); await settle(30) }
            return getRow(...a)
        }
        return reads
    }
    const link = (...a) => window.ManifestDataProxiesFiles.linkFileToEntry('projects', 'p1', ...a)
    const withStorage = { projects: { appwriteTableId: 'projects', appwriteDatabaseId: 'db', storage: { files: 'fileIds' } } }

    it('links for a steady identity', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a'] }] })
        await link('b')
        await settle(60)
        expect(server.updates).toEqual([{ id: 'p1', patch: { fileIds: ['a', 'b'] } }])
    })

    it('skips the write when the user signed out while it read the row', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a'] }] })
        const reads = signOutOnRead()
        await expect(link('b')).resolves.toBe(false)
        await settle(120)
        expect(reads.n).toBeGreaterThanOrEqual(1)
        expect(server.updates).toEqual([])
        expect(server.rows.get('p1').fileIds).toEqual(['a'])
    })

    it('skips the write for a table that was never loaded', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a'] }], loadRows: false })
        signOutOnRead()
        await link('b')
        await settle(120)
        expect(server.updates).toEqual([])
    })

    it('a link queued behind another lands only for the identity that queued it', async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: [] }] })
        const getRow = window.ManifestDataAppwrite.getTableRow
        window.ManifestDataAppwrite.getTableRow = async (...a) => { await settle(30); return getRow(...a) }
        const first = link('a')
        const second = link('b')
        await settle(5)
        await first
        signOut()
        await settle(5)
        await second
        await settle(60)
        expect(server.updates).toEqual([{ id: 'p1', patch: { fileIds: ['a'] } }])
    })

    const uploadSetup = async ({ signOutOnCreate = false } = {}) => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: [] }], data: withStorage })
        window.ManifestDataAppwrite.createFile = async (bucket, id) => {
            if (signOutOnCreate) { signOut(); await settle(30) }
            return { $id: id, name: 'n' }
        }
        return server
    }

    it('bucket $create links the upload for a steady identity', async () => {
        const server = await uploadSetup()
        await callArgs('$create', ['n1', new window.Blob(['x']), [], { entryId: 'p1', table: 'projects' }])
        await settle(60)
        expect(server.updates).toEqual([{ id: 'p1', patch: { fileIds: ['n1'] } }])
    })

    it('bucket $create skips the link when the user signed out during the upload', async () => {
        const server = await uploadSetup({ signOutOnCreate: true })
        await quiet(() => callArgs('$create', ['n1', new window.Blob(['x']), [], { entryId: 'p1', table: 'projects' }]).catch(() => {}))
        await settle(120)
        expect(server.updates).toEqual([])
    })

    it('table $upload skips the link when the user signed out before the upload started', async () => {
        const server = await uploadSetup()
        const ensure = window.ManifestDataConfig.ensureManifest
        let calls = 0
        window.ManifestDataConfig.ensureManifest = async () => {
            if (++calls === 1) { signOut(); await settle(30) }
            return ensure()
        }
        const create = window.ManifestDataAppwrite.createFile
        const created = []
        window.ManifestDataAppwrite.createFile = async (bucket, id, ...rest) => {
            created.push(bucket)
            return create(bucket, id, ...rest)
        }
        const upload = window.ManifestDataProxiesMagic.createUploadMethod('projects', () => {})
        let failure = null
        await quiet(() => upload('p1', new window.Blob(['x'])).catch(e => { failure = e }))
        await settle(120)
        window.ManifestDataConfig.ensureManifest = ensure
        expect(failure?.message ?? '').not.toMatch(/Storage bucket|Multiple storage buckets/)
        expect(created).toEqual(['files'])
        expect(server.updates).toEqual([])
    })

    it('table $upload links for a steady identity', async () => {
        const server = await uploadSetup()
        await window.ManifestDataProxiesMagic.createUploadMethod('projects', () => {})('p1', new window.Blob(['x']))
        await settle(60)
        expect(server.updates.length).toBe(1)
        expect(server.rows.get('p1').fileIds.length).toBe(1)
    })

    const duplicateSetup = async () => {
        const server = await load({ rows: [{ $id: 'p1', fileIds: ['a'] }], data: withStorage })
        server.creates = []
        window.ManifestDataAppwrite.createRow = async (db, table, data, id) => {
            const created = { ...data, $id: id || 'copy' }
            server.creates.push(created)
            return created
        }
        return server
    }
    const duplicate = () => window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler('projects', () => {})('$duplicate', 'p1')

    it('$duplicate copies the row and its file links for a steady identity', async () => {
        const server = await duplicateSetup()
        await quiet(() => duplicate())
        await settle(60)
        expect(server.creates.map(r => r.fileIds)).toEqual([['a']])
    })

    it('$duplicate creates nothing when the user signed out while it read the original', async () => {
        const server = await duplicateSetup()
        signOutOnRead()
        await expect(quiet(() => duplicate())).rejects.toThrow('signed-in user changed')
        await settle(120)
        expect(server.creates).toEqual([])
    })
})
