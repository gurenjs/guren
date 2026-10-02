/**
 * The graph the page draws, derived from the payload. Pure: nothing here touches the document,
 * so the grouping and the viewer-only nodes can be tested without one.
 */
import type { DocsGraphEdge, DocsGraphNode } from '../docs-graph'
import type { DocsViewerData } from '../docs-viewer'
import type { DocsViewerOpenPlan } from '../docs-viewer-plans'

export type Verdict = DocsGraphEdge['verdict']

export interface TestMember {
  id: string
  label: string
  verdict: Verdict
}

/** A node as drawn: the payload's kinds, and `openplan`, which only the viewer has (RFC 0030 §7). */
export interface ViewNode {
  id: string
  kind: DocsGraphNode['kind'] | 'openplan'
  label: string
  docType?: string
  /** A group of acceptance tests that verify the same documents. */
  members?: TestMember[]
  searchText?: string
  plan?: DocsViewerOpenPlan
}

export interface ViewEdge {
  from: string
  to: string
  relation: DocsGraphEdge['relation'] | 'plans'
  verdict: Verdict
}

export interface GraphView {
  nodes: ViewNode[]
  edges: ViewEdge[]
}

/** The kinds the filter toggles name; a spec or plan doc and an open plan are told apart from other docs. */
export type ToggleKind = 'doc' | 'spec' | 'plan' | 'entity' | 'code' | 'test'
export const TOGGLE_KINDS: readonly ToggleKind[] = ['doc', 'spec', 'plan', 'entity', 'code', 'test']

export function kindOf(node: ViewNode): ToggleKind {
  if (node.kind === 'openplan') return 'plan'
  if (node.kind === 'doc' && (node.docType === 'spec' || node.docType === 'plan')) return node.docType
  return node.kind
}

const VERDICT_RANK: Record<Verdict, number> = { pass: 0, warn: 1, fail: 2 }

export function worstVerdict(verdicts: readonly Verdict[]): Verdict {
  return verdicts.reduce<Verdict>((worst, verdict) => (VERDICT_RANK[verdict] > VERDICT_RANK[worst] ? verdict : worst), 'pass')
}

export function planNodeId(plan: DocsViewerOpenPlan): string {
  return `plan:${plan.file}`
}

/** `AC-meetups-edit-1`, `AC-meetups-host-2` → `AC-meetups-*`. */
export function idPattern(labels: readonly string[]): string {
  let prefix = labels[0] ?? ''
  for (const label of labels) while (!label.startsWith(prefix)) prefix = prefix.slice(0, -1)
  const cut = prefix.lastIndexOf('-')
  return `${cut > 0 ? prefix.slice(0, cut + 1) : prefix}*`
}

/**
 * Tests verifying the same documents become one node: a closed plan's ids are each cited by
 * its plan doc and its entity doc, and a node per id buries both documents under the edges.
 */
export function groupTests(view: GraphView): GraphView {
  const tests = new Map(view.nodes.filter((node) => node.kind === 'test').map((node) => [node.id, { node, to: new Set<string>(), verdicts: [] as Verdict[] }]))
  for (const edge of view.edges) {
    const test = tests.get(edge.from)
    if (test) {
      test.to.add(edge.to)
      test.verdicts.push(edge.verdict)
    }
  }
  const byTargets = new Map<string, string[]>()
  for (const [id, test] of tests) {
    if (test.to.size === 0) continue
    const key = [...test.to].sort().join('\n')
    byTargets.set(key, [...(byTargets.get(key) ?? []), id])
  }
  const groupOf = new Map<string, string>()
  const groupNodes: ViewNode[] = []
  for (const [key, ids] of byTargets) {
    if (ids.length < 2) continue
    const members = ids.map((id): TestMember => {
      const test = tests.get(id)!
      return { id, label: test.node.label, verdict: worstVerdict(test.verdicts) }
    })
    const label = idPattern(members.map((member) => member.label))
    const searchText = [label, ...members.map((member) => member.label)].join(' ').toLowerCase()
    const node: ViewNode = { id: `tests:${key}`, kind: 'test', label, members, searchText }
    groupNodes.push(node)
    for (const id of ids) groupOf.set(id, node.id)
  }
  const merged = new Map<string, ViewEdge>()
  const edges: ViewEdge[] = []
  for (const edge of view.edges) {
    const from = groupOf.get(edge.from)
    if (!from) {
      edges.push(edge)
      continue
    }
    const key = `${from}\n${edge.to}`
    const existing = merged.get(key)
    if (existing) {
      existing.verdict = worstVerdict([existing.verdict, edge.verdict])
    } else {
      const grouped = { ...edge, from }
      merged.set(key, grouped)
      edges.push(grouped)
    }
  }
  return { nodes: view.nodes.filter((node) => !groupOf.has(node.id)).concat(groupNodes), edges }
}

/** Open plans are the viewer's own nodes, linked to the entities they change: `docs:graph --json` gains no kind for them. */
export function withOpenPlans(view: GraphView, plans: readonly DocsViewerOpenPlan[]): GraphView {
  const nodes = view.nodes.slice()
  const edges = view.edges.slice()
  const ids = new Set(nodes.map((node) => node.id))
  for (const plan of plans) {
    const id = planNodeId(plan)
    nodes.push({ id, kind: 'openplan', label: plan.title, plan })
    for (const name of plan.entities) {
      const entity = `entity:${name}`
      if (!ids.has(entity)) {
        nodes.push({ id: entity, kind: 'entity', label: name })
        ids.add(entity)
      }
      edges.push({ from: id, to: entity, relation: 'plans', verdict: 'pass' })
    }
  }
  return { nodes, edges }
}

/** What the payload could not read, shown above the plan list: a scan that stopped leaves the graph or the list short. */
export function scanWarnings(data: Pick<DocsViewerData, 'docsScanFailure' | 'unreadablePlanDirs'>): string[] {
  const failure = data.docsScanFailure
  return [
    ...(failure ? [`Docs could not be scanned: ${failure.dir} (${failure.reason}). No document is shown until it can be.`] : []),
    ...data.unreadablePlanDirs.map(({ dir, reason }) => `Plan directory could not be listed: ${dir} (${reason})`),
  ]
}

/** Why a poll of `data.json` brought no payload. */
export type LoadFailure = { kind: 'status'; status: number } | { kind: 'unreachable' } | { kind: 'unreadable'; message: string }

/**
 * The notice for `streak` failed polls in a row, or null. A dev server restarting under `bun --hot`
 * answers no poll for a moment, so one unanswered poll goes unreported.
 */
export function loadFailureNotice(failure: LoadFailure, streak: number, loaded: boolean): string | null {
  if (failure.kind === 'unreachable' && streak < 2) return null
  const cause =
    failure.kind === 'status'
      ? `The docs data could not be loaded (HTTP ${failure.status}); the dev server's output has the error.`
      : failure.kind === 'unreachable'
        ? 'The dev server is not answering.'
        : `The docs data could not be read (${failure.message}).`
  return `${cause} ${loaded ? 'Showing what the last successful load returned; retrying.' : 'Retrying.'}`
}
