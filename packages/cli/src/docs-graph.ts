/**
 * Relation graph over the OKF docs bundle (RFC 0005).
 *
 * A pure join of `scanDocs()` and `runDocsCheck()` output: docs become
 * nodes, their declared relations (`entities`, `related`, body markdown
 * links) become verdict-colored edges, and generated spec views gain
 * derivation edges from the code sources they regenerate from
 * (`SPEC_VIEWS[].sourceLabels` — the same descriptor the drift gate
 * uses). Consumed by the docs viewer endpoint; no filesystem access.
 */
import type { DocRef } from './docs-index'
import { resolveDocLink } from './docs-check'
import type { CheckResult } from './check-result'
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
  verdict: 'pass' | 'warn' | 'fail'
}

export interface DocsGraph {
  nodes: DocsGraphNode[]
  edges: DocsGraphEdge[]
}

function basename(path: string): string {
  const trimmed = path.replace(/\/$/, '')
  return trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
}

/**
 * The verdict `runDocsCheck` recorded under `key`. A key with no result
 * is a pass: the checker only emits per-link entries for problems (plus
 * one aggregate pass entry per document).
 */
function verdictOf(checks: CheckResult[], key: string): DocsGraphEdge['verdict'] {
  const hit = checks.find((check) => check.key === key)
  if (!hit) return 'pass'
  return hit.status === 'fail' ? 'fail' : hit.status === 'warn' ? 'warn' : 'pass'
}

export function buildDocsGraph(refs: DocRef[], checks: CheckResult[]): DocsGraph {
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
        verdict: verdictOf(checks, `docs-entity:${ref.path}:${entity}`),
      })
    }

    for (const target of ref.related) {
      addNode({ id: target, kind: 'code', label: basename(target) })
      edges.push({
        from: ref.path,
        to: target,
        relation: 'governs',
        verdict: verdictOf(checks, `docs-related:${ref.path}:${target}`),
      })
    }

    for (const target of ref.links) {
      // A body link resolving to another scanned doc joins the two doc
      // nodes; anything else (code, assets, missing files) is a code node
      // keyed by its resolved app-root path so links from different docs
      // to the same file share one node.
      const resolved = resolveDocLink(ref.path, target)
      const id = resolved !== null && docPaths.has(resolved) ? resolved : (resolved ?? target)
      if (!docPaths.has(id)) addNode({ id, kind: 'code', label: basename(target) })
      edges.push({
        from: ref.path,
        to: id,
        relation: 'links',
        verdict: verdictOf(checks, `docs-link:${ref.path}:${target}`),
      })
    }
  }

  // Derivation edges for generated spec views — only the app-root bundle
  // carries them (spec:generate writes to <root>/docs/spec).
  for (const view of SPEC_VIEWS) {
    const specPath = `${SPEC_DIR}/${view.fileName}`
    if (!docPaths.has(specPath)) continue
    for (const label of view.sourceLabels) {
      addNode({ id: label, kind: 'code', label: basename(label) })
      edges.push({ from: label, to: specPath, relation: 'derives', verdict: 'pass' })
    }
  }

  return { nodes, edges }
}
