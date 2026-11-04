// @vitest-environment happy-dom
/**
 * Local $query accepts Appwrite's spellings too, so one query syntax works for local and cloud sources.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import vm from 'vm'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/scripts/data')
const SUBSCRIPTS = [
    'core/manifest.data.store.js',
    'shared/manifest.data.proxies.core.js',
    'shared/manifest.data.proxies.cache.js',
    'shared/proxies/creation/manifest.data.proxies.helpers.js',
    'shared/proxies/creation/manifest.data.proxies.array.js',
]

describe('local $query operators', () => {
    it('greaterThanEqual/lessThanEqual match greaterThanOrEqual/lessThanOrEqual', () => {
        window.Alpine = Alpine
        const ctx = { window, document, Alpine, console, setTimeout, clearTimeout, CustomEvent: window.CustomEvent }
        vm.createContext(ctx)
        for (const f of SUBSCRIPTS) vm.runInContext(readFileSync(path.join(DATA, f), 'utf8'), ctx, { filename: f })
        window.ManifestDataStore?.initializeStore?.()
        const rows = window.ManifestDataProxies.attachArrayMethods([{ p: 1 }, { p: 5 }, { p: 9 }], 'local-ops', () => {})
        const ids = (q) => rows.$query(q).map(r => r.p)
        expect(ids([['greaterThanEqual', 'p', 5], ['lessThanEqual', 'p', 5]])).toEqual([5])
        expect(ids([['greaterThanOrEqual', 'p', 5], ['lessThanOrEqual', 'p', 9]])).toEqual([5, 9])
    })
})
