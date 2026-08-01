/**
 * Payload assembly for the docs viewer endpoint (RFC 0005).
 *
 * `buildDocsViewerData` bundles everything the UI needs into one
 * payload — graph nodes/edges with verdicts, plus every document's
 * frontmatter and rendered body — so the server exposes a single
 * whole-bundle route with no path parameters (and therefore no
 * traversal surface).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { parseDocFrontmatter } from './docs-frontmatter'
import { localLinkTarget } from './docs-links'
import type { DocActorEvent, DocRef } from './docs-index'
import { resolveDocLink } from './docs-check'
import { loadDocsGraph, type DocsGraphEdge, type DocsGraphNode } from './docs-graph'
import { renderDocHtml } from './docs-render'

export type DocTrustTier = 'unverified' | 'machine-confirmed' | 'human-reviewed'

/** OKF §5.3: derived from `verified`, keyed off the `human:` actor prefix. */
export function docTrustTier(ref: Pick<DocRef, 'verified'>): DocTrustTier {
  if (ref.verified.length === 0) return 'unverified'
  return ref.verified.some((event) => event.by?.startsWith('human:'))
    ? 'human-reviewed'
    : 'machine-confirmed'
}

export interface DocsViewerDoc {
  path: string
  module: string | null
  title?: string
  type?: string
  status?: string
  description?: string
  tags: string[]
  entities: string[]
  related: string[]
  links: string[]
  generated?: DocActorEvent
  verified: DocActorEvent[]
  staleAfter?: string
  /**
   * Whether `stale_after` has passed, as `guren check --docs` judged it.
   * Derived here so the UI does not re-implement the calendar-day rule
   * (a bare `Date.parse` accepts `2026-02-30` and rolls it forward).
   */
  stale: boolean
  trustTier: DocTrustTier
  /** Rendered body; the leading H1 is dropped (the panel header carries the title). */
  html: string
}

export interface DocsViewerData {
  nodes: DocsGraphNode[]
  edges: DocsGraphEdge[]
  docs: DocsViewerDoc[]
}

/** Both match one character, so neither can backtrack the way a quantifier can. */
const WHITESPACE = /\s/
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

function skipWhitespace(body: string, from: number): number {
  let cursor = from
  while (cursor < body.length && WHITESPACE.test(body[cursor])) cursor += 1
  return cursor
}

/** Where the `#` heading starting at `at` ends, or -1 when there is none. */
function headingEnd(body: string, at: number): number {
  if (body[at] !== '#') return -1

  const text = skipWhitespace(body, at + 1)
  if (text === at + 1) return -1

  let cursor = text
  while (cursor < body.length && !LINE_TERMINATOR.test(body[cursor])) cursor += 1
  return cursor
}

/**
 * The body without its first H1, and without the HTML comment that may precede
 * it — the panel header carries the title, so the body H1 would repeat it.
 *
 * Scanned rather than matched with `/^\s*(?:<!--[\s\S]*?-->\s*)?#\s+.*$/m`,
 * whose lazy comment body was re-scanned from every line start: a doc holding
 * many `<!--` took time quadratic in its length. Every `-->` is classified once
 * here instead, which is enough, because whether a heading may follow a comment
 * turns only on where that comment ends and never on where it opened.
 */
function stripLeadingH1(body: string): string {
  const closers: Array<{ at: number; end: number }> = []
  for (let found = body.indexOf('-->'); found !== -1; found = body.indexOf('-->', found + 3)) {
    const end = headingEnd(body, skipWhitespace(body, found + 3))
    if (end !== -1) closers.push({ at: found, end })
  }

  let next = 0
  let lineStart = 0
  for (;;) {
    const from = skipWhitespace(body, lineStart)

    if (body.startsWith('<!--', from)) {
      while (next < closers.length && closers[next].at < from + 4) next += 1
      if (next < closers.length) return body.slice(0, lineStart) + body.slice(closers[next].end)
    }

    const end = headingEnd(body, from)
    if (end !== -1) return body.slice(0, lineStart) + body.slice(end)

    // A multiline `^` anchors after every line terminator, `\r` included.
    let cursor = lineStart
    while (cursor < body.length && !LINE_TERMINATOR.test(body[cursor])) cursor += 1
    if (cursor === body.length) return body
    lineStart = cursor + 1
  }
}

/**
 * The graph node id a body link points at. `localLinkTarget` is the
 * same filter `scanDocs` ran to derive the edge, so the rendered target
 * and the node id cannot disagree; anything it rejects, and anything
 * that fails to resolve, keeps its literal text.
 */
function resolveViewerLink(docPath: string, target: string): string {
  const local = localLinkTarget(target)
  if (local === null) return target
  return resolveDocLink(docPath, local) ?? target
}

export async function buildDocsViewerData(cwd: string): Promise<DocsViewerData> {
  const {
    refs,
    checks,
    graph: { nodes, edges },
  } = await loadDocsGraph(cwd)
  const staleDocs = new Set(
    checks.filter((check) => check.key.startsWith('docs-stale:')).map((check) => check.filePath),
  )

  const docs = await Promise.all(
    refs.map(async (ref): Promise<DocsViewerDoc> => {
      const source = await readFile(resolve(cwd, ref.path), 'utf-8').catch(() => '')
      const body = stripLeadingH1(parseDocFrontmatter(source)?.body ?? source)
      return {
        path: ref.path,
        module: ref.module,
        title: ref.title,
        type: ref.type,
        status: ref.status,
        description: ref.description,
        tags: ref.tags,
        entities: ref.entities,
        related: ref.related,
        links: ref.links,
        generated: ref.generated,
        verified: ref.verified,
        staleAfter: ref.staleAfter,
        stale: staleDocs.has(ref.path),
        trustTier: docTrustTier(ref),
        // Links carry the app-root path they resolve to, so the viewer
        // navigates by map lookup instead of re-deriving the resolution
        // rules client-side (where they would drift).
        html: renderDocHtml(body, { resolveLink: (target) => resolveViewerLink(ref.path, target) }),
      }
    }),
  )

  return { nodes, edges, docs }
}

/**
 * Absolute path of the viewer's static UI shell, shipped with this
 * package. `assets/` sits next to both `src/` and `dist/`, so the
 * relative hop works from source (dev, tests) and from the build alike.
 */
export function docsViewerAssetPath(): string {
  return fileURLToPath(new URL('../assets/docs-viewer/index.html', import.meta.url))
}
