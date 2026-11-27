/**
 * Passkey registration, sign-in and management in real Chromium with a CDP virtual authenticator.
 * The built auth module runs against an in-page relying party that verifies challenges, origin
 * and ES256 signatures (tests/e2e/fixtures/passkey/mock-appwrite-passkey.js).
 *
 * Run: node tests/e2e/auth-passkey.e2e.mjs
 */
import http from 'http'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIXTURE = path.join(ROOT, 'tests/e2e/fixtures/passkey')
const FILES = {
    '/': [path.join(FIXTURE, 'index.html'), 'text/html'],
    '/manifest.json': [path.join(FIXTURE, 'manifest.json'), 'application/json'],
    '/mock-appwrite-passkey.js': [path.join(FIXTURE, 'mock-appwrite-passkey.js'), 'text/javascript'],
    '/lib/manifest.appwrite.auth.js': [path.join(ROOT, 'lib/manifest.appwrite.auth.js'), 'text/javascript'],
    '/alpine.js': [path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js'), 'text/javascript'],
}
const server = http.createServer((req, res) => {
    const hit = FILES[req.url.split('?')[0]]
    if (!hit) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': hit[1], 'cache-control': 'no-store' })
    res.end(readFileSync(hit[0]))
})
await new Promise(r => server.listen(0, 'localhost', r))
const BASE = `http://localhost:${server.address().port}`

const failures = []
const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail === undefined ? '' : ' :: ' + JSON.stringify(detail)}`)
    if (!ok) failures.push(name)
}

const browser = await puppeteer.launch({ headless: 'shell' })
try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    const cdp = await page.createCDPSession()
    await cdp.send('WebAuthn.enable')
    const addAuthenticator = async () => (await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })).authenticatorId
    let authenticatorId = await addAuthenticator()

    const auth = (expr) => page.evaluate(e => window.Alpine.evaluate(document.body, e), expr)
    const call = (expr) => page.evaluate(async e => {
        const r = await new Function('$auth', 'return ' + e)(window.Alpine.evaluate(document.body, '$auth'))
        return r && JSON.parse(JSON.stringify(r))
    }, expr)
    const load = async () => {
        await page.goto(`${BASE}/`, { waitUntil: 'load' })
        await page.waitForFunction(() => window.Alpine && typeof window.Alpine.store('auth')?.loginPasskey === 'function' && window.Alpine.store('auth')._initialized, { timeout: 10000 })
    }
    const text = sel => page.$eval(sel, el => el.textContent)
    const visible = sel => page.$eval(sel, el => getComputedStyle(el).display !== 'none')

    await load()
    check('passkeySupported in Chromium', await auth('$auth.passkeySupported') === true)
    check('sign-in button shown when signed out', await visible('#login'))

    // Signed out, nothing registered: Appwrite side has no such credential
    {
        const r = await call('$auth.addPasskey()')
        check('addPasskey refuses when signed out', r.success === false && r.code === 'not-signed-in', r)
    }

    // Register as a signed-in user
    await page.evaluate(() => window.__signIn())
    await load()
    check('restored magic session', await auth('$auth.method') === 'magic')
    await page.click('#add')
    await page.waitForFunction(() => document.querySelectorAll('#list li').length === 1, { timeout: 10000 })
    check('registered passkey rendered', await text('#list li') === 'Laptop')
    check('server never received a passkey id', await page.evaluate(() => window.__rp.calls.filter(c => c[0] === 'createPasskey').every(c => !('passkeyId' in c[1]))))
    const userId = await auth('$auth.user.$id')
    const creds = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
    check('authenticator holds one discoverable credential', creds.credentials.length === 1 && creds.credentials[0].isResidentCredential === true, creds.credentials.length)

    {
        const r = await call("$auth.addPasskey('Again')")
        check('same authenticator again is code exists', r.success === false && r.code === 'exists', r)
        check('exists sets $auth.error', (await text('#error')).length > 0)
    }

    // Sign out, sign back in with the passkey
    await call('$auth.logout()')
    check('list cleared on sign-out', await auth('$auth.passkeys.length') === 0)
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#login')).display !== 'none')
    const loginEvent = page.evaluate(() => new Promise(r => window.addEventListener('manifest:auth:login', e => r(e.detail.user.$id), { once: true })))
    await page.click('#login')
    await page.waitForFunction(() => window.Alpine.store('auth').isAuthenticated === true, { timeout: 10000 })
    check('signed in as the same user', await auth('$auth.user.$id') === userId)
    check('manifest:auth:login fired', await loginEvent === userId)
    check('$auth.method is passkey', await text('#method') === 'passkey')
    check('not a guest', await auth('$auth.isAnonymous') === false)
    check('session exchanged positionally', await page.evaluate(() => { const c = window.__rp.calls.filter(c => c[0] === 'createSession').pop(); return typeof c[1] === 'string' && typeof c[2] === 'string' }))

    // Survives a reload
    await load()
    check('passkey session restored after reload', await auth('$auth.method') === 'passkey' && await auth('$auth.user.$id') === userId)

    // Manage
    {
        const listed = await call('$auth.listPasskeys()')
        check('listPasskeys', listed.success && listed.passkeys.length === 1 && listed.passkeys[0].accessedAt !== '', listed)
        const id = listed.passkeys[0].$id
        const renamed = await call(`$auth.renamePasskey('${id}', 'Work laptop')`)
        await page.waitForFunction(() => document.querySelector('#list li')?.textContent === 'Work laptop', { timeout: 5000 }).catch(() => {})
        check('renamePasskey updates the list', renamed.success && await text('#list li') === 'Work laptop', renamed)

        // Second authenticator, second passkey
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
        const second = await addAuthenticator()
        const added = await call("$auth.addPasskey('Phone')")
        check('second authenticator registers', added.success && await auth('$auth.passkeys.length') === 2, added)

        const removed = await call(`$auth.removePasskey('${added.passkey.$id}')`)
        check('removePasskey', removed.success && await auth('$auth.passkeys.length') === 1, removed)

        // The removed passkey no longer signs in
        await call('$auth.logout()')
        const r = await call('$auth.loginPasskey()')
        check('removed passkey is code invalid', r.success === false && r.code === 'invalid' && await auth('$auth.isAuthenticated') === false, r)
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: second })
        authenticatorId = await addAuthenticator()
    }

    // Fresh account on the fresh authenticator for the remaining cases
    await page.evaluate(() => window.__signIn())
    await load()
    {
        const added = await call("$auth.addPasskey('Key')")
        check('fresh registration', added.success, added)
    }
    const secondUser = await auth('$auth.user.$id')
    await call('$auth.logout()')

    // Dismissed prompt
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false })
    {
        const r = await call('$auth.loginPasskey()')
        check('failed verification is code cancelled, no error', r.success === false && r.code === 'cancelled' && await auth('$auth.error') === null && await auth('$auth.inProgress') === false, r)
    }
    await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true })

    // Guest refuses registration, then is replaced on sign-in
    {
        const guest = await call('$auth.requestGuest()')
        check('guest session', guest.success && await auth('$auth.isAnonymous') === true, guest)
        const refused = await call('$auth.addPasskey()')
        check('guest addPasskey refused', refused.success === false && refused.code === 'guest', refused)
        const r = await call('$auth.loginPasskey()')
        check('guest replaced by passkey sign-in', r.success && await auth('$auth.user.$id') === secondUser && await auth('$auth.isAnonymous') === false, r)
    }

    // Browsers without the WebAuthn JSON helpers: hand-rolled encode/decode against real signature checks
    await call('$auth.logout()')
    await page.evaluate(() => {
        delete PublicKeyCredential.parseRequestOptionsFromJSON
        delete PublicKeyCredential.parseCreationOptionsFromJSON
        delete PublicKeyCredential.prototype.toJSON
    })
    {
        const helpersGone = await page.evaluate(() => typeof PublicKeyCredential.parseRequestOptionsFromJSON === 'undefined' && typeof PublicKeyCredential.prototype.toJSON === 'undefined')
        check('JSON helpers removed', helpersGone)
        const r = await call('$auth.loginPasskey()')
        check('sign-in without JSON helpers', r.success && await auth('$auth.user.$id') === secondUser, r)
        const listed = await call('$auth.listPasskeys()')
        await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
        authenticatorId = await addAuthenticator()
        const added = await call("$auth.addPasskey('Manual')")
        check('registration without JSON helpers', added.success && listed.success, added)
    }

    // Method off in manifest.json
    await page.setRequestInterception(true)
    page.on('request', req => {
        if (req.url().endsWith('/manifest.json')) req.respond({ contentType: 'application/json', body: JSON.stringify({ appwrite: { endpoint: 'http://localhost/v1', projectId: 'p', auth: { methods: ['magic'] } } }) })
        else req.continue()
    })
    await page.goto(`${BASE}/`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.Alpine && typeof window.Alpine.store('auth')?.loginPasskey === 'function' && window.Alpine.store('auth')._initialized, { timeout: 10000 })
    await call('$auth.logout()')
    {
        const r = await call('$auth.loginPasskey()')
        check('method off is code not-enabled', r.success === false && r.code === 'not-enabled', r)
    }

    check('no page errors', errors.length === 0, errors.slice(0, 3))
} finally {
    await browser.close()
    server.close()
}

if (failures.length) {
    console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
    process.exit(1)
}
console.log('\nall passed')
