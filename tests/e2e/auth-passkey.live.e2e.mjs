/**
 * Passkeys against a real Appwrite project, in real Chromium with a CDP virtual authenticator.
 *
 * Needs a project with Passkey and Anonymous enabled (Auth > Settings) and a `localhost` web platform.
 * Leaves one anonymous user behind; every passkey it registers is removed again.
 *
 * Run: APPWRITE_ENDPOINT=https://<region>.cloud.appwrite.io/v1 APPWRITE_PROJECT_ID=<id> node tests/e2e/auth-passkey.live.e2e.mjs
 */
import http from 'http'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'

const endpoint = process.env.APPWRITE_ENDPOINT
const projectId = process.env.APPWRITE_PROJECT_ID
if (!endpoint || !projectId) {
    console.error('Set APPWRITE_ENDPOINT and APPWRITE_PROJECT_ID')
    process.exit(2)
}
const SDK = process.env.APPWRITE_SDK_URL || 'https://cdn.jsdelivr.net/npm/appwrite@latest'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="manifest" href="/manifest.json">
<script src="${SDK}"></script><script src="/lib/manifest.appwrite.auth.js"></script><script defer src="/alpine.js"></script>
</head><body x-data><span id="method" x-text="$auth.method"></span></body></html>`
const manifest = JSON.stringify({ appwrite: { endpoint, projectId, auth: { methods: ['passkey', 'guest-manual'] } } })
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0]
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
    if (url === '/') send('text/html', html)
    else if (url === '/manifest.json') send('application/json', manifest)
    else if (url === '/lib/manifest.appwrite.auth.js') send('text/javascript', readFileSync(path.join(ROOT, 'lib/manifest.appwrite.auth.js')))
    else if (url === '/alpine.js') send('text/javascript', readFileSync(path.join(ROOT, 'node_modules/alpinejs/dist/cdn.min.js')))
    else { res.writeHead(404); res.end() }
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
    const cdp = await page.createCDPSession()
    await cdp.send('WebAuthn.enable')
    const addAuthenticator = async () => (await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    })).authenticatorId
    const first = await addAuthenticator()

    const auth = (expr) => page.evaluate(e => window.Alpine.evaluate(document.body, e), expr)
    const call = (expr) => page.evaluate(async e => {
        const r = await new Function('$auth', 'return ' + e)(window.Alpine.evaluate(document.body, '$auth'))
        return r && JSON.parse(JSON.stringify(r))
    }, expr)
    // Raw SDK call on the module's own client: { ok, value } or { ok: false, type, code, message }
    const sdk = (body) => page.evaluate(async b => {
        const { account } = await window.ManifestAppwriteAuthConfig.getAppwriteClient()
        try { return { ok: true, value: await new (Object.getPrototypeOf(async function () { }).constructor)('account', b)(account) } }
        catch (e) { return { ok: false, type: e.type, code: e.code, message: e.message } }
    }, body)

    await page.goto(`${BASE}/`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.Alpine && typeof window.Alpine.store('auth')?.loginPasskey === 'function' && window.Alpine.store('auth')._initialized, { timeout: 20000 })
    console.log('SDK passkey methods:', await sdk('return typeof account.createPasskeyToken'))

    // Is Passkey on for this project and origin?
    const probe = await sdk('return (await account.createPasskeyToken()).publicKey')
    if (!probe.ok) {
        console.error('Passkeys are not usable on this project from localhost:', probe)
        console.error('Enable Passkey under Auth > Settings and add a localhost web platform.')
        process.exitCode = 3
        throw new Error('precondition')
    }
    check('sign-in challenge issued', typeof probe.value.challenge === 'string' && !!probe.value.rpId, { rpId: probe.value.rpId })

    // A guest session registering a passkey straight through the SDK (the framework refuses this)
    const guest = await call('$auth.requestGuest()')
    check('guest session', guest.success === true, guest.error)
    const refused = await call('$auth.addPasskey()')
    check('framework refuses addPasskey for a guest', refused.code === 'guest', refused)
    const raw = await sdk(`
        const challenge = await account.createPasskey({ name: 'live-e2e-guest' })
        const credential = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(challenge.publicKey) })
        return await account.updatePasskeyVerification({ passkeyId: challenge.passkeyId, credential: credential.toJSON() })`)
    console.log('Appwrite, guest session registering a passkey directly:', raw.ok ? 'ACCEPTED' : raw)
    if (!raw.ok) throw new Error('could not seed a passkey; the remaining steps need one')
    const userId = await auth('$auth.user.$id')

    // Framework sign-in: replaces the guest session with a passkey session for the same user
    const login = await call('$auth.loginPasskey()')
    check('loginPasskey', login.success === true, login)
    check('same user', await auth('$auth.user.$id') === userId)
    check('$auth.method is passkey', await auth('$auth.method') === 'passkey', await auth('$auth.session.provider'))
    check('no longer a guest', await auth('$auth.isAnonymous') === false)
    console.log('session factors:', await auth('$auth.session.factors'))

    await page.goto(`${BASE}/`, { waitUntil: 'load' })
    await page.waitForFunction(() => window.Alpine && typeof window.Alpine.store('auth')?.loginPasskey === 'function' && window.Alpine.store('auth')._initialized, { timeout: 20000 })
    check('passkey session restored after reload', await auth('$auth.method') === 'passkey' && await auth('$auth.user.$id') === userId)

    // Framework management on the fresh passkey session
    const listed = await call('$auth.listPasskeys()')
    check('listPasskeys', listed.success && listed.passkeys.length === 1 && listed.passkeys[0].accessedAt !== '', listed)
    const dup = await call("$auth.addPasskey('dup')")
    check('same authenticator again is code exists', dup.code === 'exists', dup)

    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: first })
    await addAuthenticator()
    const added = await call("$auth.addPasskey('live-e2e-second')")
    check('addPasskey', added.success === true && await auth('$auth.passkeys.length') === 2, added)
    if (added.success) {
        const renamed = await call(`$auth.renamePasskey('${added.passkey.$id}', 'live-e2e-renamed')`)
        check('renamePasskey', renamed.success && renamed.passkey.name === 'live-e2e-renamed', renamed)
    }

    // Sign in again with the second passkey
    await call('$auth.logout()')
    const again = await call('$auth.loginPasskey()')
    check('sign in with the second passkey', again.success && await auth('$auth.user.$id') === userId, again)

    // Clean up: no passkey left behind
    const all = await call('$auth.listPasskeys()')
    for (const passkey of all.passkeys || []) {
        const removed = await call(`$auth.removePasskey('${passkey.$id}')`)
        check(`removePasskey ${passkey.name}`, removed.success === true, removed)
    }
    const left = await call('$auth.listPasskeys()')
    check('no passkeys left', left.success && left.passkeys.length === 0, left)
    await call('$auth.logout()')
    const gone = await call('$auth.loginPasskey()')
    check('removed passkey no longer signs in', gone.success === false && ['invalid', 'cancelled'].includes(gone.code), gone)
} catch (error) {
    if (error.message !== 'precondition') { console.error(error); failures.push('threw') }
} finally {
    await browser.close()
    server.close()
}

if (failures.length) {
    console.error(`\n${failures.length} failed: ${failures.join(', ')}`)
    process.exit(1)
}
if (!process.exitCode) console.log('\nall passed')
