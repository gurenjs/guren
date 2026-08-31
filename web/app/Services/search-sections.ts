// Split a rendered doc into the units the search index stores: one row per
// heading, carrying the text under it.
//
// The input is the *rendered* HTML rather than the markdown source, and that
// is the whole point. Heading ids come from `createSlugger()`, which numbers
// repeated headings within a render (`setup`, `setup-1`, …) and slugs the
// parsed *inline HTML* of the heading, not its markdown. Recomputing that
// here would mean reimplementing marked's inline parser and its numbering,
// and any drift would send `#anchor` deep links to the wrong place. Reading
// the ids back out of the HTML makes them right by construction — and, as a
// side effect, a `##` inside a fenced code block cannot be mistaken for a
// heading, because by this point it is text inside a `<pre>`.

/** Emitted by the markdown renderer as `<h2 id="slug">text</h2>`. */
const HEADING_OPEN = /<h([1-3])\s+id="([^"]*)"\s*>/giu

/** Diagram source, not prose: it would rank on words nobody is looking for. */
const MERMAID_BLOCK = /<pre class="mermaid">[\s\S]*?<\/pre>/giu

/**
 * Tags that do not interrupt a word. Everything else is a block boundary and
 * becomes whitespace — without that, `…/routing</p><h3>Controllers` collapses
 * into one nonsense token. Inline tags must *not* become whitespace, or shiki's
 * per-token `<span>`s would shred every identifier in the docs.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'del', 'dfn', 'em',
  'i', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong',
  'sub', 'sup', 'time', 'u', 'var', 'wbr',
])

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, body: string) => {
    if (body.startsWith('#')) {
      const codePoint = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10)
      // Lone surrogates and out-of-range values would corrupt the stored text.
      if (!Number.isInteger(codePoint) || codePoint < 1 || codePoint > 0x10ffff) {
        return match
      }
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
        return match
      }
      return String.fromCodePoint(codePoint)
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match
  })
}

/**
 * Collapse whitespace while keeping line structure: a run that crossed a
 * newline stays a newline, so stored snippets of code blocks are still
 * readable. FTS5 treats both as separators either way.
 */
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, (run) => (run.includes('\n') ? '\n' : ' ')).trim()
}

/**
 * Visible text of an HTML fragment. Safe to scan for `<` because everything
 * upstream is renderer output: literal angle brackets in prose and in code
 * blocks arrive here already escaped as entities.
 */
export function htmlToText(html: string): string {
  const source = html.replace(MERMAID_BLOCK, ' ')
  let out = ''
  let index = 0

  while (index < source.length) {
    const open = source.indexOf('<', index)
    if (open === -1) {
      out += decodeEntities(source.slice(index))
      break
    }
    const close = source.indexOf('>', open + 1)
    if (close === -1) {
      out += decodeEntities(source.slice(index))
      break
    }

    out += decodeEntities(source.slice(index, open))

    const name = /^<\/?\s*([a-z0-9]+)/iu.exec(source.slice(open, close + 1))?.[1]?.toLowerCase()
    if (name === undefined || !INLINE_TAGS.has(name)) {
      out += '\n'
    }

    index = close + 1
  }

  return collapseWhitespace(out)
}

export interface DocSectionText {
  /** The heading's `id`, used for the `#anchor` deep link. */
  anchor: string
  heading: string
  body: string
}

/**
 * Longest body stored in one row. Sections are prose under a single heading,
 * so almost none reach this; the cap exists because D1 refuses a SQL
 * statement over 100,000 bytes, and one row carries its body plus a token
 * stream several times its size. An oversized section becomes consecutive
 * rows sharing the same anchor — a phrase straddling the cut stops matching,
 * which is why the cut is deliberately far above the real distribution.
 */
export const MAX_SECTION_BODY = 4000

/** Break at the last whitespace before the limit, or mid-word if there is none. */
function chunkBody(body: string, limit: number): string[] {
  if (body.length <= limit) {
    return [body]
  }

  const chunks: string[] = []
  let rest = body
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    const breakAt = window.search(/\s\S*$/u)
    const cut = breakAt > limit / 2 ? breakAt : limit
    chunks.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest.length > 0) {
    chunks.push(rest)
  }
  return chunks
}

/**
 * One entry per `h1`–`h3` in document order. Text before the first heading is
 * dropped: the docs pipeline puts the title in an `h1` at the top, so there is
 * none in practice, and a section with no anchor could not be linked to.
 * Deeper headings (`h4`+) stay inside their parent section's body.
 */
export function splitDocSections(
  html: string,
  options: { maxBodyLength?: number } = {},
): DocSectionText[] {
  const limit = options.maxBodyLength ?? MAX_SECTION_BODY
  const headings: { anchor: string; heading: string; headingStart: number; bodyStart: number }[] = []

  HEADING_OPEN.lastIndex = 0
  for (const match of html.matchAll(HEADING_OPEN)) {
    const level = Number(match[1])
    const openEnd = match.index + match[0].length
    const closeAt = html.indexOf(`</h${level}`, openEnd)
    const closeEnd = closeAt === -1 ? -1 : html.indexOf('>', closeAt)
    if (closeEnd === -1) {
      continue
    }
    headings.push({
      anchor: match[2],
      heading: htmlToText(html.slice(openEnd, closeAt)),
      headingStart: match.index,
      bodyStart: closeEnd + 1,
    })
  }

  const sections: DocSectionText[] = []
  headings.forEach((heading, position) => {
    const bodyEnd = headings[position + 1]?.headingStart ?? html.length
    const body = htmlToText(html.slice(heading.bodyStart, bodyEnd))

    for (const chunk of chunkBody(body, limit)) {
      sections.push({ anchor: heading.anchor, heading: heading.heading, body: chunk })
    }
  })

  return sections
}
