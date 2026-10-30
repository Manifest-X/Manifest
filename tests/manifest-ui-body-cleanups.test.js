/**
 * @vitest-environment happy-dom
 *
 * ManifestUI (one copy per carrying plugin, first load wins) resolves `_ui` labels against
 * <body>. Each Alpine.evaluate there registered a cleanup on <body> that never ran; every copy
 * now reuses one evaluator per expression.
 */
import { readFileSync } from 'fs'
import { describe, it, expect, beforeAll } from 'vitest'
import path from 'path'
import { fileURLToPath } from 'url'
import Alpine from 'alpinejs'

const dir = path.dirname(fileURLToPath(import.meta.url))
const COPIES = ['status/manifest.status.main.js', 'manifest.charts.js', 'manifest.datepicker.js', 'manifest.combobox.js', 'manifest.colorpicker.js']

function extract(file) {
    const s = readFileSync(path.join(dir, '../src/scripts', file), 'utf8')
    const start = s.indexOf('if (!window.ManifestUI) {')
    let depth = 0
    for (let i = s.indexOf('{', start); i < s.length; i++) {
        if (s[i] === '{') depth++
        else if (s[i] === '}' && --depth === 0) return s.slice(start, i + 1)
    }
    throw new Error('no ManifestUI block in ' + file)
}

beforeAll(async () => {
    window.Alpine = Alpine
    const data = Alpine.reactive({ labels: { _ui: { picker: { title: 'Titre' } } } })
    Alpine.magic('x', () => data)
    Alpine.magic('locale', () => ({ current: 'fr' }))
    window.ManifestDataStore = { rawDataStore: new Map([['labels', {}]]) }
    Alpine.start()
    await new Promise(r => setTimeout(r, 0))
})

describe.each(COPIES)('%s', (file) => {
    it('resolves labels without growing <body> cleanups', () => {
        delete window.ManifestUI
        new Function(extract(file))()
        const before = (document.body._x_cleanups || []).length
        let out
        for (let i = 0; i < 50; i++) out = window.ManifestUI.resolve('picker', { title: 'Title', close: 'Close' })
        expect(out).toEqual({ title: 'Titre', close: 'Close' })
        expect((document.body._x_cleanups || []).length - before).toBeLessThanOrEqual(4)
    })

    it('sees a magic registered after its evaluator was built', () => {
        delete window.ManifestUI
        new Function(extract(file))()
        const expr = `typeof $late${COPIES.indexOf(file)} !== "undefined" && $late${COPIES.indexOf(file)}.v`
        expect(window.ManifestUI._eval(expr)).toBe(false)
        Alpine.magic(`late${COPIES.indexOf(file)}`, () => ({ v: 'here' }))
        expect(window.ManifestUI._eval(expr)).toBe('here')
    })
})

it('colorpicker calls the shared evaluator as a method (strict copies need this)', () => {
    const src = readFileSync(path.join(dir, '../src/scripts/manifest.colorpicker.js'), 'utf8')
    expect(src).not.toMatch(/\? window\.ManifestUI\._eval :/)
})
