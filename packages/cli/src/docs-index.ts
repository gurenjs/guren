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

function unquote(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/**
 * Strip a trailing YAML comment (` # …`) from an unquoted value. Quoted
 * values keep their content verbatim — `unquote` handles them afterwards.
 */
function stripInlineComment(value: string): string {
  if (value.startsWith("'") || value.startsWith('"')) return value
  return value.replace(/\s+#.*$/, '').trim()
}

/** Split an inline array body on commas that are not inside quotes. */
function splitInlineArray(inner: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: string | null = null

  for (const char of inner) {
    if (quote) {
      current += char
      if (char === quote) quote = null
    } else if (char === "'" || char === '"') {
      current += char
      quote = char
    } else if (char === ',') {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  parts.push(current)

  return parts.map((part) => unquote(part.trim())).filter((part) => part !== '')
}

/**
 * Parse a leading `---` frontmatter block. Deliberately a minimal YAML
 * subset — scalars, inline arrays (`[a, b]`), and block lists (`- item`) —
 * the frozen vocabulary the docs convention needs, same philosophy as
 * `glob-match.ts`. Anything else is ignored, never an error.
 */
export function parseDocFrontmatter(
  source: string,
): { data: Record<string, string | string[]>; body: string } | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source)
  if (!match) return null

  const data: Record<string, string | string[]> = {}
  let currentList: string[] | null = null

  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue

    const item = /^\s*-\s+(.+)$/.exec(line)
    if (item && currentList) {
      const entry = stripInlineComment(item[1].trim())
      if (entry) currentList.push(unquote(entry))
      continue
    }

    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) {
      currentList = null
      continue
    }

    const key = kv[1]
    const value = stripInlineComment(kv[2].trim())
    currentList = null

    if (value === '') {
      const list: string[] = []
      data[key] = list
      currentList = list
    } else if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = splitInlineArray(value.slice(1, -1))
    } else {
      data[key] = unquote(value)
    }
  }

  return { data, body: source.slice(match[0].length) }
}

function toStringList(value: string | string[] | undefined): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value : [value]
}

function toScalar(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse a YAML inline map (`{ by: human:ada, at: 2026-06-25T09:00:00Z }`)
 * into a flat string record — the shape OKF's `generated` and `verified`
 * entries use. Values may contain colons (datetimes, actor ids), so each
 * part splits on the first `key:` prefix only. Null when the value is not
 * an inline map.
 */
function parseInlineMap(value: string): Record<string, string> | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null
  const record: Record<string, string> = {}
  for (const part of splitInlineArray(trimmed.slice(1, -1))) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(part)
    if (kv) record[kv[1]] = unquote(kv[2].trim())
  }
  return record
}

function toActorEvent(value: string | string[] | undefined): DocActorEvent | undefined {
  if (typeof value !== 'string') return undefined
  const map = parseInlineMap(value)
  if (!map) return undefined
  return { by: map.by, at: map.at }
}

/**
 * OKF `verified` accepts a list of `{ by, at }` maps or a bare mapping;
 * consumers must treat the bare form as a one-element list (§5.2).
 */
function toActorEvents(value: string | string[] | undefined): DocActorEvent[] {
  if (value === undefined) return []
  const entries = Array.isArray(value) ? value : [value]
  return entries
    .map((entry) => toActorEvent(entry))
    .filter((event): event is DocActorEvent => event !== undefined)
}

const MARKDOWN_LINK_REGEX = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i

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
  let match: RegExpExecArray | null
  while ((match = MARKDOWN_LINK_REGEX.exec(withoutCode)) !== null) {
    const target = match[1]
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
              staleAfter: toScalar(data.stale_after),
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
