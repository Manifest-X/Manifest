// A save body as the page sends it: the patches with each static node's fingerprint, and
// the file hashes. Read from the dev server now, so for tests whose page loaded the
// current source. Fingerprints already set are kept.
import http from 'http'

const getJSON = (port, p) => new Promise((resolve, reject) => {
    http.get({ host: 'localhost', port, path: p }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)) } catch (e) { reject(e) } }) }).on('error', reject)
})
const originOf = (k) => k && k[0] === '~' ? k.slice(k.indexOf('~', 1) + 1) : k

export async function withBase(port, patches) {
    const { files, ids } = await getJSON(port, '/__edit/base')
    const fill = (t) => {
        if (!t || typeof t !== 'object') return
        if (typeof t.key === 'string' && t.fp == null && ids[originOf(t.key)]) t.fp = ids[originOf(t.key)]
        ;(Array.isArray(t.children) ? t.children : []).forEach(fill)
        ;(Array.isArray(t.base) ? t.base : []).forEach(fill)
    }
    for (const p of patches) if (p && p.kind === 'static-tree' && p.tree) { (p.tree.children || []).forEach(fill); (p.tree.base || []).forEach(fill) }
    return { patches, base: files }
}
