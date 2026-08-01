/**
 * The minimal YAML subset the OKF docs convention needs — scalars,
 * inline collections (`[a, b]`, `{ by: x }`), block lists (`- item`,
 * including `- by: x` mappings), and block mappings (indented
 * `key: value` lines) — same frozen-vocabulary philosophy as
 * `glob-match.ts`. Pure syntax: what the fields *mean* (actors,
 * lifecycle, relations) is `docs-index.ts` and `docs-check.ts`
 * territory. Anything unrecognized is ignored, never an error.
 */

/**
 * Strip the surrounding quotes from a YAML scalar, undoing the escapes
 * each quoting style defines: `\"` inside double quotes, `''` inside
 * single quotes.
 */
function unquote(value: string): string {
  const quote = value[0]
  if ((quote !== "'" && quote !== '"') || value.length < 2 || !value.endsWith(quote)) {
    return value
  }
  const inner = value.slice(1, -1)
  return quote === '"' ? inner.replace(/\\(.)/g, '$1') : inner.replace(/''/g, "'")
}

/**
 * The index just past a quoted scalar starting at `start`, honoring the
 * escapes each style defines. `-1` when the scalar is unterminated.
 */
function endOfQuoted(value: string, start: number): number {
  const quote = value[start]
  for (let index = start + 1; index < value.length; index += 1) {
    if (quote === '"' && value[index] === '\\') {
      index += 1
      continue
    }
    if (value[index] !== quote) continue
    // `''` inside a single-quoted scalar is an escaped quote, not the end.
    if (quote === "'" && value[index + 1] === "'") {
      index += 1
      continue
    }
    return index + 1
  }
  return -1
}

/**
 * Strip a trailing YAML comment. A `#` only starts one at the beginning
 * or after whitespace, and never inside a quoted scalar — including a
 * scalar nested in an array, mapping, or list item (`tags: ["C # lang"]`),
 * which is why this scans rather than testing the first character.
 */
function stripInlineComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]

    if (char === '"' || char === "'") {
      const end = endOfQuoted(value, index)
      if (end === -1) break
      index = end - 1
      continue
    }

    if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trim()
    }
  }
  return value.trim()
}

/**
 * Split an inline collection body on commas that separate entries —
 * commas inside quotes or nested `{}`/`[]` belong to an entry.
 */
function splitInlineArray(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let depth = 0

  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index]

    if (char === "'" || char === '"') {
      const end = endOfQuoted(inner, index)
      const span = end === -1 ? inner.slice(index) : inner.slice(index, end)
      current += span
      index += span.length - 1
      continue
    }

    if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }

    current += char
  }
  parts.push(current)

  return parts.map((part) => unquote(part.trim())).filter((part) => part !== '')
}

/**
 * Parse a YAML inline mapping (`{ by: human:ada, at: 2026-06-25T09:00:00Z }`)
 * into a flat string record — the shape OKF's `generated` and `verified`
 * entries use. Values may contain colons (datetimes, actor ids), so each
 * part splits on the first `key:` prefix only. Null when the value is not
 * an inline mapping.
 */
function parseInlineMapping(value: string): DocMapping | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  const record: DocMapping = {}
  for (const part of splitInlineArray(trimmed.slice(1, -1))) {
    const kv = KEY_VALUE_RE.exec(part)
    if (kv) record[kv[1]] = unquote(stripInlineComment(kv[2].trim()))
  }
  return record
}

/** A frontmatter value: scalar, list, or (for `generated`/`verified`) a mapping. */
export type DocFrontmatterValue = string | DocMapping | Array<string | DocMapping>

/** A `{ by, at }`-shaped mapping, however it was written. */
export type DocMapping = Record<string, string>

// Value is captured raw (callers trim); a `\s*` between `:` and `(.*)`
// would overlap with `.` and give the regex polynomial backtracking.
const KEY_VALUE_RE = /^([A-Za-z_][\w-]*):(.*)$/

