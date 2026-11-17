/**
 * @vitest-environment happy-dom
 *
 * data-head identity groups: repeated tags of one identity travel together, theme-color
 * pairs keep their media, nested routes outrank ancestors, and set-aside static tags
 * restore without duplicating one added meanwhile.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.__manifestLoaderStarted = true

let head
beforeAll(async () => {
    document.head.innerHTML = `<title>Static</title>
        <meta property="og:image" content="/static-1.png">
        <meta property="og:image" content="/static-2.png">
        <meta name="theme-color" content="#fff" media="(prefers-color-scheme: light)">
        <meta name="theme-color" content="#000" media="(prefers-color-scheme: dark)">`
    document.body.innerHTML = `
        <div x-route="gallery"><template data-head>
            <meta property="og:image" content="/a.png">
            <meta property="og:image" content="/b.png">
            <meta property="og:locale:alternate" content="fr_FR">
            <meta property="og:locale:alternate" content="de_DE">
            <meta property="article:tag" content="one">
            <meta property="article:tag" content="two">
            <meta name="theme-color" content="#eee" media="(prefers-color-scheme: light)">
        </template></div>
        <div x-route="b">
            <div x-route="b/c"><template data-head><title>Child</title><meta property="og:image" content="/child.png"></template></div>
            <template data-head><title>Parent</title><meta property="og:image" content="/parent.png"><meta name="description" content="parent"></template>
        </div>
        <div x-route="plain"></div>`
    const src = readFileSync(path.join(__dirname, '../src/scripts/manifest.router.js'), 'utf8')
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(src))
    head = window.ManifestRoutingHead
})

const contents = (sel) => Array.from(document.head.querySelectorAll(sel)).map((m) => m.getAttribute('content'))

describe('route head identity groups', () => {
    it('keeps every tag of a repeated identity from the providing template', () => {
        head.processAllHeadContent('gallery')
        expect(contents('meta[property="og:image"]')).toEqual(['/a.png', '/b.png'])
        expect(contents('meta[property="og:locale:alternate"]')).toEqual(['fr_FR', 'de_DE'])
        expect(contents('meta[property="article:tag"]')).toEqual(['one', 'two'])
    })

    it('keys meta[name] by media, so only the matching theme-color is replaced', () => {
        expect(contents('meta[name="theme-color"]').sort()).toEqual(['#000', '#eee'])
    })

    it('restores the static group in full when the route leaves', () => {
        head.processAllHeadContent('plain')
        expect(contents('meta[property="og:image"]')).toEqual(['/static-1.png', '/static-2.png'])
        expect(contents('meta[name="theme-color"]').sort()).toEqual(['#000', '#fff'])
        expect(document.head.querySelectorAll('meta[property="article:tag"]').length).toBe(0)
    })

    it('lets a nested route beat its ancestor whatever the document order', () => {
        head.processAllHeadContent('b/c')
        expect(document.title).toBe('Child')
        expect(document.head.querySelectorAll('title').length).toBe(1)
        expect(contents('meta[property="og:image"]')).toEqual(['/child.png'])
        expect(contents('meta[name="description"]')).toEqual(['parent'])
        head.processAllHeadContent('b')
        expect(document.title).toBe('Parent')
        expect(contents('meta[property="og:image"]')).toEqual(['/parent.png'])
    })

    it('does not restore a static tag over one of its identity added meanwhile', () => {
        head.processAllHeadContent('b')
        const added = document.createElement('title')
        added.textContent = 'Set by app'
        document.head.appendChild(added)
        head.processAllHeadContent('plain')
        expect(Array.from(document.head.querySelectorAll('title')).map((t) => t.textContent)).toEqual(['Set by app'])
        expect(document.head.innerHTML).not.toContain('route-head')
    })
})
