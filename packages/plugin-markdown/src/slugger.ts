/**
 * Heading-id slugger, hardened against HTML smuggled through inline markdown.
 *
 * Ported from guren.dev's docs pipeline (RFC 0012). Two properties matter:
 * tags are stripped to a fixed point because a single pass can splice a new
 * tag together (`<scr<x>ipt>` becomes `<script>` after one removal), and the
 * strip itself is a linear scan because the obvious `/<[^>]*>/g` regex is
 * quadratic on `<`-heavy input with no closing bracket.
 */

/**
 * One pass of tag removal. Unclosed `<` tails are kept verbatim, matching
 * the regex form (which requires a closing `>`).
 */
function stripHtmlTagsOnce(html: string): string {
  let out = ''
  let i = 0
  while (i < html.length) {
    const open = html.indexOf('<', i)
    if (open === -1) {
      return out + html.slice(i)
    }
    const close = html.indexOf('>', open + 1)
    if (close === -1) {
      return out + html.slice(i)
    }
    out += html.slice(i, open)
    i = close + 1
  }
  return out
}

/**
 * Returns a slugify function whose uniqueness state is scoped to one render:
 * repeated headings get `-1`, `-2`, … suffixes. A heading that slugs to
 * nothing (all punctuation, all markup) falls back to `heading`, which the
 * same uniqueness counter then disambiguates — deterministic, unlike the
 * random suffix the ported implementation used.
 */
export function createSlugger(): (text: string) => string {
  const seenSlugs = new Map<string, number>()

  return (text: string): string => {
    let stripped = text
    let previous: string
    do {
      previous = stripped
      stripped = stripHtmlTagsOnce(stripped)
    } while (stripped !== previous)

    let slug = stripped
      .toLowerCase()
      .trim()
      .replace(/[\s]+/g, '-')
      .replace(/[^\p{L}\p{N}\-]/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    slug = slug || 'heading'

    const count = seenSlugs.get(slug) ?? 0
    seenSlugs.set(slug, count + 1)
    if (count > 0) {
      slug = `${slug}-${count}`
    }
    return slug
  }
}
