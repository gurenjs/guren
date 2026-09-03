const REGEX_SPECIAL_CHARS = /[.+^${}()|[\]\\]/g

// Placeholders protect '**/' , '**', and '*' from the special-char escaping
// pass below; none of these code points can appear in a real glob string.
const GLOBSTAR_SLASH_TOKEN = '\x00GLOBSTAR_SLASH\x00'
const GLOBSTAR_TOKEN = '\x00GLOBSTAR\x00'
const STAR_TOKEN = '\x00STAR\x00'

const compiledCache = new Map<string, RegExp>()

/**
 * Compile a minimal glob into a RegExp matched against POSIX-style relative
 * paths. Only `*` (within one segment) and `**` (any number, including zero) —
 * the frozen vocabulary `guren.arch.ts` layers are built from. No brace
 * expansion, character classes or negation; anything else is a literal.
 */
export function compileGlob(glob: string): RegExp {
  const cached = compiledCache.get(glob)
  if (cached) return cached

  const tokenized = glob
    .replace(/\*\*\//g, GLOBSTAR_SLASH_TOKEN)
    .replace(/\*\*/g, GLOBSTAR_TOKEN)
    .replace(/\*/g, STAR_TOKEN)

  const escaped = tokenized.replace(REGEX_SPECIAL_CHARS, '\\$&')

  const pattern = escaped
    .split(GLOBSTAR_SLASH_TOKEN)
    .join('(?:.*/)?')
    .split(GLOBSTAR_TOKEN)
    .join('.*')
    .split(STAR_TOKEN)
    .join('[^/]*')

  const regex = new RegExp(`^${pattern}$`)
  compiledCache.set(glob, regex)
  return regex
}

export function matchesGlob(relPath: string, glob: string): boolean {
  return compileGlob(glob).test(relPath)
}

/** Matches `relPath` against one glob or an array of globs (OR semantics). */
export function matchesAnyGlob(relPath: string, globs: string | string[]): boolean {
  const patterns = Array.isArray(globs) ? globs : [globs]
  return patterns.some((glob) => matchesGlob(relPath, glob))
}
