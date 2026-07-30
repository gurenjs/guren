import { describe, expect, it } from 'bun:test'
import { renderDocHtml } from '../src/docs-render'

describe('renderDocHtml', () => {
  it('renders headings one level down, paragraphs, and inline spans', () => {
    const html = renderDocHtml(`## Decision

We keep **bold** choices and \`code\` spans, *emphasised*.
`)

    expect(html).toContain('<h3>Decision</h3>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<em>emphasised</em>')
  })

  it('joins wrapped lines into one paragraph', () => {
    const html = renderDocHtml('First line\ncontinues here.\n\nSecond paragraph.\n')

    expect(html).toContain('<p>First line continues here.</p>')
    expect(html).toContain('<p>Second paragraph.</p>')
  })

  it('renders local links with a data-target for graph navigation', () => {
    const html = renderDocHtml('See [orders](/adr/0002-orders.md) for detail.\n')

    expect(html).toContain('<a class="md-link" data-target="/adr/0002-orders.md">orders</a>')
  })

  it('renders bullet lists with one nesting level', () => {
    const html = renderDocHtml(`- top item
  - nested item
- another top
`)

    expect(html).toContain('<li>top item</li>')
    expect(html).toContain('<li class="nested">nested item</li>')
    expect(html).toContain('<li>another top</li>')
  })

  it('renders pipe tables inside a scroll container', () => {
    const html = renderDocHtml(`| Column | Type |
|--------|------|
| id | serial |
`)

    expect(html).toContain('<div class="table-scroll"><table>')
    expect(html).toContain('<th>Column</th>')
    expect(html).toContain('<td>serial</td>')
  })

  it('passes mermaid fences through and escapes other code fences', () => {
    const html = renderDocHtml(`\`\`\`mermaid
erDiagram
  posts }o--|| users : author
\`\`\`

\`\`\`bash
bunx guren check --docs
\`\`\`
`)

    expect(html).toContain('<pre class="mermaid">erDiagram')
    expect(html).toContain('<pre class="code"><code>bunx guren check --docs</code></pre>')
  })

  it('escapes quotes so a link target cannot break out of the attribute', () => {
    const html = renderDocHtml('[hover]("onmouseover="globalThis.pwned=1)\n')

    expect(html).not.toContain('onmouseover="')
    expect(html).toContain('data-target="&quot;onmouseover=&quot;globalThis.pwned=1"')
  })

  it('keeps balanced parentheses in a link destination', () => {
    const html = renderDocHtml('[migration](./use-(legacy)-api.md)\n')

    expect(html).toContain('data-target="./use-(legacy)-api.md"')
    expect(html).toContain('>migration</a>')
  })

  it('emits the resolved target when a resolver is supplied', () => {
    const html = renderDocHtml('See [orders](../adr/0002.md#joins).\n', {
      resolveLink: (target) => (target === '../adr/0002.md#joins' ? 'docs/adr/0002.md' : target),
    })

    expect(html).toContain('data-target="docs/adr/0002.md"')
  })

  it('escapes HTML in prose and code, and drops comments', () => {
    const html = renderDocHtml(`<!-- generated banner -->

A paragraph with <script>alert(1)</script> inside.

\`\`\`
<div>raw</div>
\`\`\`
`)

    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('&lt;div&gt;raw&lt;/div&gt;')
    expect(html).not.toContain('generated banner')
  })
})
