import { resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  collectFiles,
  listModuleNames,
  toPosixRelative,
} from './discovery'

const MARKDOWN_EXTENSIONS = new Set(['.md'])

/**
 * A markdown document under `docs/` (or `modules/<name>/docs/`) with its
 * parsed frontmatter. Documents without frontmatter are still listed
 * (`hasFrontmatter: false`) but never linked or validated.
 */
export interface DocRef {
  /** Path relative to the app root (POSIX separators). */
  path: string
  /** Module whose `docs/` directory contains the file, or null for the root `docs/`. */
  module: string | null
  /** First `# heading` in the body, if any. */
  title?: string
  kind?: string
  status?: string
  /** Model class names this document governs (frontmatter `entities`). */
  entities: string[]
  /** Paths or globs this document governs (frontmatter `related`). */
  related: string[]
  /** Frontmatter `last_reviewed` (YYYY-MM-DD), verbatim. */
  lastReviewed?: string
  hasFrontmatter: boolean
}

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
  let currentListKey: string | null = null

  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue

    const item = /^\s*-\s+(.+)$/.exec(line)
    if (item && currentListKey) {
      ;(data[currentListKey] as string[]).push(unquote(item[1].trim()))
      continue
    }

    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) {
      currentListKey = null
      continue
    }

    const key = kv[1]
    const value = kv[2].trim()

    if (value === '') {
      data[key] = []
      currentListKey = key
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim()
      data[key] = inner === '' ? [] : inner.split(',').map((part) => unquote(part.trim()))
      currentListKey = null
    } else {
      data[key] = unquote(value)
      currentListKey = null
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
 * Every markdown file under the root `docs/` plus each module's `docs/`,
 * with parsed frontmatter. Missing directories resolve to nothing — apps
 * without a docs convention see zero refs, never an error.
 */
export async function scanDocs(cwd: string): Promise<DocRef[]> {
  const roots = [
    { module: null as string | null, dir: resolve(cwd, 'docs') },
    ...(await listModuleNames(cwd)).map((name) => ({
      module: name as string | null,
      dir: resolve(cwd, 'modules', name, 'docs'),
    })),
  ]

  const groups = await Promise.all(
    roots.map(async (root) => {
      const files = await collectFiles(root.dir, MARKDOWN_EXTENSIONS)
      return Promise.all(
        files.map(async (file): Promise<DocRef> => {
          const source = await readFile(file, 'utf-8')
          const parsed = parseDocFrontmatter(source)
          const body = parsed?.body ?? source
          const data = parsed?.data ?? {}
          return {
            path: toPosixRelative(cwd, file),
            module: root.module,
            title: /^#\s+(.+)$/m.exec(body)?.[1].trim(),
            kind: toScalar(data.kind),
            status: toScalar(data.status),
            entities: toStringList(data.entities),
            related: toStringList(data.related),
            lastReviewed: toScalar(data.last_reviewed),
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
