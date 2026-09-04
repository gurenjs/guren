/**
 * Heading-id slugger, hardened against HTML smuggled through inline markdown
 * (RFC 0012). Tags are stripped to a fixed point because a single pass can
 * splice a new tag together (`<scr<x>ipt>` becomes `<script>`), and the strip
 * is a linear scan because the obvious `/<[^>]*>/g` is quadratic on `<`-heavy
 * input with no closing bracket.
 */

/** One pass of tag removal; an unclosed `<` tail is kept verbatim. */
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
 * repeated headings get `-1`, `-2`, … suffixes, skipping any a literal heading
 * already claimed. A heading that slugs to nothing falls back to `heading` and
 * is disambiguated the same way — deterministic, unlike the random suffix the
 * ported implementation used.
 */
export function createSlugger(): (text: string) => string {
  const usedSlugs = new Set<string>()

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
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}-]/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    slug = slug || 'heading'

    if (usedSlugs.has(slug)) {
      let suffix = 1
      while (usedSlugs.has(`${slug}-${suffix}`)) {
        suffix++
      }
      slug = `${slug}-${suffix}`
    }
    usedSlugs.add(slug)
    return slug
  }
}
