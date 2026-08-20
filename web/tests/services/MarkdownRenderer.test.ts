import { describe, expect, it, vi } from 'vitest'

const mockCodeToHtml = vi.fn(async () => '<pre>code</pre>')
vi.mock('shiki', () => ({ codeToHtml: mockCodeToHtml }))

const { renderMarkdownToHtml, rewriteDocLink } = await import(
  '../../app/Services/MarkdownRenderer.js'
)

describe('renderMarkdownToHtml', () => {
  it('renders alert blocks as diagnostic rows', async () => {
    const html = await renderMarkdownToHtml('> [!NOTE]\n> Hello there')
    expect(html).toContain('docs-alert--note')
    expect(html).toContain('<p class="docs-alert__label">note</p>')
  })

  it('maps warning directives onto the rule key', async () => {
    const html = await renderMarkdownToHtml('> [!WARNING]\n> Careful')
    expect(html).toContain('docs-alert--warning')
    expect(html).toContain('<p class="docs-alert__label">rule</p>')
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
