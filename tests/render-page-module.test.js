import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import * as page from '../src/scripts/manifest.render.page.mjs'
import * as render from '../src/scripts/manifest.render.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pageSrc = readFileSync(join(here, '../src/scripts/manifest.render.page.mjs'), 'utf8')

const RAW = `<html lang="en"><head><title>Docs — Site</title><meta name="description" content="About things">
<script src="/manifest.js" data-plugins="router"></script><script src="https://cdn.example/alpine.js"></script></head>
<body><main><article class="prose"><h1>Hello</h1><p>World</p></article></main>
<script type="application/json" id="__manifest_hydrate__">[]</script></body></html>`

const finalize = (overrides = {}) => page.finalizeRouteHtml(RAW, {
  pathSeg: 'guides/intro',
  is404: false,
  currentLocale: 'en',
  locales: [],
  defaultLocale: null,
  routerBasePath: '',
  tailwindBuilt: false,
  bundleUtilities: true,
  originalScriptSrcs: page.scriptSrcSet('<script src="/manifest.js"></script>'),
  xData: { manifest: {}, content: {} },
  lazyIcons: false,
  localeRouteExclude: [],
  liveUrl: 'https://docs.example.com/',
  ...overrides,
})

describe('manifest.render.page.mjs (Worker-safe page module)', () => {
  it('uses no Node APIs', () => {
    expect(pageSrc).not.toMatch(/from ['"]node:/)
    expect(pageSrc).not.toMatch(/\bimport\s*\(/)
    expect(pageSrc).not.toMatch(/\brequire\(|\bprocess\.|\bBuffer\b|__dirname/)
  })

  it('is the implementation the CLI uses', () => {
    for (const name of ['markPrerenderedManifestComponents', 'expandLocaleRoutePaths', 'prefixLocaleInternalLinks', 'groupLlmsSections']) {
      expect(render[name]).toBe(page[name])
    }
  })

  it('finalizes a route snapshot like the CLI', () => {
    const { html } = finalize()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<script src="../../manifest.js" data-plugins="router"></script>')
    expect(html).not.toContain('alpine.js')
    expect(html).toContain('<meta name="manifest:prerendered" content="1">')
    expect(html).toContain('<meta name="manifest:router-base-depth" content="2">')
    expect(html).toContain('<link rel="canonical" href="https://docs.example.com/guides/intro"')
    expect(html).toContain('id="__manifest_hydrate__"')
  })

  it('finalizes the 404 page at depth 0', () => {
    const { html } = finalize({ pathSeg: page.NOT_FOUND_PATH, is404: true })
    expect(html).toContain('<meta name="manifest:router-base-depth" content="0">')
  })

  it('links the compiled Tailwind sheet when one was built', () => {
    const { html } = finalize({ tailwindBuilt: true })
    expect(html).toContain('<link rel="stylesheet" href="/prerender.tailwind.css">')
  })

  it('builds robots, sitemap and llms files as strings', () => {
    expect(page.buildRobotsTxt('https://d.example')).toContain('Sitemap: https://d.example/sitemap.xml')
    const xml = page.buildSitemapXml(['', 'guides/intro'], {
      base: 'https://d.example', liveUrl: 'https://d.example', locales: [], defaultLocale: null, lastmodOf: () => '2026-10-20',
    })
    expect(xml).toContain('<loc>https://d.example/</loc>')
    expect(xml).toContain('<loc>https://d.example/guides/intro</loc>')
    expect(xml).toContain('<lastmod>2026-10-20</lastmod>')
    const content = page.extractRouteContentFromHtml(finalize().html)
    expect(content).toMatchObject({ title: 'Docs — Site', description: 'About things', bodyText: 'Hello World' })
    const { llms, llmsFull } = page.buildLlmsFiles(
      [{ pathSeg: 'guides/intro', url: 'https://d.example/guides/intro', ...content }],
      { siteName: 'Site' },
    )
    expect(llms).toContain('- [Docs — Site](https://d.example/guides/intro): About things')
    expect(llmsFull).toContain('Hello World')
  })
})
