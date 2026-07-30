import { basename, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  collectFiles,
  listAppRoots,
  toPosixRelative,
} from './discovery'

const MARKDOWN_EXTENSIONS = new Set(['.md'])

/** One `{ by, at }` event from OKF's `generated` / `verified` families. */
export interface DocActorEvent {
  /** Actor per OKF §7: `human:<id>`, `process:<id>`, or `<producer>/<version>`. */
  by?: string
  /** ISO 8601 datetime, verbatim. */
  at?: string
}

/**
 * A markdown document under `docs/` (or `modules/<name>/docs/`) with its
 * parsed frontmatter — an OKF (Open Knowledge Format v0.2) concept
 * document. OKF requires only `type`; `title`/`description`/`resource`/
 * `tags` are its recommended fields, `generated`/`verified`/`status`/
 * `stale_after` its trust and lifecycle families, and `entities`/`related`
 * are Guren's producer extensions. The reserved filenames `index.md` and
 * `log.md` are never concepts and are excluded from the scan. Documents
 * without frontmatter are still listed (`hasFrontmatter: false`) but
 * never linked.
 */
export interface DocRef {
  /** Path relative to the app root (POSIX separators). */
  path: string
  /** Module whose `docs/` directory contains the file, or null for the root `docs/`. */
  module: string | null
  /** Frontmatter `title`, falling back to the first `# heading` in the body. */
  title?: string
  /** OKF `type` — the one field the format requires (adr, context, guide, spec, …). */
  type?: string
  /** OKF lifecycle `status`: draft | stable | deprecated. Absent means stable. */
  status?: string
  description?: string
  /** Canonical URI of the asset the concept describes, when it has one. */
  resource?: string
  tags: string[]
  /** Model class names this document governs (frontmatter `entities`). */
  entities: string[]
  /** Paths or globs this document governs (frontmatter `related`). */
  related: string[]
  /** OKF `generated` — who/what last wrote the content, and when. */
  generated?: DocActorEvent
  /** OKF `verified` — confirmation events; a bare mapping parses as one entry. */
  verified: DocActorEvent[]
  /** OKF `stale_after` (YYYY-MM-DD) — content is stale on/after this day. */
  staleAfter?: string
  /**
   * Local markdown link targets in the body — OKF's relation mechanism.
   * External links, bare anchors, and links inside code are excluded;
   * fragments are stripped.
   */
  links: string[]
  hasFrontmatter: boolean
}

/** OKF reserved filenames (§3.1) — navigation, never concept documents. */
const RESERVED_FILENAMES = new Set(['index.md', 'log.md'])

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
export type DocFrontmatterValue = string | string[] | DocMapping | DocMapping[] | Array<string | DocMapping>

/** A `{ by, at }`-shaped mapping, however it was written. */
export type DocMapping = Record<string, string>

const KEY_VALUE_RE = /^([A-Za-z_][\w-]*):\s*(.*)$/

/** Whatever an inline scalar position holds: a mapping, a list, or a string. */
function parseInlineValue(value: string): DocFrontmatterValue {
  const mapping = parseInlineMapping(value)
  if (mapping) return mapping
  if (value.startsWith('[') && value.endsWith(']')) {
    const entries = splitInlineArray(value.slice(1, -1))
    const mapped = entries.map((entry) => parseInlineMapping(entry) ?? entry)
    return mapped as DocFrontmatterValue
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

  // The top-level key whose indented body is being collected, and where
  // the collected entries go. A key can turn out to hold a list or a
  // mapping; whichever appears first wins.
  let openKey: string | null = null
  let openList: Array<string | DocMapping> | null = null
  let openMapping: DocMapping | null = null
  // The mapping started by the most recent `- key: value` item, so its
  // sibling lines (`  at: …`) join it rather than starting a new entry.
  let itemMapping: DocMapping | null = null
  // A `-` whose mapping body starts on the next line.
  let pendingItem = false

  const closeBlock = (): void => {
    if (openKey !== null && openMapping !== null) data[openKey] = openMapping
    openKey = null
    openList = null
    openMapping = null
    itemMapping = null
    pendingItem = false
  }

  for (const rawLine of match[1].split(/\r?\n/)) {
    // Blank lines and whole-line comments never change structure.
    if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue

    const item = /^(\s*)-\s*(.*)$/.exec(rawLine)
    if (item && openList) {
      const entry = stripInlineComment(item[2].trim())
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
        openList.push(inline)
        itemMapping = null
        continue
      }
      // `- by: human:ada` opens a mapping the following indented
      // siblings extend.
      const kv = KEY_VALUE_RE.exec(entry)
      if (kv && kv[2] !== '') {
        itemMapping = { [kv[1]]: unquote(kv[2].trim()) }
        openList.push(itemMapping)
        continue
      }
      openList.push(unquote(entry))
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

    if (indented && openKey !== null) {
      // The first entry under a dash-only item starts that item's mapping.
      if (pendingItem && openList !== null) {
        itemMapping = { [key]: unquote(value) }
        openList.push(itemMapping)
        pendingItem = false
        continue
      }
      // A sibling of the current list item's mapping…
      if (itemMapping !== null) {
        itemMapping[key] = unquote(value)
        continue
      }
      // …otherwise a block-mapping entry under the open key.
      if (openList !== null && openList.length === 0) {
        openMapping ??= {}
        openMapping[key] = unquote(value)
        continue
      }
    }

    closeBlock()

    if (value === '') {
      // Could still become a list or a mapping; the next line decides.
      const list: Array<string | DocMapping> = []
      data[key] = list
      openKey = key
      openList = list
    } else {
      data[key] = parseInlineValue(value)
    }
  }
  closeBlock()

  return { data, body: source.slice(match[0].length) }
}

function toStringList(value: DocFrontmatterValue | undefined): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  const entries: Array<string | DocMapping> = value
  return entries.filter((entry): entry is string => typeof entry === 'string')
}

