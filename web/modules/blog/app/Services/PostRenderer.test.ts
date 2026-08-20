import { describe, expect, it } from 'vitest'
import { renderPostMarkdown } from './PostRenderer.js'

describe('renderPostMarkdown', () => {
  it('should render markdown to HTML', async () => {
    const html = await renderPostMarkdown('# Hello\n\nSome **bold** text.')

    expect(html).toContain('<h1')
    expect(html).toContain('<strong>bold</strong>')
  })

  it('should highlight fenced code blocks with shiki', async () => {
    const html = await renderPostMarkdown('```typescript\nconst n: number = 1\n```')

    expect(html).toContain('shiki')
    expect(html).toContain('<pre')
    expect(html).toContain('<span')
  })

  it('should render alerts with the site vocabulary shared with docs', async () => {
    const html = await renderPostMarkdown('> [!WARNING]\n> Careful')

    expect(html).toContain('guren-markdown-alert--warning')
    expect(html).toContain('>rule</p>')
  })

  it('should fall back to plain text for unknown languages', async () => {
    const html = await renderPostMarkdown('```notalanguage\nplain body\n```')

    expect(html).toContain('plain body')
    expect(html).toContain('<pre')
  })
})

describe('sanitization', () => {
  // The rendered HTML is stored and later injected with
  // dangerouslySetInnerHTML, so every one of these must be neutralized at
  // save time. Escaping raw HTML alone is not enough — markdown syntax
  // carries URLs into href/src, and an encoded scheme still executes.
  //
  // Each case asserts both that the dangerous form is gone AND that the
  // sanitized remnant is present, so an empty return value cannot pass.
  const vectors: Array<{ name: string; markdown: string; remnant: RegExp }> = [
    { name: 'raw script tag', markdown: '<script>alert(1)</script>', remnant: /&lt;script&gt;/ },
    { name: 'inline event handler', markdown: 'x <img src=y onerror=alert(2)> z', remnant: /<img[^>]*src="y"/ },
    { name: 'javascript: link', markdown: '[click](javascript:alert(1))', remnant: /<a[^>]*>click<\/a>/ },
    { name: 'javascript: image', markdown: '![x](javascript:alert(2))', remnant: /<img[^>]*alt="x"/ },
    { name: 'data: html uri', markdown: '[d](data:text/html;base64,PHN2Zz4=)', remnant: /<a[^>]*>d<\/a>/ },
    { name: 'vbscript: link', markdown: '[v](vbscript:msgbox(1))', remnant: /<a[^>]*>v<\/a>/ },
    { name: 'mixed-case javascript:', markdown: '[U](JaVaScRiPt:alert(4))', remnant: /<a[^>]*>U<\/a>/ },
    { name: 'iframe', markdown: '<iframe src=//evil.test></iframe>', remnant: /&lt;iframe/ },
    { name: 'positioned style attribute', markdown: '<p style="position:fixed;top:0">x</p>', remnant: /x/ },
  ]

  for (const { name, markdown, remnant } of vectors) {
    it(`should neutralize ${name}`, async () => {
      const html = await renderPostMarkdown(markdown)

      expect(html).not.toMatch(/<script|<iframe |onerror=|javascript:|vbscript:|data:text\/html|position:fixed/i)
      expect(html).toMatch(remnant)
    })
  }

  it('should strip href entirely when the scheme is encoded to evade matching', async () => {
    // `java&#115;cript:` survives a literal "javascript:" check, so assert
    // the attribute is dropped rather than that a substring is absent.
    const html = await renderPostMarkdown('[e](java&#115;cript:alert(5))')

    expect(html).toMatch(/<a[^>]*>e<\/a>/)
    expect(html).not.toMatch(/href=/)
  })

  it('should strip protocol-relative URLs from href and src', async () => {
    const html = await renderPostMarkdown('![x](//evil.test/p.png) and [l](//evil.test/a)')

    expect(html).not.toContain('//evil.test')
    expect(html).toMatch(/<img[^>]*alt="x"/)
  })

  it('should keep the shiki dark-theme custom properties dark mode depends on', async () => {
    const code = await renderPostMarkdown('```ts\nconst a = 1\n```')

    expect(code).toContain('--shiki-dark:')
    expect(code).toContain('--shiki-dark-bg:')
  })

  it('should keep legitimate markdown and highlighted code intact', async () => {
    const html = await renderPostMarkdown('**bold** [link](https://guren.dev)')
    const code = await renderPostMarkdown('```ts\nconst a: number = 1\n```')

    expect(html).toContain('<strong>')
    expect(html).toContain('href="https://guren.dev"')
    expect(code).toContain('<pre')
    expect(code).toContain('color:')
  })
})
