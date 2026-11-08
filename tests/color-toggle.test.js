/**
 * Color mode toggle: switches to the opposite of the displayed mode, resolving system.
 */
import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(__dirname, '../src/scripts/manifest.color.js'), 'utf8')
function boot(osDark, stored) {
  const store = { theme: stored }
  const dirs = {}, magics = {}
  const html = { classList: new Set() }
  html.classList.contains = html.classList.has; html.classList.remove = (...a) => a.forEach(x => html.classList.delete(x))
  const g = {
    Alpine: { reactive: o => o, directive: (n, f) => dirs[n] = f, magic: (n, f) => magics[n] = f },
    localStorage: { getItem: k => store[k] ?? null, setItem: (k, v) => store[k] = v },
    window: { matchMedia: () => ({ matches: osDark, addEventListener() {} }) },
    document: { readyState: 'complete', documentElement: html, querySelector: () => null, addEventListener() {} },
    setTimeout: () => {}, setInterval: () => 0, clearInterval() {}
  }
  g.window.Alpine = g.Alpine
  new Function(...Object.keys(g), src + '\nensureColorPluginInitialized()')(...Object.values(g))
  return { $color: magics.color(), html, store }
}
it('toggle from system (OS light) goes dark', () => {
  const { $color, html } = boot(false, undefined)
  expect(html.classList.has('light')).toBe(true)
  $color.current = 'toggle'
  expect($color.current).toBe('dark'); expect(html.classList.has('dark')).toBe(true)
})
it('toggle from system (OS dark) goes light', () => {
  const { $color, html } = boot(true, undefined)
  $color.current = 'toggle'
  expect($color.current).toBe('light'); expect(html.classList.has('light')).toBe(true)
})
it('toggle from explicit modes flips', () => {
  const { $color } = boot(false, 'dark')
  $color.current = 'toggle'; expect($color.current).toBe('light')
  $color.current = 'toggle'; expect($color.current).toBe('dark')
})
