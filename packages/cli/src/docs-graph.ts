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
import { scanDocs, type DocRef } from './docs-index'
import { resolveDocLink, runDocsCheck } from './docs-check'
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


export interface DocsGraphReportOptions {
  cwd?: string
  /** Narrow to the neighborhood of one model entity (case-insensitive). */
  entity?: string
  /** Narrow to the neighborhood of one app-root-relative path. */
  path?: string
}

export interface DocsGraphReport extends DocsGraph {
  /** The node ids the report was narrowed to, empty for the whole graph. */
  focus: string[]
}

/**
 * Whether a focus path names this node: exactly, or by falling under a
 * directory node (`app/Models/` covers `app/Models/Post.ts`).
 */
function nodeMatchesPath(node: DocsGraphNode, path: string): boolean {
  if (node.id === path) return true
  return node.id.endsWith('/') && path.startsWith(node.id)
}

/**
 * The docs relation graph, optionally narrowed to one node's
 * neighborhood — the agent-facing entry behind `guren docs:graph` and
 * the MCP tool. Narrowing answers the impact question directly: which
 * documents govern this path or entity, and which spec views regenerate
 * from it, before a rename or edit rather than after `check` fails.
 */
export async function buildDocsGraphReport(
  options: DocsGraphReportOptions = {},
): Promise<DocsGraphReport> {
  const cwd = options.cwd ?? process.cwd()
  const refs = await scanDocs(cwd)
  const checks = await runDocsCheck({ cwd })
  const { nodes, edges } = buildDocsGraph(refs, checks)

  const focus = nodes.filter((node) => {
    if (options.entity !== undefined && node.kind === 'entity') {
      return node.label.toLowerCase() === options.entity.toLowerCase()
    }
    if (options.path !== undefined && node.kind !== 'entity') {
      return nodeMatchesPath(node, options.path)
    }
    return false
  })

  if (options.entity === undefined && options.path === undefined) {
    return { focus: [], nodes, edges }
  }

  const focusIds = new Set(focus.map((node) => node.id))
  if (focusIds.size === 0) {
    // Narrowing was requested but nothing matched: echo the request so
    // the caller (and the renderer) can tell this apart from an
    // un-narrowed report of an empty bundle.
    return { focus: [options.entity ?? options.path ?? ''], nodes: [], edges: [] }
  }
  const keptEdges = edges.filter((edge) => focusIds.has(edge.from) || focusIds.has(edge.to))
  const keptIds = new Set(focusIds)
  for (const edge of keptEdges) {
    keptIds.add(edge.from)
    keptIds.add(edge.to)
  }

  return {
    focus: [...focusIds],
    nodes: nodes.filter((node) => keptIds.has(node.id)),
    edges: keptEdges,
  }
}

const VERDICT_GLYPH: Record<CheckStatus, string> = { pass: 'ok', warn: 'warn', fail: 'FAIL' }

/** Human-readable rendering, mirroring `guren context`'s markdown style. */
export function renderDocsGraphMarkdown(report: DocsGraphReport): string {
  const lines: string[] = ['# Docs Graph', '']

  if (report.focus.length > 0) {
    lines.push(`Neighborhood of: ${report.focus.join(', ')}`, '')
  }
  if (report.nodes.length === 0) {
    lines.push(
      report.focus.length === 0
        ? 'No OKF documents found under docs/.'
        : 'Nothing in the docs graph references this target.',
      '',
    )
    return lines.join('\n')
  }

  const byKind = new Map<string, DocsGraphNode[]>()
  for (const node of report.nodes) {
    const list = byKind.get(node.kind) ?? []
    list.push(node)
    byKind.set(node.kind, list)
  }
  const KIND_TITLES: Array<[DocsGraphNode['kind'], string]> = [
    ['doc', 'Documents'],
    ['entity', 'Entities'],
    ['code', 'Code'],
  ]
  for (const [kind, title] of KIND_TITLES) {
    const nodes = byKind.get(kind)
    if (!nodes) continue
    lines.push(`## ${title} (${nodes.length})`)
    for (const node of nodes) {
      const type = node.docType ? ` (${node.docType})` : ''
      lines.push(`- ${node.id}${node.kind === 'doc' && node.label !== node.id ? ` — ${node.label}` : ''}${type}`)
    }
    lines.push('')
  }

  lines.push(`## Relations (${report.edges.length})`)
  for (const edge of report.edges) {
    const verdict = edge.verdict === 'pass' ? '' : ` [${VERDICT_GLYPH[edge.verdict]}]`
    lines.push(`- ${edge.from} —${edge.relation}→ ${edge.to}${verdict}`)
  }
  lines.push('')

  return lines.join('\n')
}
