/**
 * One-argument Alpine.magic(name) overwrites the magic. Real Chromium, real loader and data plugin
 * for the x-markdown / window.$x / $files paths; plain Alpine plus built plugins for the paths that
 * need the data plugin absent or Appwrite auth loaded.
 *
 * Run: node tests/e2e/magic-one-arg.e2e.mjs
 */
import { spawn } from 'child_process'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PORT = process.env.MAGIC_E2E_PORT || 20000 + Math.floor(Math.random() * 20000)
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

const proc = spawn('node', ['packages/run/serve.mjs', 'src', '--port', String(PORT), '--no-open'], { cwd: ROOT, stdio: 'ignore' })
const browser = await puppeteer.launch({ headless: 'shell' })
try {
    let up = false
    for (let i = 0; i < 40 && !up; i++) { up = await ping(`${BASE}/`); if (!up) await wait(250) }
    if (!up) throw new Error('dev server never came up')

    // Full stack
    {
        const page = await browser.newPage()
        const errors = []
        page.on('pageerror', e => errors.push(e.message))
        await page.goto(`${BASE}/test/magic-one-arg.html`, { waitUntil: 'load' })
        await page.waitForFunction(() => window.Alpine && window._$xProxyFactory && document.querySelector('#md h1'), { timeout: 20000 })
        await page.waitForFunction(() => document.querySelector('#v').textContent !== '', { timeout: 5000 }).catch(() => {})
        await wait(800)
        const readX = () => page.evaluate(() => window.Alpine.evaluate(document.body, 'typeof $x'))
        console.log('Alpine', await page.evaluate(() => window.Alpine.version))
        check('x-markdown init leaves $x', await readX() === 'object', await readX())
        check('$x binding renders', await page.evaluate(() => Number(document.querySelector('#v').textContent) > 0), await page.evaluate(() => document.querySelector('#v').textContent))

        await page.evaluate(() => { window.ManifestDataProxiesFiles.createReactiveFileManager('products', 'p1', 'b', 'fileIds') })
        await wait(300)
        check('$files manager leaves $x', await readX() === 'object', await readX())

        const pending = await page.evaluate(() => {
            const factory = window._$xProxyFactory
            delete window._$xProxyFactory
            const truthy = !!window.$x
            window._$xProxyFactory = factory
            return truthy
        })
        check('window.$x with no factory leaves $x', pending && await readX() === 'object', await readX())

        const uploaded = await page.evaluate(async () => {
            const orig = window.ManifestDataConfig
            window.ManifestDataConfig = { ...orig, ensureManifest: async () => ({ data: { t: {}, bkt: {} } }), getAppwriteTableId: () => 't', getAppwriteBucketId: () => 'b' }
            const parse = window.ManifestDataProxiesFiles.parseStorageConfig
            window.ManifestDataProxiesFiles.parseStorageConfig = () => ({ column: 'fileIds' })
            const handler = window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler
            window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler = () => async () => ({ $id: 'f' })
            try {
                return await window.ManifestDataProxiesMagic.createUploadMethod('t', () => {})('e', new Blob(['x']), 'bkt').then(r => r.$id, e => e.message)
            } finally {
                window.ManifestDataProxiesAppwrite.createAppwriteMethodsHandler = handler
                window.ManifestDataConfig = orig
                window.ManifestDataProxiesFiles.parseStorageConfig = parse
            }
        })
        check('$upload reaches the bucket', uploaded === 'f', uploaded)
        check('$upload leaves $x', await readX() === 'object', await readX())

        const exported = await page.evaluate(async () => {
            let blob
            URL.createObjectURL = b => { blob = b; return 'blob:x' }
            await Promise.race([new Promise(r => { window.Alpine.evaluateLater(document.body, "$export({ format: 'json', source: 'products' })")(r) }), new Promise(r => setTimeout(r, 1000))])
            await new Promise(r => setTimeout(r, 100))
            return blob ? JSON.parse(await blob.text()).length : null
        })
        check('$export source via window.$x', exported > 0, exported)
        check('no page errors', errors.length === 0, errors.slice(0, 3))
        await page.close()
    }

    // Plain Alpine: no data plugin, so window.$x is unset
    {
        const page = await browser.newPage()
        const errors = []
        page.on('pageerror', e => errors.push(e.message))
        await page.goto(`${BASE}/test/data/test.json`)
        await page.setContent('<!doctype html><html><body><div></div></body></html>')
        await page.addScriptTag({ path: path.join(ROOT, 'lib/manifest.export.js') })
        await page.addScriptTag({ path: path.join(ROOT, 'lib/manifest.appwrite.auth.js') })
        await page.addScriptTag({ path: path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js') })
        await page.waitForFunction(() => window.Alpine && window.Alpine.version)
        await wait(100)
        const res = await page.evaluate(async () => {
            const A = window.Alpine
            A.magic('x', () => ({ a: 1, rows: [{ id: 7 }] }))
            const before = A.evaluate(document.body, '$x.a')
            let blob
            URL.createObjectURL = b => { blob = b; return 'blob:x' }
            await Promise.race([new Promise(r => { A.evaluateLater(document.body, "$export({ format: 'json', source: 'rows' })")(r) }), new Promise(r => setTimeout(r, 1000))])
            await new Promise(r => setTimeout(r, 100))
            const afterExport = A.evaluate(document.body, '$x.a')
            A.magic('x', () => ({ a: 1 }))
            A.store('data', { brand: { team: 'Acme' } })
            const team = await window.ManifestAppwriteAuthTeamsDefaults?.resolvePersonalTeamName('$x.brand.team')
            return { windowX: typeof window.$x, before, afterExport, afterAuth: A.evaluate(document.body, '$x.a'), team, rows: blob ? await blob.text() : null }
        })
        check('window.$x unset', res.windowX === 'undefined', res.windowX)
        check('export read the magic', !!res.rows && JSON.parse(res.rows)[0].id === 7, res.rows)
        check('export leaves $x', res.before === 1 && res.afterExport === 1, [res.before, res.afterExport])
        check('auth team name from store', res.team === 'Acme', res.team)
        check('auth leaves $x', res.afterAuth === 1, res.afterAuth)
        check('no page errors (plain)', errors.length === 0, errors.slice(0, 3))
        await page.close()
    }
} finally {
    await browser.close()
    proc.kill()
}
if (failures.length) { console.error(`\n${failures.length} failed`); process.exit(1) }
console.log('\nall passed')
