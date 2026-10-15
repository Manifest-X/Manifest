/**
 * @vitest-environment happy-dom
 *
 * Links inside editable text are content: a click places the caret, and the router
 * never navigates away (which would discard unpublished edits).
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.Alpine = Alpine
window.scrollTo = () => { }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

beforeAll(async () => {
    document.body.innerHTML = `<main>
        <div contenteditable="true" id="field"><p>Read <a href="/docs" id="inField">the docs</a></p></div>
        <p contenteditable="true" id="leaf">Go <a href="/guide" id="inLeaf">guide</a></p>
        <div contenteditable="true"><p contenteditable="false"><a href="/away" id="locked">locked</a></p></div>
        <a href="/plain" id="plain">plain</a>
    </main>`
    history.replaceState(null, '', '/start')
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(readFileSync(path.join(__dirname, '../lib/manifest.router.js'), 'utf8')))
    await wait(20)
})

describe('router and editable text', () => {
    it('a click on a link inside a contenteditable host is not routed', async () => {
        // The browser follows no link in editable text; the test environment would, so it is stopped here
        const stop = (e) => e.preventDefault()
        document.addEventListener('click', stop)
        const push = history.pushState, calls = []
        history.pushState = function (...a) { calls.push(a[2]); return push.apply(this, a) }
        try {
            for (const id of ['inField', 'inLeaf']) {
                document.getElementById(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
                await wait(20)
            }
            expect(calls).toEqual([])
            expect(location.pathname).toBe('/start')
        } finally { history.pushState = push; document.removeEventListener('click', stop) }
    })

    it('links outside editable text still route', async () => {
        document.getElementById('locked').click()
        await wait(30)
        expect(location.pathname).toBe('/away')
        document.getElementById('plain').click()
        await wait(30)
        expect(location.pathname).toBe('/plain')
    })
})
