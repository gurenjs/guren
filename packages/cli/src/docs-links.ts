/**
 * Markdown link scanning for the OKF docs convention: inline links
 * (balanced parens, optional titles, angle-bracket destinations,
 * CommonMark backslash escapes) and link reference definitions.
 * Pure markdown — which targets count as bundle-local is the one
 * OKF-flavored decision here (`localLinkTarget`), shared by the
 * graph, the checker, and the viewer so they cannot disagree.
 */

const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i

/**
 * A link reference definition line (`[label]: ./target.md "Title"`).
 * Indented up to three spaces, per CommonMark.
 */
const LINK_DEFINITION_RE = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>\n]*)>|(\S+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/

/** The punctuation a markdown backslash escape may precede (CommonMark). */
const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/

/**
 * The destination of a markdown link starting at `open` (the index of
 * `(`), honoring balanced parentheses so `./use-(legacy)-api.md` survives.
 * Returns null when the link is unterminated or contains whitespace.
 * Exported for the renderer, so a rendered link and the graph edge
 * derived from it always name the same target.
 */
export function readLinkDestination(
  text: string,
  open: number,
): { target: string; end: number } | null {
  // `<…>` wraps a destination that may contain spaces.
  if (text[open + 1] === '<') {
    const close = text.indexOf('>', open + 2)
    if (close === -1) return null
    const wrapped = text.slice(open + 2, close)
    if (wrapped.includes('\n')) return null
    return readAfterDestination(text, close + 1, wrapped)
  }

  const target: string[] = []
  let depth = 0
  let index = open

  for (; index < text.length; index += 1) {
    const char = text[index]

    if (char === '\\' && ESCAPABLE.test(text[index + 1] ?? '')) {
      // A markdown escape yields the literal character, so `\)` cannot
      // close the destination. A backslash before anything else stays
      // part of the path — dropping it would erase the separators in a
      // Windows-style target before containment checks ever see them.
      if (depth > 0) target.push(text[index + 1])
      index += 1
      continue
    }

    if (char === '(') {
      depth += 1
      if (depth > 1) target.push(char)
      continue
    }

    if (char === ')') {
      depth -= 1
      if (depth === 0) return { target: target.join(''), end: index }
      target.push(char)
      continue
    }

    // Whitespace ends the destination; what follows may be an optional
    // title (`[x](./a.md "Title")`), which is skipped to the closing
    // paren rather than making the whole link unparseable.
    if (/\s/.test(char)) return readAfterDestination(text, index, target.join(''))

    target.push(char)
  }

  return null
}

/**
 * What may legally follow a destination: nothing, or a single quoted
 * title, before the closing paren. Anything else means this was never a
 * link (`[x](./a.md some words)`), so reporting it as one would produce
 * a phantom broken-link warning.
 */
const TRAILING_TITLE_RE = /^\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))?\s*\)/

function readAfterDestination(
  text: string,
  from: number,
  target: string,
): { target: string; end: number } | null {
  if (target.trim() === '') return null
  const rest = text.slice(from)
  const match = TRAILING_TITLE_RE.exec(rest)
  if (!match || match[0].includes('\n')) return null
  return { target, end: from + match[0].length - 1 }
}

/**
 * Local markdown link targets in a doc body — OKF expresses relations as
 * plain markdown links, so these are graph edges worth validating. Code
 * fences and inline code are stripped first (docs about the docs
 * convention quote example links), external URLs and bare `#anchor` links
 * are skipped, and fragments are dropped from what remains.
 */
/**
 * The bundle-local path a markdown link target names, or null when it
 * points outside the bundle — an external URL, a protocol-relative
 * `//host/path`, or a bare `#anchor`. Fragments are dropped.
 *
 * Exported because anything that renders these links has to reach the
 * same answer this extraction did: the graph keys its nodes on the
 * result, so a renderer computing it differently would emit targets
 * that match no node.
 */
export function localLinkTarget(target: string): string | null {
  if (URL_SCHEME_REGEX.test(target) || target.startsWith('#') || target.startsWith('//')) return null
  const withoutFragment = target.split('#')[0]
  return withoutFragment === '' ? null : withoutFragment
}

export function extractMarkdownLinks(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const targets = new Set<string>()

  const add = (target: string): void => {
    const local = localLinkTarget(target)
    if (local !== null) targets.add(local)
  }

  for (const line of withoutCode.split(/\r?\n/)) {
    const definition = LINK_DEFINITION_RE.exec(line)
    if (definition) add(definition[1] ?? definition[2])
  }

  let index = 0
  while (index < withoutCode.length) {
    const open = withoutCode.indexOf('[', index)
    if (open === -1) break
    const close = withoutCode.indexOf(']', open)
    const destination =
      close !== -1 && withoutCode[close + 1] === '('
        ? readLinkDestination(withoutCode, close + 1)
        : null
    if (destination === null) {
      index = open + 1
      continue
    }
    index = destination.end + 1
    add(destination.target)
  }

  return [...targets]
}
