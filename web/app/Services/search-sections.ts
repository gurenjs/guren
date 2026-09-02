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

/** The renderer emits `<h2 id="slug">`; a hand-written one may order its attributes freely. */
const HEADING_TAG = /^<h([1-3])\b/iu
const ID_ATTRIBUTE = /\bid\s*=\s*("([^"]*)"|'([^']*)')/iu

/** Diagram source, not prose: it would rank on words nobody is looking for. */
const MERMAID_BLOCK = /<pre class="mermaid">[\s\S]*?<\/pre>/giu

/**
 * Elements whose text is not prose either. Docs render with `sanitize: false`
 * because some pages embed raw HTML on purpose, so nothing upstream would
 * stop a `<script>` body from being indexed as though a reader could read it.
 */
const NON_PROSE_BLOCK = /<(script|style)\b[\s\S]*?<\/\1\s*>/giu

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
 * Where the tag opening at `start` ends, skipping over quoted attribute
 * values. A bare `indexOf('>')` ends the tag early on `<p title="1 > 0">`,
 * spilling the rest of the attribute into the text as `0">`.
 */
function tagEnd(html: string, start: number): number {
  let quote: string | undefined
  for (let index = start + 1; index < html.length; index++) {
    const char = html[index]
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      }
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return index
    }
  }
  return -1
}

/**
 * Visible text of an HTML fragment. Safe to scan for `<` because everything
 * upstream is renderer output: literal angle brackets in prose and in code
 * blocks arrive here already escaped as entities.
 */
export function htmlToText(html: string): string {
  const source = html.replace(MERMAID_BLOCK, ' ').replace(NON_PROSE_BLOCK, ' ')
  let out = ''
  let index = 0

  while (index < source.length) {
    const open = source.indexOf('<', index)
    const close = open === -1 ? -1 : tagEnd(source, open)
    // No tag left, or one that never closes: the rest is text either way.
    if (close === -1) {
      out += decodeEntities(source.slice(index))
      break
    }

    out += decodeEntities(source.slice(index, open))

    const name = /^<\/?\s*([a-z0-9]+)/iu.exec(source.slice(open, close + 1))?.[1] ?? ''
    if (!INLINE_TAGS.has(name.toLowerCase())) {
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
export function splitDocSections(html: string): DocSectionText[] {
  const headings: { anchor: string; heading: string; headingStart: number; bodyStart: number }[] = []

  // Walked with the same quote-aware scanner as the text, not matched with a
  // regex over the raw HTML. Docs render with `sanitize: false`, and a `<h2
  // id="…">` written inside an attribute value — a page documenting this
  // markup, say — otherwise invents a section and swallows the real heading
  // that follows it.
  for (let index = 0; index < html.length; ) {
    const open = html.indexOf('<', index)
    const close = open === -1 ? -1 : tagEnd(html, open)
    if (close === -1) {
      break
    }
    index = close + 1

    const tag = html.slice(open, close + 1)
    const level = HEADING_TAG.exec(tag)?.[1]
    const id = ID_ATTRIBUTE.exec(tag)
    if (level === undefined || id === null) {
      continue
    }

    // A heading with no closing tag is not a section boundary anyone can trust.
    const closeAt = html.indexOf(`</h${level}`, close + 1)
    if (closeAt === -1) {
      continue
    }

    headings.push({
      anchor: id[2] ?? id[3] ?? '',
      heading: htmlToText(html.slice(close + 1, closeAt)),
      headingStart: open,
      bodyStart: html.indexOf('>', closeAt) + 1,
    })
  }

  const sections: DocSectionText[] = []
  headings.forEach((heading, position) => {
    const bodyEnd = headings[position + 1]?.headingStart ?? html.length
    const body = htmlToText(html.slice(heading.bodyStart, bodyEnd))

    for (const chunk of chunkBody(body, MAX_SECTION_BODY)) {
      sections.push({ anchor: heading.anchor, heading: heading.heading, body: chunk })
    }
  })

  return sections
}
