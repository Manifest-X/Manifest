/**
 * @vitest-environment happy-dom
 *
 * Contract checks on Appwrite rows: undeclared AND absent columns throw,
 * present data never does, and checks run only where enabled.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(__dirname, '../src/scripts/data/appwrite/manifest.data.contract.js'), 'utf8')
const CONTRACT = 'data:text/javascript,' + encodeURIComponent(`export const tables = {
  tasks: { database: 'main', id: 'tasks', columns: ['title', 'status'] },
  loose: { id: 'loose' }
}`)

let n = 0
async function fresh(contract, url = 'http://localhost:5000/') {
    window.happyDOM.setURL(url)
    window.__manifestLoaded = {
        contract,
        appwrite: { databaseId: 'main' },
        data: { tasks: { appwriteTableId: 'tasks' }, loose: { appwriteTableId: 'loose' }, other: { appwriteTableId: 'other' } }
    }
    delete window.ManifestDataContract
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(SRC + `\n// ${n++}`))
    return window.ManifestDataContract.guard
}
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => { vi.restoreAllMocks() })

describe('contract guard', () => {
    it('throws on an undeclared, absent column and passes everything real', async () => {
        const guard = await fresh(CONTRACT)
        const raw = { $id: 'a', title: 'T', status: 'open', _loadedFrom: 'x', contentType: 'row' }
        const row = guard('tasks', raw)
        await settle()
        expect(row.title).toBe('T')
        expect(row.$id).toBe('a')
        expect(row._loadedFrom).toBe('x')
        expect(row.$files).toBeUndefined()
        expect(row.then).toBeUndefined()
        expect(row.toString).toBeTypeOf('function')
        expect(() => row.stauts).toThrow('"stauts" is not a column of "tasks" in the contract (data source "tasks")')
        expect(JSON.parse(JSON.stringify(row))).toEqual(raw)
        row.status = 'done'
        expect(raw.status).toBe('done')
        expect({ ...row }.status).toBe('done')
    })

    it('keeps one proxy per row', async () => {
        const guard = await fresh(CONTRACT)
        const raw = { $id: 'a', title: 'T' }
        const row = guard('tasks', raw)
        expect(guard('tasks', raw)).toBe(row)
        expect(guard('tasks', row)).toBe(row)
        expect(window.ManifestDataContract.raw(row)).toBe(raw)
        expect(window.ManifestDataContract.raw(raw)).toBe(raw)
    })

    it('warns once per source about present columns the contract lacks, without throwing', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const guard = await fresh(CONTRACT)
        const a = guard('tasks', { $id: 'a', title: 'T', priority: 1 })
        const b = guard('tasks', { $id: 'b', title: 'U', priority: 2 })
        await settle()
        expect(a.priority).toBe(1)
        expect(b.priority).toBe(2)
        const drift = warn.mock.calls.filter((c) => String(c[0]).includes('"priority"'))
        expect(drift).toHaveLength(1)
    })

    it('leaves sources alone when the contract lists no columns or no table', async () => {
        const guard = await fresh(CONTRACT)
        const loose = guard('loose', { $id: 'a' })
        const other = guard('other', { $id: 'b' })
        await settle()
        expect(loose.anything).toBeUndefined()
        expect(other.anything).toBeUndefined()
    })

    it('is off on other hosts unless listed, and off everywhere with checks: false', async () => {
        let guard = await fresh(CONTRACT, 'https://app.example.com/')
        const raw = { $id: 'a' }
        expect(guard('tasks', raw)).toBe(raw)

        guard = await fresh({ module: CONTRACT, checks: ['*-staging.example.com'] }, 'https://app-staging.example.com/')
        const row = guard('tasks', { $id: 'a' })
        await settle()
        expect(() => row.nope).toThrow()

        guard = await fresh({ module: CONTRACT, checks: false }, 'http://localhost/')
        expect(guard('tasks', raw)).toBe(raw)
    })

    it('does nothing without a contract', async () => {
        const guard = await fresh(undefined)
        const raw = { $id: 'a' }
        expect(guard('tasks', raw)).toBe(raw)
    })
})
