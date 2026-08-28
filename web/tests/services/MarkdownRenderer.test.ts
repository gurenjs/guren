import { describe, expect, it, vi } from 'vitest'

const mockCodeToHtml = vi.fn(async () => '<pre>code</pre>')
vi.mock('shiki', () => ({ codeToHtml: mockCodeToHtml }))

const { renderMarkdownToHtml, rewriteDocLink, rewriteDocImage } = await import(
  '../../app/Services/MarkdownRenderer.js'
)

describe('renderMarkdownToHtml', () => {
  it('renders alert blocks as diagnostic rows', async () => {
    const html = await renderMarkdownToHtml('> [!NOTE]\n> Hello there')
    expect(html).toContain('guren-markdown-alert--note')
    expect(html).toContain('<p class="guren-markdown-alert__label">note</p>')
  })

  it('maps warning directives onto the rule key', async () => {
    const html = await renderMarkdownToHtml('> [!WARNING]\n> Careful')
    expect(html).toContain('guren-markdown-alert--warning')
    expect(html).toContain('<p class="guren-markdown-alert__label">rule</p>')
  })

  it('renders code blocks with shiki', async () => {
    const html = await renderMarkdownToHtml('```js\nconsole.log("hi")\n```')
    expect(html).toContain('<pre>code</pre>')
    expect(mockCodeToHtml).toHaveBeenCalled()
  })

  it('rewrites relative .md links to doc routes when a link context is given', async () => {
    const html = await renderMarkdownToHtml('[Glossary](./glossary.md)', {
      locale: 'ja',
      category: 'guides',
    })
    expect(html).toContain('href="/docs/ja/guides/glossary"')
  })

  it('leaves .md links untouched without a link context', async () => {
    const html = await renderMarkdownToHtml('[Glossary](./glossary.md)')
    expect(html).toContain('href="./glossary.md"')
  })

  it('renders mermaid fences as a client-rendered <pre class="mermaid">', async () => {
    mockCodeToHtml.mockClear()
    const html = await renderMarkdownToHtml('```mermaid\nflowchart LR\n  A --> B\n```')
    // shiki has no mermaid grammar; highlighting one would silently produce a
    // grey `text` code block instead of a diagram.
    expect(html).toContain('<pre class="mermaid">')
    expect(html).toContain('flowchart LR')
    expect(mockCodeToHtml).not.toHaveBeenCalled()
  })

  it('escapes the diagram source it hands to the client', async () => {
    const html = await renderMarkdownToHtml('```mermaid\nflowchart LR\n  A["<b>x</b>"] --> B\n```')
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('rewrites relative docs images onto the served root when a link context is given', async () => {
    const html = await renderMarkdownToHtml('![list](../../images/posts-index.png)', {
      locale: 'ja',
      category: 'tutorials',
    })
    expect(html).toContain('src="/docs-images/posts-index.png"')
  })

  it('leaves image sources untouched without a link context', async () => {
    const html = await renderMarkdownToHtml('![list](../../images/posts-index.png)')
    expect(html).toContain('src="../../images/posts-index.png"')
  })
})

describe('rewriteDocImage', () => {
  const context = { locale: 'ja', category: 'tutorials' } as const

  it('maps a docs/images path onto the /docs-images root', () => {
    expect(rewriteDocImage('../../images/welcome-page.png', context)).toBe(
      '/docs-images/welcome-page.png',
    )
  })

  it('resolves from the guides directory too', () => {
    expect(rewriteDocImage('../../images/docs-graph.png', { locale: 'en', category: 'guides' })).toBe(
      '/docs-images/docs-graph.png',
    )
  })

  it('leaves absolute URLs, roots, and data URIs alone', () => {
    expect(rewriteDocImage('https://example.com/a.png', context)).toBe('https://example.com/a.png')
    expect(rewriteDocImage('/already-served.png', context)).toBe('/already-served.png')
    expect(rewriteDocImage('data:image/png;base64,AAAA', context)).toBe('data:image/png;base64,AAAA')
  })

  it('leaves a percent-encoded escape alone', () => {
    // posix.join cannot normalize `%2e%2e`, but a browser resolves it after
    // the rewrite — so containment has to be decided before that.
    expect(rewriteDocImage('../../images/%2e%2e/other.png', context)).toBe(
      '../../images/%2e%2e/other.png',
    )
  })

  it('leaves a relative path that resolves outside docs/images alone', () => {
    expect(rewriteDocImage('./local.png', context)).toBe('./local.png')
    expect(rewriteDocImage('../../../outside.png', context)).toBe('../../../outside.png')
  })
})

describe('rewriteDocLink', () => {
  const ja = { locale: 'ja', category: 'guides' } as const
  const en = { locale: 'en', category: 'guides' } as const

  it('maps same-category links onto the locale base path', () => {
    expect(rewriteDocLink('./glossary.md', ja)).toBe('/docs/ja/guides/glossary')
    expect(rewriteDocLink('./glossary.md', en)).toBe('/docs/guides/glossary')
  })

  it('preserves heading anchors', () => {
    expect(rewriteDocLink('./validation.md#array-style-query-parameters', en)).toBe(
      '/docs/guides/validation#array-style-query-parameters',
    )
  })

  it('resolves cross-category links', () => {
    expect(rewriteDocLink('../tutorials/overview.md', ja)).toBe('/docs/ja/tutorials/overview')
    expect(rewriteDocLink('../guides/database.md', { locale: 'en', category: 'tutorials' })).toBe(
      '/docs/guides/database',
    )
  })

  it('preserves query strings', () => {
    expect(rewriteDocLink('./validation.md?tab=query', en)).toBe(
      '/docs/guides/validation?tab=query',
    )
    expect(rewriteDocLink('./validation.md?tab=query#anchor', en)).toBe(
      '/docs/guides/validation?tab=query#anchor',
    )
  })

  it('points links that escape the docs tree at GitHub', () => {
    expect(rewriteDocLink('../../../contributing/plugin-contract.md', en)).toBe(
      'https://github.com/gurenjs/guren/blob/main/contributing/plugin-contract.md',
    )
  })

  it('points slugs the docs routes would reject at GitHub', () => {
    expect(rewriteDocLink('./weird..name.md', en)).toBe(
      'https://github.com/gurenjs/guren/blob/main/docs/en/guides/weird..name.md',
    )
  })

  it('leaves links that traverse past the repo root untouched', () => {
    expect(rewriteDocLink('../../../../etc/passwd.md', en)).toBe('../../../../etc/passwd.md')
  })

  it('passes through absolute URLs, site paths, anchors, and non-md links', () => {
    expect(rewriteDocLink('https://example.com/x.md', ja)).toBe('https://example.com/x.md')
    expect(rewriteDocLink('/adr/0002-orders.md', ja)).toBe('/adr/0002-orders.md')
    expect(rewriteDocLink('#section', ja)).toBe('#section')
    expect(rewriteDocLink('./image.png', ja)).toBe('./image.png')
    expect(rewriteDocLink('mailto:hi@example.com', ja)).toBe('mailto:hi@example.com')
  })
})
