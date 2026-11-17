/**
 * @vitest-environment happy-dom
 *
 * <template data-head> per route: tags replace by identity on navigation instead of
 * accumulating, supersede the static index.html tag while active, and restore it after.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
window.__manifestLoaderStarted = true

const ROUTES = ['/', 'products', 'about', 'contact']
const headFor = (name) => `<template data-head>
    <title>${name} title</title>
    <meta name="description" content="${name} description">
    <meta property="og:title" content="${name} og">
</template>`

let head
beforeAll(async () => {
    document.head.innerHTML = `<title>Static title</title>
        <meta name="description" content="Static description">
        <link rel="canonical" href="https://example.com/">`
    document.body.innerHTML = ROUTES.map((r) => `<div x-route="${r}">${r === 'contact' ? '' : headFor(r)}<p>${r}</p></div>`).join('')
        + `<div x-route="about"><template data-head><link rel="canonical" href="https://example.com/about"></template></div>`
    const src = readFileSync(path.join(__dirname, '../src/scripts/manifest.router.js'), 'utf8')
    await import(/* @vite-ignore */ 'data:text/javascript,' + encodeURIComponent(src))
    head = window.ManifestRoutingHead
})

const count = (sel) => document.head.querySelectorAll(sel).length
const content = (sel) => document.head.querySelector(sel)?.getAttribute('content')

describe('route head replacement', () => {
    it('keeps exactly one of each tag across navigations, following the route', () => {
        for (const route of ['products', 'about', '/', 'products', 'about']) {
            head.processAllHeadContent(route)
            const name = route
            expect(count('title')).toBe(1)
            expect(document.title).toBe(`${name} title`)
            expect(count('meta[name="description"]')).toBe(1)
            expect(content('meta[name="description"]')).toBe(`${name} description`)
            expect(count('meta[property="og:title"]')).toBe(1)
            expect(content('meta[property="og:title"]')).toBe(`${name} og`)
        }
    })

    it('replaces link[rel=canonical] by identity', () => {
        head.processAllHeadContent('about')
        expect(count('link[rel="canonical"]')).toBe(1)
        expect(document.head.querySelector('link[rel="canonical"]').href).toBe('https://example.com/about')
        head.processAllHeadContent('products')
        expect(count('link[rel="canonical"]')).toBe(1)
        expect(document.head.querySelector('link[rel="canonical"]').href).toBe('https://example.com/')
    })

    it('restores the static tags when no route provides them', () => {
        head.processAllHeadContent('contact')
        expect(count('title')).toBe(1)
        expect(document.title).toBe('Static title')
        expect(content('meta[name="description"]')).toBe('Static description')
        expect(count('meta[property="og:title"]')).toBe(0)
        expect(count('[data-route-head]')).toBe(0)
    })

    it('is idempotent for repeat passes on the same route', () => {
        head.processAllHeadContent('products')
        head.processAllHeadContent('products')
        expect(count('[data-route-head]')).toBe(3)
        expect(count('title')).toBe(1)
    })
})
