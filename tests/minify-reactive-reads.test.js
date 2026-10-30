// A `void a?.b` read exists only to subscribe an Alpine effect. Terser (jsDelivr's .min.js)
// treats optional-chain reads as pure and drops them, so the subscription vanishes in
// minified builds.
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { describe, it, expect } from 'vitest'
import { minify } from 'terser'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP = /tailwind\.v[\d.]+\.js$|\.mjs$/

function sources(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return p.endsWith('.js') && !SKIP.test(p) ? [p] : []
  })
}

describe('reactive reads survive minification', () => {
  it('no source subscribes with a void or bare optional-chain read', () => {
    const hits = sources(path.join(root, 'src/scripts')).flatMap((p) =>
      readFileSync(p, 'utf8').split('\n').map((line, i) => ({ p, i, line }))
        .filter(({ line }) => /\bvoid\s[^;]*\?\./.test(line) || /^\s*[\w$.()'"]+\?\.[\w$]+;/.test(line))
        .map(({ p, i }) => `${path.relative(root, p)}:${i + 1}`))
    expect(hits).toEqual([])
  })

  for (const file of ['manifest.charts.js', 'manifest.datepicker.js', 'manifest.status.js']) {
    it(`${file} keeps its _dataVersion subscription when minified`, async () => {
      const { code } = await minify(readFileSync(path.join(root, 'lib', file), 'utf8'))
      expect(code).toContain('._dataVersion')
    })
  }
})
