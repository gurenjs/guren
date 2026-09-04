/**
 * Relation graph over the OKF docs bundle (RFC 0005).
 *
 * A pure join of `scanDocs()` and `runDocsCheck()` output; generated spec views
 * additionally gain derivation edges from `SPEC_VIEWS[].sources`, the same
 * descriptor the drift gate uses. `buildDocsGraph` does no filesystem access;
 * `loadDocsGraph` is the one filesystem pass shared by every consumer.
 */
import { posix } from 'node:path'
import { scanDocs, type DocRef } from './docs-index'
import { resolveDocLink, runDocsCheck } from './docs-check'
import { matchesGlob } from './glob-match'
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
 * The verdict `runDocsCheck` recorded under `key`. A key with no result is a
 * pass: the checker only emits per-link entries for problems.
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
      // Anything that is not another scanned doc becomes a code node keyed by
      // its resolved app-root path, so links from different docs share it.
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

  // Only the app-root bundle carries these: spec:generate writes to
  // <root>/docs/spec.
  for (const view of SPEC_VIEWS) {
    const specPath = `${SPEC_DIR}/${view.fileName}`
    if (!docPaths.has(specPath)) continue
    // Several patterns can share a label (a root and a module schema are both
    // `db/schema.ts` to a reader), so the node set dedupes them.
    for (const { label } of view.sources) {
      addNode({ id: label, kind: 'code', label: basename(label) })
      if (!edges.some((edge) => edge.from === label && edge.to === specPath)) {
        edges.push({ from: label, to: specPath, relation: 'derives', verdict: 'pass' })
      }
    }
  }

  return { nodes, edges }
}

export interface LoadedDocsGraph {
  refs: DocRef[]
  checks: CheckResult[]
  graph: DocsGraph
}

/** One filesystem pass behind every graph consumer. */
export async function loadDocsGraph(cwd: string): Promise<LoadedDocsGraph> {
  const refs = await scanDocs(cwd)
  const checks = await runDocsCheck({ cwd, refs })
  return { refs, checks, graph: buildDocsGraph(refs, checks) }
}

export interface DocsGraphReportOptions {
  cwd?: string
  /** Narrow to the neighborhood of one model entity (case-insensitive). */
  entity?: string
  /** Narrow to the neighborhood of one app-root-relative path. */
  path?: string
}

export interface DocsGraphQuery {
  entity?: string
  path?: string
}

export interface DocsGraphReport extends DocsGraph {
  /** Echo of the narrowing request; absent when the whole graph was asked for. */
  query?: DocsGraphQuery
  /** The node ids the query matched, empty when nothing did (or no query). */
  focus: string[]
}

/**
 * Whether a query path names this node. Exact ids and directory nodes match
 * literally; glob nodes go through the matcher `check --docs` uses; and a
 * derivation-source node matches when a `SPEC_VIEWS` pattern carrying its label
 * accepts the path — the label alone cannot say which files feed a view
 * (module schemas all collapse to `db/schema.ts`).
 */
function nodeMatchesPath(
  node: DocsGraphNode,
  path: string,
  derivedLabels: ReadonlySet<string>,
): boolean {
  if (node.id === path || node.id === `${path}/`) return true
  if (derivedLabels.has(node.id)) return true
  if (node.id.includes('*')) return matchesGlob(path, node.id)
  return path.startsWith(node.id.endsWith('/') ? node.id : `${node.id}/`)
}

/**
 * The docs relation graph, optionally narrowed to one node's neighborhood —
 * the entry behind `guren docs:graph` and the MCP tool. Narrowing answers the
 * impact question: which documents govern this path or entity, and which spec
 * views regenerate from it.
 */
export async function buildDocsGraphReport(
  options: DocsGraphReportOptions = {},
): Promise<DocsGraphReport> {
  const cwd = options.cwd ?? process.cwd()
  const entity = options.entity?.trim() || undefined
  const path = options.path?.trim() || undefined
  if (entity !== undefined && path !== undefined) {
    throw new Error('Narrow by either entity or path, not both.')
  }

  const { graph } = await loadDocsGraph(cwd)
  const { nodes, edges } = graph
  if (entity === undefined && path === undefined) {
    return { focus: [], nodes, edges }
  }

  const focusIds = new Set<string>()
  if (entity !== undefined) {
    const wanted = entity.toLowerCase()
    for (const node of nodes) {
      if (node.kind === 'entity' && node.label.toLowerCase() === wanted) focusIds.add(node.id)
    }
  } else if (path !== undefined) {
    const target = posix.normalize(path.replace(/\\/g, '/'))
    const derivedLabels = new Set(
      SPEC_VIEWS.flatMap((view) => view.sources)
        .filter((source) => source.pattern.test(target))
        .map((source) => source.label),
    )
    for (const node of nodes) {
      if (node.kind !== 'entity' && nodeMatchesPath(node, target, derivedLabels)) {
        focusIds.add(node.id)
      }
    }
  }

  const query = entity !== undefined ? { entity } : { path }
  if (focusIds.size === 0) {
    return { query, focus: [], nodes: [], edges: [] }
  }
  const keptEdges = edges.filter((edge) => focusIds.has(edge.from) || focusIds.has(edge.to))
  const keptIds = new Set(focusIds)
  for (const edge of keptEdges) {
    keptIds.add(edge.from)
    keptIds.add(edge.to)
  }

  return {
    query,
    focus: [...focusIds],
    nodes: nodes.filter((node) => keptIds.has(node.id)),
    edges: keptEdges,
  }
}

const VERDICT_GLYPH: Record<Exclude<CheckStatus, 'pass'>, string> = { warn: 'warn', fail: 'FAIL' }

const KIND_TITLES: Array<[DocsGraphNode['kind'], string]> = [
  ['doc', 'Documents'],
  ['entity', 'Entities'],
  ['code', 'Code'],
]

/** Human-readable rendering, mirroring `guren context`'s markdown style. */
export function renderDocsGraphMarkdown(report: DocsGraphReport): string {
  const lines: string[] = ['# Docs Graph', '']
  const requested = report.query?.entity ?? report.query?.path

  if (report.focus.length > 0) {
    lines.push(`Neighborhood of: ${report.focus.join(', ')}`, '')
  }
  if (report.nodes.length === 0) {
    lines.push(
      requested === undefined
        ? 'No OKF documents found under docs/.'
        : `Nothing in the docs graph references "${requested}".`,
      '',
    )
    return lines.join('\n')
  }

  for (const [kind, title] of KIND_TITLES) {
    const nodes = report.nodes.filter((node) => node.kind === kind)
    if (nodes.length === 0) continue
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
