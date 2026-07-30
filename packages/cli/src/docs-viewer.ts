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
import { scanDocs, type DocActorEvent, type DocRef } from './docs-index'
import { runDocsCheck, resolveDocLink } from './docs-check'
import { buildDocsGraph, type DocsGraphEdge, type DocsGraphNode } from './docs-graph'
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
  trustTier: DocTrustTier
  /** Rendered body; the leading H1 is dropped (the panel header carries the title). */
  html: string
}

export interface DocsViewerData {
  nodes: DocsGraphNode[]
  edges: DocsGraphEdge[]
  docs: DocsViewerDoc[]
}

const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/
const LEADING_H1 = /^\s*(?:<!--[\s\S]*?-->\s*)?#\s+.*$/m

export async function buildDocsViewerData(cwd: string): Promise<DocsViewerData> {
  const refs = await scanDocs(cwd)
  const checks = await runDocsCheck({ cwd })
  const { nodes, edges } = buildDocsGraph(refs, checks)

  const docs = await Promise.all(
    refs.map(async (ref): Promise<DocsViewerDoc> => {
      const source = await readFile(resolve(cwd, ref.path), 'utf-8').catch(() => '')
      const body = source.replace(FRONTMATTER_BLOCK, '').replace(LEADING_H1, '')
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
        trustTier: docTrustTier(ref),
        // Links carry the app-root path they resolve to, so the viewer
        // navigates by map lookup instead of re-deriving the resolution
        // rules client-side (where they would drift).
        html: renderDocHtml(body, {
          resolveLink: (target) => resolveDocLink(ref.path, target) ?? target,
        }),
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
