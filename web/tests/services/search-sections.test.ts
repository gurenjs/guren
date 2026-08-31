import { describe, expect, it, vi } from 'vitest'

import {
  htmlToText,
  splitDocSections,
  MAX_SECTION_BODY,
} from '../../app/Services/search-sections.js'

// Real shiki would only slow these down; the pipeline shape is what matters.
const mockCodeToHtml = vi.fn(async (code: string) => `<pre class="shiki"><code>${code}</code></pre>`)
vi.mock('shiki', () => ({ codeToHtml: mockCodeToHtml }))

const { renderMarkdownToHtml } = await import('../../app/Services/MarkdownRenderer.js')

describe('htmlToText', () => {
  it('keeps inline tags from breaking a word apart', () => {
    // shiki wraps every code token in its own <span>; treating those as block
    // boundaries would shred each identifier in the docs into fragments.
    expect(htmlToText('<p><span>create</span><span>D1</span>Database</p>')).toBe(
      'createD1Database',
    )
  })

  it('separates text across a block boundary', () => {
    expect(htmlToText('<p>routing</p><h3 id="c">Controllers</h3>')).toBe(
      'routing\nControllers',
    )
  })

  it('decodes entities', () => {
    expect(htmlToText('<p>a &amp; b &lt;T&gt; &#39;x&#39;</p>')).toBe("a & b <T> 'x'")
  })

  it('leaves an unknown numeric reference alone rather than corrupting it', () => {
    expect(htmlToText('<p>&#xD800; &#0;</p>')).toBe('&#xD800; &#0;')
  })

  it('drops mermaid diagram source', () => {
    // Diagram source is not prose, and it ranks on words nobody searches for.
    expect(htmlToText('<p>before</p><pre class="mermaid">graph TD;\nA--&gt;B;</pre>')).toBe(
      'before',
    )
  })
})

describe('splitDocSections', () => {
  it('reads the anchor out of the rendered id, numbering included', async () => {
    // The renderer numbers repeated headings (`setup`, `setup-1`). Recomputing
    // that here would mean reimplementing marked's inline parser *and* its
    // numbering, and any drift sends deep links to the wrong heading.
    const html = await renderMarkdownToHtml(
      '# Guide\n\nIntro.\n\n## Setup\n\nFirst.\n\n## Setup\n\nSecond.\n',
    )

    expect(splitDocSections(html).map((section) => section.anchor)).toEqual([
      'guide',
      'setup',
      'setup-1',
    ])
    for (const section of splitDocSections(html)) {
      expect(html).toContain(`id="${section.anchor}"`)
    }
  })

  it('does not treat a heading inside a code fence as a heading', async () => {
    const html = await renderMarkdownToHtml('# Guide\n\n```md\n## Not a heading\n```\n')

    expect(splitDocSections(html)).toHaveLength(1)
    expect(splitDocSections(html)[0].body).toContain('## Not a heading')
  })

  it('keeps a section body bounded by the next heading', async () => {
    const html = await renderMarkdownToHtml(
      '# Guide\n\nIntro.\n\n## Setup\n\nFirst.\n\n### Detail\n\nDeep.\n',
    )
    const sections = splitDocSections(html)

    expect(sections.map((section) => section.body)).toEqual(['Intro.', 'First.', 'Deep.'])
    expect(sections.map((section) => section.heading)).toEqual(['Guide', 'Setup', 'Detail'])
  })

  it('splits an oversized section into rows sharing its anchor', () => {
    const body = 'word '.repeat(MAX_SECTION_BODY)
    const sections = splitDocSections(`<h2 id="long">Long</h2><p>${body}</p>`)

    expect(sections.length).toBeGreaterThan(1)
    expect(new Set(sections.map((section) => section.anchor))).toEqual(new Set(['long']))
    for (const section of sections) {
      expect(section.body.length).toBeLessThanOrEqual(MAX_SECTION_BODY)
    }
  })

  it('splits a section with no whitespace to break on', () => {
    const sections = splitDocSections(
      `<h2 id="blob">Blob</h2><p>${'x'.repeat(MAX_SECTION_BODY * 2 + 7)}</p>`,
    )

    expect(sections.length).toBe(3)
    expect(sections.map((section) => section.body.length)).toEqual([
      MAX_SECTION_BODY,
      MAX_SECTION_BODY,
      7,
    ])
  })

  it('drops content that precedes the first heading', () => {
    // It could not be linked to: a result needs an anchor to scroll to.
    expect(splitDocSections('<p>orphan</p><h2 id="a">A</h2><p>body</p>')).toEqual([
      { anchor: 'a', heading: 'A', body: 'body' },
    ])
  })
})
