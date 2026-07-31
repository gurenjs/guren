import { describe, expect, it } from 'bun:test'
import { extractMarkdownLinks } from '../src/docs-links'

describe('extractMarkdownLinks', () => {
  it('extracts local link and image targets, stripping fragments', () => {
    const links = extractMarkdownLinks(`
See [orders](/adr/0002-orders.md#joins) and [the model](../../app/Models/Post.ts).
![diagram](./diagram.png)
`)

    expect(links).toEqual(['/adr/0002-orders.md', '../../app/Models/Post.ts', './diagram.png'])
  })

  it('skips external URLs, bare anchors, and links inside code', () => {
    const links = extractMarkdownLinks(`
[dashboard](https://example.com/dash) [mail](mailto:a@b.c) [above](#schema)

\`\`\`markdown
[example](/tables/customers.md)
\`\`\`

Inline \`[code](/not-a-link.md)\` too, but [real](./real.md).
`)

    expect(links).toEqual(['./real.md'])
  })

  it('keeps balanced parentheses inside a destination', () => {
    expect(extractMarkdownLinks('[migration](./use-(legacy)-api.md)')).toEqual([
      './use-(legacy)-api.md',
    ])
  })

  it('accepts an optional link title and escaped parentheses', () => {
    expect(extractMarkdownLinks('[guide](./guide.md "More details")')).toEqual(['./guide.md'])
    expect(extractMarkdownLinks('[esc](./escaped\\)paren.md)')).toEqual(['./escaped)paren.md'])
  })

  it('extracts link reference definitions, so that form stays validated', () => {
    const links = extractMarkdownLinks(`See [replacement][new].

[new]: ./0002-replacement.md
[titled]: <./with spaces.md> "A title"
`)

    expect(links).toEqual(['./0002-replacement.md', './with spaces.md'])
  })

  it('accepts an angle-bracket destination', () => {
    expect(extractMarkdownLinks('[design](<./design docs/overview.md>)')).toEqual([
      './design docs/overview.md',
    ])
  })

  it('treats a protocol-relative URL as external', () => {
    expect(extractMarkdownLinks('[external](//example.com/docs)')).toEqual([])
  })

  it('keeps backslashes that are not markdown escapes', () => {
    // Dropping them would erase the separators in a Windows-style
    // target before the containment checks in docs-check ever see them.
    expect(extractMarkdownLinks(String.raw`[a](..\app\Architecture.md)`)).toEqual([
      String.raw`..\app\Architecture.md`,
    ])
    // Escapable punctuation still unescapes.
    expect(extractMarkdownLinks(String.raw`[a](./esc\)paren.md)`)).toEqual(['./esc)paren.md'])
  })

  it('rejects unquoted text after a destination, which is not a link', () => {
    expect(extractMarkdownLinks('[not a link](./missing.md arbitrary words)')).toEqual([])
  })

  it('deduplicates repeated targets', () => {
    expect(extractMarkdownLinks('[a](./x.md) and [b](./x.md#frag)')).toEqual(['./x.md'])
  })
})