/** Whatever an inline scalar position holds: a mapping, a list, or a string. */
function parseInlineValue(value: string): DocFrontmatterValue {
  const mapping = parseInlineMapping(value)
  if (mapping) return mapping
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitInlineArray(value.slice(1, -1)).map((entry) => parseInlineMapping(entry) ?? entry)
  }
  return unquote(value)
}

/**
 * Parse a leading `---` frontmatter block. Deliberately a minimal YAML
 * subset — scalars, inline collections (`[a, b]`, `{ by: x }`), block
 * lists (`- item`, including `- by: x` mappings), and block mappings
 * (indented `key: value` lines) — the frozen vocabulary the docs
 * convention needs, same philosophy as `glob-match.ts`. Anything else is
 * ignored, never an error.
 */
export function parseDocFrontmatter(
  source: string,
): { data: Record<string, DocFrontmatterValue>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match) return null

  const data: Record<string, DocFrontmatterValue> = {}

  // The top-level key whose indented body is being collected, with the
  // entries gathered so far. A key can turn out to hold a list or a
  // mapping; whichever appears first wins.
  let open: { key: string; list: Array<string | DocMapping>; mapping: DocMapping | null } | null =
    null
  // The mapping started by the most recent `- key: value` item, so its
  // sibling lines (`  at: …`) join it rather than starting a new entry.
  let itemMapping: DocMapping | null = null
  // A `-` whose mapping body starts on the next line.
  let pendingItem = false

  const closeBlock = (): void => {
    if (open?.mapping) data[open.key] = open.mapping
    open = null
    itemMapping = null
    pendingItem = false
  }

  for (const rawLine of match[1].split(/\r?\n/)) {
    // Blank lines and whole-line comments never change structure.
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue

    const item = /^[ \t]*-(.*)$/.exec(rawLine)
    if (item && open) {
      const entry = stripInlineComment(item[1].trim())
      if (!entry) {
        // `-` alone opens an entry whose body is on the following
        // indented lines; the mapping is created when the first one
        // arrives, so a stray dash contributes nothing.
        itemMapping = null
        pendingItem = true
        continue
      }
      pendingItem = false
      const inline = parseInlineMapping(entry)
      if (inline) {
        open.list.push(inline)
        itemMapping = null
        continue
      }
      // `- by: human:ada` opens a mapping the following indented
      // siblings extend.
      const kv = KEY_VALUE_RE.exec(entry)
      const kvValue = kv ? kv[2].trim() : ''
      if (kv && kvValue !== '') {
        itemMapping = { [kv[1]]: unquote(kvValue) }
        open.list.push(itemMapping)
        continue
      }
      open.list.push(unquote(entry))
      itemMapping = null
      continue
    }

    const indented = /^\s/.test(rawLine)
    const kv = KEY_VALUE_RE.exec(rawLine.trim())
    if (!kv) {
      closeBlock()
      continue
    }

    const key = kv[1]
    const value = stripInlineComment(kv[2].trim())

    if (indented && open) {
      // The first entry under a dash-only item starts that item's mapping.
      if (pendingItem) {
        itemMapping = { [key]: unquote(value) }
        open.list.push(itemMapping)
        pendingItem = false
        continue
      }
      // A sibling of the current list item's mapping…
      if (itemMapping !== null) {
        itemMapping[key] = unquote(value)
        continue
      }
      // …otherwise a block-mapping entry under the open key.
      if (open.list.length === 0) {
        open.mapping ??= {}
        open.mapping[key] = unquote(value)
        continue
      }
    }

    closeBlock()

    if (value === '') {
      // Could still become a list or a mapping; the next line decides.
      const list: Array<string | DocMapping> = []
      data[key] = list
      open = { key, list, mapping: null }
    } else {
      data[key] = parseInlineValue(value)
    }
  }
  closeBlock()

  return { data, body: source.slice(match[0].length) }
}

