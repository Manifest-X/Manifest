// A save body as the page sends it: the patches with each static node's fingerprint, and
// the file hashes. Read from the dev server now, so for tests whose page loaded the
// current source. Fingerprints already set are kept.
import http from 'http'

const getJSON = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: p }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } }) }).on('error', reject)
})
const originOf = (k) => k && k[0] === '~' ? k.slice(k.indexOf('~', 1) + 1) : k

export async function withBase(port, patches) {
    const { files, ids: byFile } = await getJSON(port, '/__edit/base')
    let ids = {}
    // A key is looked up in its own area's file (an element moved in from another file)
    const regionFile = new Map()
    const regionOf = (k) => { const o = originOf(k); return decodeURIComponent(o.slice(1, o.indexOf('@', 1))) }
    const idsFor = (k) => { const f = regionFile.get(regionOf(k)); return f ? byFile[f] || {} : ids }
    const fill = (t) => {
        if (!t || typeof t !== 'object') return
        if (typeof t.key === 'string' && t.fp == null && idsFor(t.key)[originOf(t.key)]) t.fp = idsFor(t.key)[originOf(t.key)]
        ;(Array.isArray(t.children) ? t.children : []).forEach(fill)
        ;(Array.isArray(t.base) ? t.base : []).forEach(fill)
    }
    // A component region's ids are its file's (declared, or components/<name>.html)
    const fileOf = (p) => p.component == null ? 'index.html' : Object.keys(byFile).find(f => f === `components/${p.component}.html` || f.endsWith(`/${p.component}.html`))
    for (const p of patches) if (p && p.kind === 'static-tree') regionFile.set(p.region, fileOf(p))
    for (const p of patches) if (p && p.kind === 'static-tree' && p.tree) { ids = byFile[fileOf(p)] || {}; (p.tree.children || []).forEach(fill); (p.tree.base || []).forEach(fill) }
    return { patches, base: files }
}
