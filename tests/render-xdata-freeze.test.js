import { describe, it, expect } from 'vitest'
import { stripPrerenderedXDataDirectives } from '../src/scripts/manifest.render.page.mjs'

// Chrome serializes `>` inside attribute values as `&gt;`, so arrow functions reach the pass escaped.
const frozen = (expr) => !stripPrerenderedXDataDirectives(`<span x-text="${expr}">v</span>`).includes('x-text')

describe('stripPrerenderedXDataDirectives', () => {
  it('freezes $x expressions that read nothing else from scope', () => {
    expect(frozen('$x.content.title')).toBe(true)
    expect(frozen("$x.t || &#39;No article&#39;")).toBe(true)
    expect(frozen("$x.a.find(d =&gt; d.k === &#39;x&#39;)?.name")).toBe(true)
    expect(frozen('$x.a.map((a, i) =&gt; a.n).join(&quot;, &quot;)')).toBe(true)
    expect(frozen('Math.max(...$x.a.map(p =&gt; p.price))')).toBe(true)
  })

  it('keeps $x expressions that also read scope state live', () => {
    expect(frozen('$x.site.docs.find(d =&gt; d.key === family)?.name')).toBe(false)
    expect(frozen('$x.a[lang]')).toBe(false)
    expect(frozen('`${$x.a} ${n}`')).toBe(false)
    expect(frozen('$x.a.find(d =&gt; d.k === $store.ui.tab)?.n')).toBe(false)
  })

  it('still keeps route- and search-driven expressions live', () => {
    expect(frozen("$x.ai.$route(&#39;path&#39;)?.name")).toBe(false)
    expect(frozen('$x.items.$search(q)')).toBe(false)
  })

  it('applies the same rule to x-html', () => {
    expect(stripPrerenderedXDataDirectives('<div x-html="$x.body">b</div>')).toBe('<div>b</div>')
    expect(stripPrerenderedXDataDirectives('<div x-html="$x.body[tab]">b</div>')).toContain('x-html')
  })
})
