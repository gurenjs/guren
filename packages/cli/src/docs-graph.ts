/**
 * Relation graph over the OKF docs bundle (RFC 0005).
 *
 * A pure join of `scanDocs()` and `runDocsCheck()` output: docs become
 * nodes, their declared relations (`entities`, `related`, body markdown
 * links) become verdict-colored edges, and generated spec views gain
 * derivation edges from the code sources they regenerate from
 * (`SPEC_VIEWS[].sources` — the same descriptor the drift gate
 * uses). Consumed by the docs viewer endpoint; no filesystem access.
 */
import { posix } from 'node:path'
import type { DocRef } from './docs-index'
import { resolveDocLink } from './docs-check'
import type { CheckResult, CheckStatus } from './check-result'
import { SPEC_VIEWS } from './spec-generate'
import { SPEC_DIR } from './spec-artifact'

export interface DocsGraphNode {
  /** Doc path, `entity:<Name>`, or a code path/label. */
  id: string
  kind: 'doc' | 'entity' | 'code'
  label: string
  /** OKF `type`, doc nodes only — the viewer colors by it. */
  docType?: string
}

export interface DocsGraphEdge {
  from: string
  to: string
  /** governs = frontmatter declaration, links = body markdown link, derives = spec-view source. */
  relation: 'governs' | 'links' | 'derives'
  /** The verdict `runDocsCheck` recorded for this relation. */
  verdict: CheckStatus
}

export interface DocsGraph {
  nodes: DocsGraphNode[]
  edges: DocsGraphEdge[]
}

/** Display label for a path node; a trailing slash is not a segment. */
function basename(path: string): string {
  return posix.basename(path.replace(/\/$/, '')) || path
}

/**
 * The verdict `runDocsCheck` recorded under `key`. A key with no result
 * is a pass: the checker only emits per-link entries for problems (plus
 * one aggregate pass entry per document).
 */
function verdictOf(byKey: Map<string, CheckResult>, key: string): CheckStatus {
  return byKey.get(key)?.status ?? 'pass'
}

export function buildDocsGraph(refs: DocRef[], checks: CheckResult[]): DocsGraph {
  const byKey = new Map(checks.map((check) => [check.key, check]))
  const nodes: DocsGraphNode[] = []
  const edges: DocsGraphEdge[] = []
  const seen = new Set<string>()

  const addNode = (node: DocsGraphNode): void => {
    if (!seen.has(node.id)) {
      nodes.push(node)
      seen.add(node.id)
    }
  }

  for (const ref of refs) {
    addNode({
      id: ref.path,
      kind: 'doc',
      label: ref.title ?? basename(ref.path),
      docType: ref.type,
    })
  }

  const docPaths = new Set(refs.map((ref) => ref.path))

  for (const ref of refs) {
    for (const entity of ref.entities) {
      const id = `entity:${entity}`
      addNode({ id, kind: 'entity', label: entity })
      edges.push({
        from: ref.path,
        to: id,
        relation: 'governs',
        verdict: verdictOf(byKey, `docs-entity:${ref.path}:${entity}`),
      })
    }

    for (const target of ref.related) {
      addNode({ id: target, kind: 'code', label: basename(target) })
      edges.push({
        from: ref.path,
        to: target,
        relation: 'governs',
        verdict: verdictOf(byKey, `docs-related:${ref.path}:${target}`),
      })
    }

    for (const target of ref.links) {
      // A body link resolving to another scanned doc joins the two doc
      // nodes; anything else (code, assets, missing files) is a code node
      // keyed by its resolved app-root path so links from different docs
      // to the same file share one node.
      const id = resolveDocLink(ref.path, target) ?? target
      if (!docPaths.has(id)) addNode({ id, kind: 'code', label: basename(target) })
      edges.push({
        from: ref.path,
        to: id,
        relation: 'links',
        verdict: verdictOf(byKey, `docs-link:${ref.path}:${target}`),
      })
    }
  }

  // Derivation edges for generated spec views — only the app-root bundle
  // carries them (spec:generate writes to <root>/docs/spec).
  for (const view of SPEC_VIEWS) {
    const specPath = `${SPEC_DIR}/${view.fileName}`
    if (!docPaths.has(specPath)) continue
    // Several patterns can share a label (a root and a module schema are
    // both `db/schema.ts` to a reader), so the node set dedupes them.
    for (const { label } of view.sources) {
      addNode({ id: label, kind: 'code', label: basename(label) })
      if (!edges.some((edge) => edge.from === label && edge.to === specPath)) {
        edges.push({ from: label, to: specPath, relation: 'derives', verdict: 'pass' })
      }
    }
  }

  return { nodes, edges }
}
