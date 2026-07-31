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

const LEADING_H1 = /^\s*(?:<!--[\s\S]*?-->\s*)?#\s+.*$/m
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
      // The panel header carries the title, so the body H1 would repeat it.
      const body = (parseDocFrontmatter(source)?.body ?? source).replace(LEADING_H1, '')
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
