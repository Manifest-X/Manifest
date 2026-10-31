/**
 * $upload through the real bucket handler, store and load path in Chromium, with the Appwrite
 * calls mocked: parallel links survive, and a failed first load shows $error and recovers.
 *
 * Run: node tests/e2e/upload-first-load.e2e.mjs
 */
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = process.env.UPLOAD_E2E_PORT || 20000 + Math.floor(Math.random() * 20000)
const BASE = `http://localhost:${PORT}`
const wait = (ms) => new Promise(r => setTimeout(r, ms))
const ping = (url) => new Promise(resolve => {
    const req = http.get(url, res => { res.resume(); resolve(res.statusCode === 200) })
    req.on('error', () => resolve(false))
    req.setTimeout(1000, () => { req.destroy(); resolve(false) })
})

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const setup = () => {
    const manifest = { data: { t: { appwriteTableId: 't', storage: { bkt: 'fileIds' } }, bkt: { appwriteBucketId: 'b' } } }
    window.ManifestDataConfig = {
        ...window.ManifestDataConfig,
        ensureManifest: async () => manifest,
        getManifest: () => manifest,
        isAppwriteCollection: d => !!(d?.appwriteTableId || d?.appwriteBucketId),
        getAppwriteConfig: async () => ({ databaseId: 'db' }),
        getAppwriteTableId: d => d?.appwriteTableId || null,
        getAppwriteBucketId: d => d?.appwriteBucketId || null,
        getScope: () => null,
        getScopeColumns: () => ({}),
        getQueries: () => null,
    }
    window.ManifestDataQueries = { ...(window.ManifestDataQueries || {}), buildAppwriteQueries: async () => [] }
    const later = (ms) => new Promise(r => setTimeout(r, ms))
    const server = window.__server = { fileIds: ['f1'], bucket: ['old1', 'f1'], listFails: false, lists: 0 }
    window.ManifestDataAppwrite = new Proxy({
        createFile: async (b, id) => { await later(20); server.bucket.push(id); return { $id: id, name: 'n' } },
        getTableRow: async () => { await later(20); return { $id: 'e1', fileIds: [...server.fileIds] } },
        updateRow: async (d, t, i, p) => { const v = [...p.fileIds]; await later(20); server.fileIds = v; return { $id: i, ...p } },
        listBucketFiles: async () => {
            server.lists++
            await later(20)
            if (server.listFails) throw new Error('list failed')
            return server.bucket.map($id => ({ $id, name: 'n' }))
        },
    }, { get: (t, k) => t[k] ?? (async () => ({ rows: [], total: 0, files: [] })) })
    window.__upload = (files) => window.ManifestDataProxiesMagic
        .createUploadMethod('t', (n, l) => window.ManifestDataMain.reloadDataSource(n, l))('e1', files, 'bkt')
}

const proc = spawn('node', ['packages/run/serve.mjs', 'src', '--port', String(PORT), '--no-open'], { cwd: ROOT, stdio: 'ignore' })
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { up = await ping(`${BASE}/`); if (!up) await wait(250) }
    if (!up) throw new Error('dev server never came up')

    const open = async () => {
        const page = await browser.newPage()
        await page.goto(`${BASE}/test/magic-one-arg.html`, { waitUntil: 'load' })
        await page.waitForFunction(() => window.Alpine && window._$xProxyFactory && window.ManifestDataMain, { timeout: 20000 })
        await page.evaluate(setup)
        return page
    }

    // Row outside the store
    {
        const page = await open()
        const res = await page.evaluate(async () => {
            const ids = (await window.__upload([new Blob(['a']), new Blob(['b']), new Blob(['c'])])).map(r => r.$id)
            return { ids, server: window.__server.fileIds, bucket: Array.from(window.Alpine.store('data').bkt || []).map(f => f.$id) }
        })
        check('all 3 links reach the server', res.ids.every(id => res.server.includes(id)) && res.server.includes('f1'), res.server)
        check('unread bucket landed with its rows', res.bucket.includes('old1') && res.ids.every(id => res.bucket.includes(id)), res.bucket)
        await page.close()
    }

    // First load fails
    {
        const page = await open()
        const res = await page.evaluate(async () => {
            window.__server.listFails = true
            const up = await window.__upload(new Blob(['x']))
            const store = window.Alpine.store('data')
            const after = { raw: store.bkt ?? null, error: store._bkt_state?.error ?? null, linked: window.__server.fileIds.includes(up.$id) }
            // Reading an unloaded source retries its load, so $error settles once that attempt fails
            void window.Alpine.evaluate(document.body, '$x.bkt.$error')
            await new Promise(r => setTimeout(r, 200))
            const bound = window.Alpine.evaluate(document.body, '$x.bkt.$error')
            // Past the pending-load window, with the server back, a read must load the full list
            await new Promise(r => setTimeout(r, 1100))
            window.__server.listFails = false
            void window.Alpine.evaluate(document.body, '$x.bkt.length')
            await new Promise(r => setTimeout(r, 400))
            return { ...after, bound, id: up.$id, recovered: Array.from(store.bkt || []).map(f => f.$id), ready: window.Alpine.evaluate(document.body, '$x.bkt.$ready'), errorAfter: store._bkt_state?.error ?? null }
        })
        check('upload and link still succeed', res.linked, res.id)
        check('no partial store row', res.raw === null, res.raw)
        check('$error visible', res.error === 'list failed' && res.bound === 'list failed', [res.error, res.bound])
        check('later read recovers the full list', res.recovered.includes('old1') && res.recovered.includes(res.id) && res.ready === true, [res.recovered, res.ready])
        check('$error clears after recovery', res.errorAfter === null, res.errorAfter)
        await page.close()
    }
} finally {
    await browser.close()
    proc.kill()
}
if (failures.length) { console.error(`\n${failures.length} failed`); process.exit(1) }
console.log('\nall passed')
