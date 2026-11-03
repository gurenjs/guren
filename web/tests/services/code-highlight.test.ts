import { describe, expect, it } from 'vitest'

import { renderMarkdownToHtml } from '../../app/Services/MarkdownRenderer.js'
import { highlightAttribute, parseHighlightLines } from '../../config/code-highlight.js'

describe('parseHighlightLines', () => {
  it('expands ranges into sorted, unique line numbers', () => {
    expect(parseHighlightLines('5,2-3,3', 5)).toEqual({ lines: [2, 3, 5] })
  })

  it('refuses a range past the block, a reversed range and anything else', () => {
    expect(parseHighlightLines('6', 5)).toEqual({ error: 'highlight= line 6 is past the end of the block (5 lines)' })
    expect(parseHighlightLines('0', 5)).toMatchObject({ error: expect.stringContaining('before line 1') })
    expect(parseHighlightLines('3-1', 5)).toMatchObject({ error: expect.stringContaining('is empty') })
    expect(parseHighlightLines('1,', 5)).toMatchObject({ error: expect.stringContaining('takes line ranges') })
  })

  it('reads the attribute from anywhere after the language', () => {
    expect(highlightAttribute('ts file=a.ts highlight=2-4 fallback')).toBe('2-4')
    expect(highlightAttribute('ts file=a.ts')).toBeNull()
  })
})

// Real shiki: the transformer is what is under test.
describe('highlighted fences', () => {
  it('marks the named lines and flags the block', async () => {
    const html = await renderMarkdownToHtml('```ts highlight=2\nconst a = 1\nconst b = 2\nconst c = 3\n```\n')
    expect(html).toMatch(/<pre class="[^"]*\bhas-highlighted\b/u)
    expect(html.match(/class="line[^"]*"/gu)).toEqual(['class="line"', 'class="line highlighted"', 'class="line"'])
  })

  it('keeps the file caption beside the highlight', async () => {
    const html = await renderMarkdownToHtml('```ts file=app/a.ts highlight=1\nconst a = 1\n```\n')
    expect(html).toContain('doc-file-head')
    expect(html).toContain('class="line highlighted"')
  })

  it('fails the render on a line the block does not have', async () => {
    await expect(renderMarkdownToHtml('```ts highlight=3\nconst a = 1\n```\n')).rejects.toThrow('past the end of the block')
  })

  it('leaves a fence without the attribute unmarked', async () => {
    const html = await renderMarkdownToHtml('```ts\nconst a = 1\n```\n')
    expect(html).not.toContain('highlighted')
  })
})
