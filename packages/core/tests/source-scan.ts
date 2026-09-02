/**
 * Source-form scanning for the tests that keep a cross-package constant a
 * single source. Nothing at runtime distinguishes a value read from a
 * constant from one re-typed as a literal, so those tests read the engine's
 * own text — the same reason the MCP endpoint gate pins the source form of
 * `process.env.NODE_ENV`. Shared rather than copied per test file: a second
 * copy of a scanner is the bug those tests exist to prevent.
 */

/**
 * Replace every comment body with spaces, leaving string and template
 * literals untouched. A scanner rather than a regex sweep because the two
 * classes nest both ways: `//` inside a string opens no comment, and a quote
 * inside a comment opens no string.
 */
export function blankComments(source: string): string {
  let out = ''
  let index = 0

  while (index < source.length) {
    const char = source[index]!
    const next = source[index + 1]

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      const end = endOfLiteral(source, index, char)
      out += source.slice(index, end)
      index = end
      continue
    }

    out += char
    index += 1
  }

  return out
}

/**
 * End index (exclusive) of the literal opening at `start`. Template literals
 * are taken whole, interpolations included: the shapes these scans look for
 * live in exactly that text, and a comment cannot legally sit between a
 * backtick and its `${`.
 */
function endOfLiteral(source: string, start: number, quote: string): number {
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    // An unterminated single- or double-quoted literal cannot span a line;
    // stopping here keeps a stray apostrophe from swallowing the rest.
    if (char === '\n' && quote !== '`') return index
    index += 1
  }
  return source.length
}
