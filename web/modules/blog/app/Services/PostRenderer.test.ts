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
  // carries URLs into href/src.
  const vectors: Array<[string, string]> = [
    ['raw script tag', '<script>alert(1)</script>'],
    ['inline event handler', 'x <img src=y onerror=alert(2)> z'],
    ['javascript: link', '[click](javascript:alert(1))'],
    ['javascript: image', '![x](javascript:alert(2))'],
    ['data: html uri', '[d](data:text/html;base64,PHN2Zz4=)'],
    ['vbscript: link', '[v](vbscript:msgbox(1))'],
    ['mixed-case javascript:', '[U](JaVaScRiPt:alert(4))'],
    ['entity-encoded javascript:', '[e](java&#115;cript:alert(5))'],
    ['iframe', '<iframe src=//evil.test></iframe>'],
    ['positioned style attribute', '<p style="position:fixed;top:0">x</p>'],
  ]

  for (const [name, markdown] of vectors) {
    it(`should neutralize ${name}`, async () => {
      const html = await renderPostMarkdown(markdown)

      expect(html).not.toMatch(/<script|<iframe|onerror=|javascript:|vbscript:|data:text\/html|position:fixed/i)
    })
  }

  it('should keep legitimate markdown and highlighted code intact', async () => {
    const html = await renderPostMarkdown('**bold** [link](https://guren.dev)')
    const code = await renderPostMarkdown('```ts\nconst a: number = 1\n```')

    expect(html).toContain('<strong>')
    expect(html).toContain('href="https://guren.dev"')
    expect(code).toContain('<pre')
    expect(code).toContain('color:')
  })
})
