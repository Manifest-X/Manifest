/**
 * A sign-in link signs in at once only in the browser that requested it. Opened anywhere else
 * it consumes nothing and ends no session until the visitor confirms.
 */
import { describe, it, expect } from 'vitest'
import { boot, until, sleep, noSession } from './helpers/auth-boot-harness.js'

const KEY = 'manifest:magic-link:requested'
const guest = { $id: 'guestV' }
const asGuest = { isAuthenticated: true, isAnonymous: true, user: guest }

function start({ cfg, persisted = null, requested = null, search = '?userId=atk&secret=S' } = {}) {
    let signedIn = false
    const p = boot({
        cfg: { teams: false, magic: true, ...cfg }, persisted, search,
        local: requested ? { [KEY]: JSON.stringify(requested) } : {},
        responder: (name) => {
            if (name === 'account.get') return persisted ? persisted.user : (signedIn ? { $id: 'atk', email: 'a@x.test' } : noSession())
            if (name === 'account.listSessions') return { sessions: [{ $id: 'sG', current: true, provider: persisted?.isAnonymous ? 'anonymous' : 'email' }] }
            if (name === 'account.createSession') { signedIn = true; return { $id: 's1', provider: 'magic-url' } }
            return {}
        },
    })
    const urls = []
    p.window.history.replaceState = (state, title, url) => urls.push(url)
    const asked = []
    p.window.addEventListener('manifest:auth:signin-confirm', e => asked.push(e))
    return { ...p, urls, asked }
}
const count = (p, name) => p.fake.calls.filter(c => c.name === name).length
const waiting = p => until(() => p.store.signInPending === true)

describe('link not requested in this browser', () => {
    it('signed-out visitor: nothing is consumed until they confirm', async () => {
        const p = start()
        await waiting(p)
        await sleep(30)
        expect(count(p, 'account.createSession')).toBe(0)
        expect(p.store.isAuthenticated).toBe(false)
        expect(p.asked.length).toBe(1)
        expect(p.urls).toEqual(['https://app.test/'])

        const result = await p.store.confirmSignIn()
        expect(result.success).toBe(true)
        expect(p.fake.calls.find(c => c.name === 'account.createSession').args).toEqual(['atk', 'S'])
        expect(p.store.signInPending).toBe(false)
        expect(p.store.isAuthenticated).toBe(true)
    })

    it('guest: its session is not ended, and cancelling drops the link', async () => {
        const p = start({ cfg: { guestAuto: true }, persisted: asGuest })
        await waiting(p)
        await sleep(30)
        expect(count(p, 'account.deleteSession')).toBe(0)
        expect(count(p, 'account.createSession')).toBe(0)
        expect(p.store.user.$id).toBe('guestV')

        p.store.cancelSignIn()
        expect(p.store.signInPending).toBe(false)
        const again = await p.store.confirmSignIn()
        expect(again.success).toBe(false)
        expect(count(p, 'account.deleteSession')).toBe(0)
        expect(count(p, 'account.createSession')).toBe(0)
        expect(p.store.isAnonymous).toBe(true)
    })

    it('a request for another account in this browser does not vouch for the link', async () => {
        const p = start({ requested: [{ u: 'me', t: Date.now() }] })
        await waiting(p)
        expect(count(p, 'account.createSession')).toBe(0)
    })

    it('a request older than an hour no longer vouches', async () => {
        const p = start({ requested: [{ u: 'atk', t: Date.now() - 61 * 60 * 1000 }] })
        await waiting(p)
        expect(count(p, 'account.createSession')).toBe(0)
    })

    it('a malformed record is ignored', async () => {
        const p = boot({ cfg: { teams: false, magic: true }, search: '?userId=atk&secret=S', local: { [KEY]: '{"u":"atk"}' }, responder: n => (n === 'account.get' ? noSession() : {}) })
        await until(() => p.store.signInPending === true)
        expect(p.fake.calls.some(c => c.name === 'account.createSession')).toBe(false)
    })
})

describe('link requested in this browser', () => {
    it('signs in at once and clears its record', async () => {
        const p = start({ requested: [{ u: 'other', t: Date.now() }, { u: 'atk', t: Date.now() }] })
        await until(() => p.store.isAuthenticated === true && !p.store.inProgress)
        expect(p.asked.length).toBe(0)
        expect(p.store.signInPending).toBe(false)
        expect(JSON.parse(p.window.localStorage.getItem(KEY)).map(e => e.u)).toEqual(['other'])
    })

    it('createMagicLink records the account the link is for', async () => {
        const p = start({ search: '' })
        await until(() => typeof p.store.createMagicLink === 'function' && p.store._appwrite)
        p.fake.appwrite.account.createMagicURLToken = async () => ({ userId: 'uNew', secret: '' })
        const sent = await p.store.createMagicLink('n@x.test')
        expect(sent.success).toBe(true)
        expect(JSON.parse(p.window.localStorage.getItem(KEY)).map(e => e.u)).toEqual(['uNew'])
    })
})

