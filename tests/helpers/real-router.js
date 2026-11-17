// The router's ManifestRouting + ManifestRoutingVisibility, built in a throwaway vm
// context. Visibility never initializes (readyState 'loading'), so the shared
// document isn't hidden/cloaked; its matcher still queries the real document.
import vm from 'vm'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const read = (f) => readFileSync(path.resolve(dir, '../../src/scripts/router/', f), 'utf8')
const SOURCES = ['manifest.router.main.js', 'manifest.router.visibility.js'].map(read)

export function realRouter(document) {
    const w = { addEventListener() {}, dispatchEvent() {}, location: { pathname: '/' } }
    const doc = {
        readyState: 'loading',
        addEventListener() {},
        querySelector: (s) => document.querySelector(s),
        querySelectorAll: (s) => document.querySelectorAll(s)
    }
    const ctx = { window: w, document: doc, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail } } }
    vm.createContext(ctx)
    for (const s of SOURCES) vm.runInContext(s, ctx)
    return { ManifestRouting: w.ManifestRouting, ManifestRoutingVisibility: w.ManifestRoutingVisibility }
}
