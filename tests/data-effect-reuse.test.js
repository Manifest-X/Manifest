/**
 * @vitest-environment happy-dom
 *
 * One long-lived effect per route proxy key and per computed $files key, however many store
 * updates or evaluations follow, and the files manager's unwatch stops its effect.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll, vi } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const load = (f) => new Function(readFileSync(path.join(dir, '../src/scripts/data', f), 'utf8'))()
const tick = () => new Promise(r => setTimeout(r, 0))

let effect
beforeAll(() => {
    window.Alpine = Alpine
    globalThis.Alpine = Alpine
    Alpine.store('data', { a: [{ $id: 'e1', fileIds: ['f1'] }], bucket: [{ $id: 'f1' }, { $id: 'f2' }], _v: {} })
    window.ManifestDataRouteTracker = Alpine.reactive({ currentUrl: '/one' })
    window.ManifestDataProxiesHelpers = {
        findItemByPath: (data, key, segs) => data.find(i => i[key] === segs[0]) || null,
        findGroupContainingItem: () => null,
        convertProxyToArray: (d) => d,
    }
    load('shared/proxies/creation/manifest.data.proxies.route.js')
    load('shared/manifest.data.proxies.files.js')
    effect = vi.spyOn(Alpine, 'effect')
})

describe('route proxy', () => {
    const P = () => window.ManifestDataProxies
    it('keeps one proxy and effect across store updates, and serves the new data', () => {
        effect.mockClear()
        const first = P().createRouteProxy([{ id: 'one', title: 'old' }], 'id', 'src')
        expect(first.title).toBe('old')
        const created = effect.mock.calls.length
        for (let i = 0; i < 5; i++) {
            P().clearRouteProxyCacheForDataSource('src')
            const again = P().createRouteProxy([{ id: 'one', title: `new${i}` }], 'id', 'src')
            expect(again).toBe(first)
            expect(again.title).toBe(`new${i}`)
        }
        expect(effect.mock.calls.length).toBe(created)
    })

    it('still follows the route after a refresh', async () => {
        const proxy = P().createRouteProxy([{ id: 'one', title: 'a' }, { id: 'two', title: 'b' }], 'id', 'nav')
        expect(proxy.title).toBe('a')
        P().clearRouteProxyCacheForDataSource('nav')
        P().createRouteProxy([{ id: 'one', title: 'a2' }, { id: 'two', title: 'b2' }], 'id', 'nav')
        window.ManifestDataRouteTracker.currentUrl = '/two'
        await tick()
        expect(proxy.title).toBe('b2')
        window.ManifestDataRouteTracker.currentUrl = '/one'
        await tick()
    })

    it('leaves other sources cached and fresh', () => {
        const other = P().createRouteProxy([{ id: 'one', title: 'x' }], 'id', 'other')
        P().clearRouteProxyCacheForDataSource('oth')
        expect(P().createRouteProxy([{ id: 'one', title: 'y' }], 'id', 'other').title).toBe('x')
        expect(other.title).toBe('x')
    })
})

describe('computed $files', () => {
    const make = (...a) => window.ManifestDataProxiesFiles.createComputedFilesArray(...a)
    it('an owned array releases its effect once its row leaves the table', async () => {
        const release = vi.spyOn(Alpine, 'release')
        const store = Alpine.store('data')
        store.a.push({ $id: 'e2', fileIds: ['f2'] })
        const row = Alpine.raw(store.a[1])
        const twin = { $id: 'e2', fileIds: ['f2'] }
        store.a.push(twin)
        const files = make('a', 'e2', 'bucket', 'fileIds', { owner: row })
        const twinFiles = make('a', 'e2', 'bucket', 'fileIds', { owner: Alpine.raw(store.a[2]) })
        await tick()
        expect(files.map(f => f.$id)).toEqual(['f2'])
        expect(release).not.toHaveBeenCalled()
        store.a.splice(2, 1)
        await tick()
        expect(release).toHaveBeenCalledTimes(1)
        store.a[1].fileIds.push('f1')
        await tick()
        expect(files.map(f => f.$id).sort()).toEqual(['f1', 'f2'])
        expect(twinFiles.map(f => f.$id)).toEqual(['f2'])
        store.a.splice(1, 1)
        await tick()
        expect(release).toHaveBeenCalledTimes(2)
        release.mockRestore()
    })

    it('stays in sync with the bucket and the entry', async () => {
        const files = make('a', 'e1', 'bucket', 'fileIds')
        expect(files.map(f => f.$id)).toEqual(['f1'])
        Alpine.store('data').a[0].fileIds.push('f2')
        await tick()
        expect(files.map(f => f.$id)).toEqual(['f1', 'f2'])
        Alpine.store('data').bucket.splice(0, 1)
        await tick()
        expect(files.map(f => f.$id)).toEqual(['f2'])
    })
})

describe('files manager', () => {
    it('stops its table watcher on destroy, without re-running it', () => {
        const src = readFileSync(path.join(dir, '../src/scripts/data/shared/manifest.data.proxies.files.js'), 'utf8')
        expect(src).toMatch(/if \(unwatch\) Alpine\.release\(unwatch\);/)
    })
})