function toScalar(value: DocFrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}


function toActorEvent(value: DocFrontmatterValue | undefined): DocActorEvent | undefined {
  if (value === undefined || Array.isArray(value)) return undefined
  const mapping = typeof value === 'string' ? parseInlineMapping(value) : value
  if (!mapping) return undefined
  return { by: mapping.by, at: mapping.at }
}

/**
 * OKF `verified` accepts a list of `{ by, at }` mappings or a bare
 * mapping; consumers must treat the bare form as a one-element list
 * (§5.2). Both the inline (`{ … }`) and block (indented) YAML forms
 * reach here.
 */
function toActorEvents(value: DocFrontmatterValue | undefined): DocActorEvent[] {
  if (value === undefined) return []
  const entries: Array<DocFrontmatterValue> = Array.isArray(value) ? value : [value]
  return entries
    .map((entry) => toActorEvent(entry))
    .filter((event): event is DocActorEvent => event !== undefined)
}

const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i

/** The punctuation a markdown backslash escape may precede (CommonMark). */
const ESCAPABLE = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/

/**
 * The destination of a markdown link starting at `open` (the index of
 * `(`), honoring balanced parentheses so `./use-(legacy)-api.md` survives.
 * Returns null when the link is unterminated or contains whitespace.
 *
 * Exported so anything that renders these links resolves exactly the
 * same target this extraction produced.
 */
export function readLinkDestination(
  text: string,
  open: number,
): { target: string; end: number } | null {
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
  if (target === '') return null
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
export function extractMarkdownLinks(body: string): string[] {
  const withoutCode = body.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  const targets = new Set<string>()

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

    const target = destination.target
    if (URL_SCHEME_REGEX.test(target) || target.startsWith('#')) continue
    const withoutFragment = target.split('#')[0]
    if (withoutFragment !== '') targets.add(withoutFragment)
  }

  return [...targets]
}

/**
 * Every markdown file under the root `docs/` plus each module's `docs/`,
 * with parsed frontmatter. Missing directories resolve to nothing — apps
 * without a docs convention see zero refs, never an error.
 */
export async function scanDocs(cwd: string): Promise<DocRef[]> {
  const roots = await listAppRoots(cwd)

  const groups = await Promise.all(
    roots.map(async (root) => {
      const files = await collectFiles(resolve(root.dir, 'docs'), MARKDOWN_EXTENSIONS)
      return Promise.all(
        files
          .filter((file) => !RESERVED_FILENAMES.has(basename(file).toLowerCase()))
          .map(async (file): Promise<DocRef> => {
            const source = await readFile(file, 'utf-8')
            const parsed = parseDocFrontmatter(source)
            const body = parsed?.body ?? source
            const data = parsed?.data ?? {}
            return {
              path: toPosixRelative(cwd, file),
              module: root.module,
              title: toScalar(data.title) ?? /^#\s+(.+)$/m.exec(body)?.[1].trim(),
              type: toScalar(data.type),
              status: toScalar(data.status),
              description: toScalar(data.description),
              resource: toScalar(data.resource),
              tags: toStringList(data.tags),
              entities: toStringList(data.entities),
              related: toStringList(data.related),
              generated: toActorEvent(data.generated),
              verified: toActorEvents(data.verified),
              // Present but not a scalar (`stale_after:` with no value)
              // becomes '' so the checker can flag it rather than read
              // it as absent.
              staleAfter:
                'stale_after' in data ? (toScalar(data.stale_after) ?? '') : undefined,
              links: parsed ? extractMarkdownLinks(body) : [],
              hasFrontmatter: parsed !== null,
            }
          }),
      )
    }),
  )

  return groups.flat().sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Reverse index: lowercased entity class name → documents whose
 * frontmatter `entities` list names it.
 */
export function buildEntityDocIndex(refs: DocRef[]): Map<string, DocRef[]> {
  const index = new Map<string, DocRef[]>()
  for (const ref of refs) {
    for (const entity of ref.entities) {
      const key = entity.toLowerCase()
      const list = index.get(key) ?? []
      list.push(ref)
      index.set(key, list)
    }
  }
  return index
}

const DOCS_TAG_REGEX = /@docs\s+([^\s*'"`)]+)/g

/**
 * `@docs <path>` tags in a source file — the code-side half of the doc
 * link. Regex-based like the inertia page scan (a tag in a string literal
 * is a false positive we accept); paths are app-root-relative by
 * convention.
 */
export function extractDocsTags(source: string): string[] {
  const tags = new Set<string>()
  let match: RegExpExecArray | null
  while ((match = DOCS_TAG_REGEX.exec(source)) !== null) {
    tags.add(match[1])
  }
  return [...tags]
}
