import { describe, it, expect } from 'vitest'
import * as page from '../src/scripts/manifest.render.page.mjs'

const chrome = '<nav>Docs nav</nav><div>Core Plugins Copy page Ask AI</div>'
const docPage = (body, { head = '', twin = true } = {}) => `<!doctype html><html><head><title>Edit — Manifest</title>${head}</head><body><main>${chrome}
${twin ? '<template x-if="article"><div class="prose" x-markdown="article?.doc"></div></template>' : ''}
<div class="prose" data-mnfst-md-src="/articles/edit.md" data-mnfst-prerender-clone="1">${body}</div>
<footer>Footer</footer></main></body></html>`

describe('extractRouteContentFromHtml', () => {
  it('reads the prerendered article, not its empty markdown twin or a demo <article>', () => {
    const html = docPage('<h1>Edit</h1><p>Intro text.</p><div class="frame"><article><p>Loves pasta</p></article></div><p>After the demo.</p>')
    const { bodyText } = page.extractRouteContentFromHtml(html)
    expect(bodyText).toContain('Intro text.')
    expect(bodyText).toContain('After the demo.')
    expect(bodyText).not.toContain('Copy page')
  })

  it('takes the first non-empty .prose when no markdown source is marked', () => {
    const html = `<html><body><div class="prose" x-markdown="doc"></div><div class="prose"><p>Real body</p></div></body></html>`
    expect(page.extractRouteContentFromHtml(html).bodyText).toBe('Real body')
  })

  it('keeps nested <main> and <article> demos inside the fallback region', () => {
    const main = `<html><body><main>${chrome}<p>Start</p><dialog><main>inner</main></dialog><p>End of page</p></main></body></html>`
    expect(page.extractRouteContentFromHtml(main).bodyText).toContain('End of page')
    const article = `<html><body><article><p>Start</p><article>card</article><p>Article end</p></article></body></html>`
    expect(page.extractRouteContentFromHtml(article).bodyText).toContain('Article end')
  })

  it('reads descriptions containing the other quote character', () => {
    const d = (q, v) => page.extractRouteContentFromHtml(`<html><head><meta name="description" content=${q}${v}${q}></head><body></body></html>`).description
    expect(d('"', "What's free, and what Pro adds.")).toBe("What's free, and what Pro adds.")
    expect(d("'", 'Say "hi" first')).toBe('Say "hi" first')
  })
})
