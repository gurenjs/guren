import { describe, expect, it } from 'vitest'

import { clientVisitHref, type AnchorLike } from '../../resources/js/lib/doc-link.js'

const here = { origin: 'https://guren.dev', pathname: '/docs/tutorials/00-overview' }
const link = (href: string | null, extra: Partial<AnchorLike> = {}): AnchorLike => ({
  href,
  target: '',
  download: false,
  ...extra,
})

describe('clientVisitHref', () => {
  it('visits a doc page client-side, keeping its fragment', () => {
    expect(clientVisitHref(link('/docs/tutorials/01-zero-to-deployed'), here)).toBe('/docs/tutorials/01-zero-to-deployed')
    expect(clientVisitHref(link('/docs/ja/guides/cli#make'), here)).toBe('/docs/ja/guides/cli#make')
    expect(clientVisitHref(link('/docs'), here)).toBe('/docs')
    expect(clientVisitHref(link('/docs/ja'), here)).toBe('/docs/ja')
  })

  it('accepts an absolute URL on the same origin', () => {
    expect(clientVisitHref(link('https://guren.dev/docs/guides/bun'), here)).toBe('/docs/guides/bun')
  })

  it('leaves other origins, new tabs and downloads to the browser', () => {
    expect(clientVisitHref(link('https://github.com/gurenjs/guren'), here)).toBeUndefined()
    expect(clientVisitHref(link('/docs/guides/bun', { target: '_blank' }), here)).toBeUndefined()
    expect(clientVisitHref(link('/docs/guides/bun', { download: true }), here)).toBeUndefined()
  })

  it('leaves routes that are not Inertia pages to the browser', () => {
    expect(clientVisitHref(link('/docs/guides/bun.md'), here)).toBeUndefined()
    expect(clientVisitHref(link('/docs/search?q=bun'), here)).toBeUndefined()
    expect(clientVisitHref(link('/llms.txt'), here)).toBeUndefined()
    expect(clientVisitHref(link('/docs-images/flow.png'), here)).toBeUndefined()
  })

  it('leaves a fragment on the open page to native scrolling', () => {
    expect(clientVisitHref(link('#the-chapters'), here)).toBeUndefined()
    expect(clientVisitHref(link('/docs/tutorials/00-overview#prerequisites'), here)).toBeUndefined()
  })

  it('ignores an anchor without an href', () => {
    expect(clientVisitHref(link(null), here)).toBeUndefined()
  })
})
