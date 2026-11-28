import { describe, it, expect } from 'vitest'
import { stripPrerenderDynamicBindings, stripPrerenderedXDataDirectives, stripEmptyInlineMaskStyles } from '../src/scripts/manifest.render.page.mjs'

// Hyphenated tags (component placeholders in x-for templates) keep their name
describe('render passes keep hyphenated tag names', () => {
  it('stripPrerenderDynamicBindings', () => {
    const out = stripPrerenderDynamicBindings('<template x-for="p in $x.posts"><x-card :title="p.title" title="Hello"></x-card></template>')
    expect(out).toContain('<x-card :title="p.title">')
    expect(out).not.toMatch(/<x\s+-card/)
  })

  it('stripPrerenderedXDataDirectives', () => {
    expect(stripPrerenderedXDataDirectives('<my-el x-text="$x.a.b">v</my-el>')).toBe('<my-el>v</my-el>')
  })

  it('stripEmptyInlineMaskStyles', () => {
    expect(stripEmptyInlineMaskStyles('<x-icon-box style="mask-image: url()"></x-icon-box>')).toBe('<x-icon-box></x-icon-box>')
  })
})