describe('default confirmation', () => {
    function withDom(p) {
        const made = []
        const el = tag => {
            const node = { tag, children: [], listeners: {}, attrs: {}, removed: false }
            node.setAttribute = (k, v) => { node.attrs[k] = v }
            node.append = (...c) => node.children.push(...c)
            node.addEventListener = (type, fn) => { node.listeners[type] = fn }
            node.remove = () => { node.removed = true }
            if (tag === 'dialog') {
                node.open = false
                node.showModal = () => { node.open = true }
                node.close = () => { node.open = false; node.listeners.close?.() }
            }
            made.push(node)
            return node
        }
        p.window.document.createElement = el
        p.window.document.body = { appendChild() {} }
        return made
    }
    const texts = made => made.map(n => n.textContent).filter(Boolean)

    it('opens a dialog; Continue signs in, and the dialog goes away', async () => {
        const p = start()
        const made = withDom(p)
        await waiting(p)
        const dialog = made.find(n => n.tag === 'dialog')
        expect(dialog.open).toBe(true)
        expect(texts(made)).toContain('Continue signing in?')
        made.find(n => n.textContent === 'Continue').listeners.click()
        expect(dialog.open).toBe(false)
        expect(dialog.removed).toBe(true)
        await until(() => p.store.isAuthenticated === true)
        expect(p.fake.calls.find(c => c.name === 'account.createSession').args).toEqual(['atk', 'S'])
    })

    it('Cancel (or Esc) drops the link', async () => {
        const p = start()
        const made = withDom(p)
        await waiting(p)
        made.find(n => n.textContent === 'Cancel').listeners.click()
        await sleep(20)
        expect(p.store.signInPending).toBe(false)
        expect(count(p, 'account.createSession')).toBe(0)
        expect((await p.store.confirmSignIn()).success).toBe(false)
    })

    it('a page that prevents the event shows its own UI', async () => {
        const p = start()
        const made = withDom(p)
        p.window.addEventListener('manifest:auth:signin-confirm', e => e.preventDefault())
        await waiting(p)
        expect(made.some(n => n.tag === 'dialog')).toBe(false)
        expect((await p.store.confirmSignIn()).success).toBe(true)
    })
})

describe('guest-auto sites', () => {
    const cfg = { guestAuto: true, guestUpgrade: true }
    function page() {
        let who = null
        const p = boot({
            cfg: { teams: false, magic: true, ...cfg }, search: '?userId=atk&secret=S',
            responder: (name) => {
                if (name === 'account.get') return who || noSession()
                if (name === 'account.createAnonymousSession') { who = { $id: 'g1' }; return { $id: 'sG', provider: 'anonymous' } }
                if (name === 'account.createSession') { if (who) { const e = new Error('Creation of a session is prohibited when a session is active.'); e.type = 'user_session_already_exists'; return e } who = { $id: 'atk' }; return { $id: 's1', provider: 'magic-url' } }
                if (name === 'account.getSession') return { $id: 'sG', provider: who?.$id === 'g1' ? 'anonymous' : 'magic-url' }
                if (name === 'account.listSessions') return { sessions: [{ $id: 'sG', current: true, provider: 'anonymous' }] }
                return {}
            },
        })
        return p
    }

    it('no guest is created while the link waits, so Continue signs in', async () => {
        const p = page()
        await waiting(p)
        await sleep(80)
        expect(count(p, 'account.createAnonymousSession')).toBe(0)
        expect((await p.store.confirmSignIn()).success).toBe(true)
        expect(p.store.user.$id).toBe('atk')
        expect(p.store.isAnonymous).toBe(false)
    })

    it('Cancel creates the guest that was waiting', async () => {
        const p = page()
        await waiting(p)
        p.store.cancelSignIn()
        await until(() => count(p, 'account.createAnonymousSession') === 1)
        expect(count(p, 'account.createSession')).toBe(0)
    })

    it('a guest that already exists is replaced by a link for another account, not "upgraded"', async () => {
        const p = start({ cfg, persisted: asGuest })
        await waiting(p)
        expect((await p.store.confirmSignIn()).success).toBe(true)
        expect(p.fake.names().filter(n => n === 'account.deleteSession' || n === 'account.createSession')).toEqual(['account.deleteSession', 'account.createSession'])
    })
})

describe('abandoned OAuth attempt', () => {
    it('its flag is cleared on a load with no callback, so a later link in the tab is not taken as OAuth', async () => {
        const p = start({ search: '' })
        p.window.sessionStorage.setItem('manifest:oauth:redirect', 'true')
        p.window.ManifestAppwriteAuthCallbacks.detect()
        expect(p.window.sessionStorage.getItem('manifest:oauth:redirect')).toBe(null)
    })
})
