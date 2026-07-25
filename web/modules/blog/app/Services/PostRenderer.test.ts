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
