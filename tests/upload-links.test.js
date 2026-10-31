/**
 * @vitest-environment happy-dom
 *
 * $upload: parallel links to one entry must all reach the server, and a first load that
 * fails must stay visible and leave the source loadable.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const load = (f) => new Function(readFileSync(path.join(dir, '../src/scripts/data/shared', f), 'utf8'))()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let server, updates, createFile, addEntry
const manifest = { data: { t: { storage: { bucket: 'fileIds' } }, bucket: { appwriteBucketId: 'bid' } } }

beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    globalThis.clearAccessCache = () => {}
    window.ManifestDataConfig = {
        ensureManifest: async () => manifest,
        getManifest: () => manifest,
        isAppwriteCollection: () => true,
        getAppwriteConfig: async () => ({ databaseId: 'db' }),
        getAppwriteTableId: (d) => (d.storage ? 'tid' : null),
        getAppwriteBucketId: (d) => d.appwriteBucketId || null,
        getScope: () => null,
        getScopeColumns: () => ({}),
    }
    load('manifest.data.proxies.files.js')
    load('manifest.data.proxies.appwrite.js')
    load('manifest.data.proxies.magic.upload.js')
})

beforeEach(() => {
    server = { fileIds: ['f1'] }
    updates = []
    Alpine.store('data', {})
    delete Alpine.store('data').t
    delete Alpine.store('data').bucket
    delete Alpine.store('data')._bucket_state
    createFile = vi.fn(async (b, id) => ({ $id: id, name: 'n' }))
    addEntry = vi.fn(() => true)
    window.ManifestDataAppwrite = {
        createFile,
        getTableRow: async () => { await sleep(1); return { $id: 'e1', fileIds: [...server.fileIds] } },
        updateRow: async (db, t, id, patch) => {
            const value = [...patch.fileIds]
            updates.push(value)
            // Earlier writes land later, unless they run one at a time
            await sleep(Math.max(1, 12 - updates.length * 4))
            server.fileIds = value
            return value
        },
    }
    window.ManifestDataMutations = {
        addEntryToStore: addEntry,
        removeEntryFromStore: () => true,
        executeMutation: () => {},
        updateEntryInStore: (t, id, patch) => {
            const row = Alpine.store('data')[t]?.find(r => r.$id === id)
            if (row) Object.assign(row, patch)
        },
    }
    delete window.ManifestDataStore
})

const link = (id) => window.ManifestDataProxiesFiles.linkFileToEntry('t', 'e1', id, 'fileIds')
const unlink = (id) => window.ManifestDataProxiesFiles.unlinkFileFromEntry('t', 'e1', id, 'fileIds')

describe('links to one entry', () => {
    it('keeps every link when the row is not in the store', async () => {
        await Promise.all(['a', 'b', 'c'].map(link))
        expect(server.fileIds.sort()).toEqual(['a', 'b', 'c', 'f1'])
    })

    it('keeps every link when writes would land out of order', async () => {
        Alpine.store('data').t = [{ $id: 'e1', fileIds: ['f1'] }]
        await Promise.all(['a', 'b', 'c'].map(link))
        expect(server.fileIds.sort()).toEqual(['a', 'b', 'c', 'f1'])
        expect([...Alpine.store('data').t[0].fileIds].sort()).toEqual(['a', 'b', 'c', 'f1'])
    })

    it('keeps a link and an unlink made together', async () => {
        await Promise.all([link('a'), unlink('f1')])
        expect(server.fileIds).toEqual(['a'])
    })

    it('still runs the next link after one fails, and reports the failure', async () => {
        const update = window.ManifestDataAppwrite.updateRow
        window.ManifestDataAppwrite.updateRow = async () => { throw new Error('denied') }
        await expect(link('a')).rejects.toThrow('denied')
        window.ManifestDataAppwrite.updateRow = update
        await link('b')
        expect(server.fileIds).toEqual(['f1', 'b'])
    })

    it('keeps every link when a late echo moves the store back between writes', async () => {
        Alpine.store('data').t = [{ $id: 'e1', fileIds: ['f1'] }]
        const update = window.ManifestDataAppwrite.updateRow
        let previous = ['f1']
        window.ManifestDataAppwrite.updateRow = async (...args) => {
            const landed = await update(...args)
            Alpine.store('data').t[0].fileIds = [...previous]
            previous = landed
            return landed
        }
        await Promise.all(['a', 'b', 'c'].map(link))
        expect(server.fileIds.sort()).toEqual(['a', 'b', 'c', 'f1'])
    })

    it('does not make different entries wait on each other', async () => {
        const F = window.ManifestDataProxiesFiles
        window.ManifestDataAppwrite.getTableRow = async (d, t, id) => {
            if (id === 'slow') await new Promise(() => {})
            return { $id: id, fileIds: [] }
        }
        F.linkFileToEntry('t', 'slow', 'x', 'fileIds')
        await expect(F.linkFileToEntry('t', 'quick', 'y', 'fileIds')).resolves.toBeUndefined()
    })
})

describe('$upload to an unread bucket', () => {
    const upload = (reload, file = new Blob(['x'])) => window.ManifestDataProxiesMagic.createUploadMethod('t', reload)('e1', file, 'bucket')
    const stubStore = (raw) => {
        window.ManifestDataStore = {
            getRawData: () => raw(),
            setUploadingFile: vi.fn(),
            clearUploadingFile: vi.fn(),
        }
        return window.ManifestDataStore
    }

    it('keeps a failed first load visible and writes no store row, and still uploads and links', async () => {
        stubStore(() => null)
        const reload = vi.fn(async () => {
            Alpine.store('data')._bucket_state = { loading: false, error: 'list failed', ready: false, errorTime: 1 }
            return null
        })
        const result = await upload(reload)
        expect(createFile).toHaveBeenCalledOnce()
        expect(result.$id).toBe(createFile.mock.calls[0][1])
        expect(addEntry).not.toHaveBeenCalled()
        expect(reload).toHaveBeenCalledOnce()
        expect(Alpine.store('data')._bucket_state.error).toBe('list failed')
        expect(server.fileIds).toEqual(['f1', result.$id])
    })

    it('adds the row when the source lands during the upload, without its file', async () => {
        let raw = null
        stubStore(() => raw)
        createFile.mockImplementation(async (b, id) => { raw = [{ $id: 'old' }]; return { $id: id, name: 'n' } })
        const result = await upload(async () => null)
        expect(addEntry).toHaveBeenCalledOnce()
        expect(addEntry.mock.calls[0][1].$id).toBe(result.$id)
        expect(addEntry.mock.calls[0][2]).toHaveProperty('generation')
    })

    it('adds no second row when that list already had the file', async () => {
        let raw = null
        stubStore(() => raw)
        createFile.mockImplementation(async (b, id) => { raw = [{ $id: id }]; return { $id: id, name: 'n' } })
        await upload(async () => null)
        expect(addEntry).not.toHaveBeenCalled()
    })

    it('writes the store row once the first load landed', async () => {
        let raw = null
        stubStore(() => raw)
        await upload(async () => { raw = [] })
        expect(addEntry).toHaveBeenCalled()
    })

    it('marks files uploading before the first load, and clears them if it throws', async () => {
        const ds = stubStore(() => null)
        let markedDuringLoad = 0
        await upload(async () => { markedDuringLoad = ds.setUploadingFile.mock.calls.length; throw new Error('boom') }).catch(() => {})
        expect(markedDuringLoad).toBe(1)
        expect(ds.clearUploadingFile).toHaveBeenCalled()
        expect(createFile).not.toHaveBeenCalled()
    })
})
