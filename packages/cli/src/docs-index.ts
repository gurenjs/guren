import { basename, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  parseDocFrontmatter,
  type DocFrontmatterValue,
  type DocMapping,
} from './docs-frontmatter'
import { extractMarkdownLinks } from './docs-links'
import {
  collectFiles,
  listAppRoots,
  toPosixRelative,
} from './discovery'

// docs-index is the package's doc-scanning facade: the parsers live in
// their own modules, but consumers (and the public index) reach them
// from here.
export {
  parseDocFrontmatter,
  type DocFrontmatterValue,
  type DocMapping,
} from './docs-frontmatter'
export { extractMarkdownLinks, localLinkTarget, readLinkDestination } from './docs-links'

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

function toStringList(value: DocFrontmatterValue | undefined): string[] {
  if (value === undefined) return []
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

function toScalar(value: DocFrontmatterValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}


function toActorEvent(value: DocFrontmatterValue | undefined): DocActorEvent | undefined {
  // Mapping recognition belongs to the parser: by the time a value gets
  // here every `{ … }` is already a DocMapping, so a string is one the
  // parser judged a plain scalar (a quoted one, say) and re-parsing it
  // would override that.
  if (value === undefined || typeof value === 'string' || Array.isArray(value)) return undefined
  return { by: value.by, at: value.at }
}

/**
 * OKF `verified` accepts a list of `{ by, at }` mappings or a bare
 * mapping; consumers must treat the bare form as a one-element list
 * (§5.2). Both the inline (`{ … }`) and block (indented) YAML forms
 * reach here.
 */
function toActorEvents(value: DocFrontmatterValue | undefined): DocActorEvent[] {
  if (value === undefined) return []
  return (Array.isArray(value) ? value : [value])
    .map((entry) => toActorEvent(entry))
    .filter((event): event is DocActorEvent => event !== undefined)
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
