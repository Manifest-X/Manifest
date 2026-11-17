/**
 * @vitest-environment happy-dom
 *
 * data-head priority across unrelated route branches (document order) vs nested routes
 * (child wins), static group restore order, and routeless rendered components.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.__manifestLoaderStarted = true

let head
beforeAll(async () => {
    document.head.innerHTML = `<meta charset="utf-8"><title>Static</title>
        <meta property="og:image" content="/s1.png">
        <meta property="og:image" content="/s2.png">
        <link rel="icon" href="/favicon.ico">`
    document.body.innerHTML = `
        <div x-route="!login"><nav x-route="docs"><template data-head><title>Docs nav</title></template></nav></div>
        <section x-route="docs/intro"><template data-head><title>Intro</title><meta property="og:image" content="/intro.png"></template></section>
        <div id="slot"></div>`
    const src = readFileSync(path.join(__dirname, '../src/scripts/manifest.router.js'), 'utf8')
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(src))
    head = window.ManifestRoutingHead
})

const order = () => Array.from(document.head.children).map((el) => el.tagName === 'META' ? `${el.getAttribute('property') || el.getAttribute('charset') ? (el.getAttribute('content') || 'charset') : ''}` : el.tagName === 'TITLE' ? `title:${el.textContent}` : el.tagName.toLowerCase())

describe('route head scope', () => {
    it('keeps document order between unrelated branches, even when one is nested deeper', () => {
        head.processAllHeadContent('docs/intro')
        expect(document.title).toBe('Intro')
        expect(document.head.querySelectorAll('title').length).toBe(1)
    })

    it('restores a static group in its original order and place', () => {
        head.processAllHeadContent('login')
        expect(order()).toEqual(['charset', 'title:Static', '/s1.png', '/s2.png', 'link'])
    })

    it('applies a routeless rendered component while it is connected', () => {
        const tpl = document.createElement('template')
        tpl.setAttribute('data-head', '')
        tpl.setAttribute('data-component', 'docs-platform-1')
        tpl.innerHTML = '<title>Platform</title>'
        document.getElementById('slot').appendChild(tpl)
        head.processAllHeadContent('login')
        expect(document.title).toBe('Platform')
        tpl.remove()
        head.processAllHeadContent('login')
        expect(document.title).toBe('Static')
    })

    it('ignores a routeless component under an inactive route', () => {
        const tpl = document.createElement('template')
        tpl.setAttribute('data-head', '')
        tpl.setAttribute('data-component', 'docs-platform-2')
        tpl.innerHTML = '<title>Hidden platform</title>'
        document.querySelector('section[x-route="docs/intro"]').appendChild(tpl)
        head.processAllHeadContent('login')
        expect(document.title).toBe('Static')
        tpl.remove()
    })
})
