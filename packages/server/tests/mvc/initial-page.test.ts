import { describe, expect, it } from 'bun:test'

import { inertia } from '../../src'
import { readInitialPage } from '../../src/internal/inertia-page'

const componentOf = (html: string) => (readInitialPage(html) as { component?: string } | undefined)?.component

describe('readInitialPage', () => {
  it('reads back the page the engine writes, the props `serializePage()` escapes included', async () => {
    const props = { title: '</script><b>', note: 'line break' }
    const body = await (await inertia('posts/Show', props, { url: '/posts/1' })).text()
    expect(readInitialPage(body)).toMatchObject({ component: 'posts/Show', props, url: '/posts/1' })
  })

  it('reads the page an SSR body embeds itself', async () => {
    const embedded = '<div id="app"></div><script data-page="app" type="application/json">{"component":"Home","props":{}}</script>'
    const body = await (await inertia('Home', {}, { url: '/', ssr: { render: async () => ({ head: [], body: embedded, pageEmbedded: true }) } })).text()
    expect(componentOf(body)).toBe('Home')
  })

  it('reads the script element, not the shim that names it', () => {
    const html = `<script>document.querySelector('script[data-page="app"][type="application/json"]')</script><script data-page="app" type="application/json">{"component":"posts/Index"}</script>`
    expect(componentOf(html)).toBe('posts/Index')
  })

  it('reads a legacy data-page attribute, entities decoded, and nothing from a page without one', () => {
    const legacy = '<div id="app" data-page="{&quot;component&quot;:&quot;Home&quot;,&quot;props&quot;:{&quot;q&quot;:&quot;it&#39;s &lt;&amp;&gt;&quot;}}"></div>'
    expect(readInitialPage(legacy)).toEqual({ component: 'Home', props: { q: "it's <&>" } })
    expect(readInitialPage('<html><body>plain</body></html>')).toBeUndefined()
  })

  it('reads a payload whose text changes length when lowercased, and one escaping slashes', () => {
    const turkish = '<title>İstanbul</title><script data-page="app" type="application/json">{"component":"posts/Index","props":{"city":"İstanbul"}}</script>'
    expect(componentOf(turkish)).toBe('posts/Index')
    expect(componentOf('<script data-page="app" type="application/json">{"component":"posts\\/Index"}</script>')).toBe('posts/Index')
  })

  it('throws on an element that is not JSON', () => {
    expect(() => readInitialPage('<script data-page="app" type="application/json">{"component":</script>')).toThrow(SyntaxError)
  })
})
