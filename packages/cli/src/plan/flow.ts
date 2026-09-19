/**
 * Flow layout (RFC 0030 §3). A plan carries a flow as a graph, and this places it:
 * the page draws the positions it is handed rather than deciding them, so a flow looks
 * the same in the page, in print, and in any later view built on the same value.
 *
 * Nothing here may take a per-element engine resource: no recursion over the graph, no
 * array spread into a call. Both ceilings are the runtime's, so the plan that breaks
 * the layout would otherwise depend on which runtime read it.
 */

import type { PlanChange, PlanDraft, PlanFlow, PlanFlowEdge, PlanFlowNode } from './schema'

export interface PlanFlowLayoutNode extends PlanFlowNode {
  /** Distance from a node with no incoming edge; the page's horizontal axis. */
  column: number
  /** Position within the column, in declaration order. */
  row: number
}

export interface PlanFlowLayoutEdge extends PlanFlowEdge {
  /** An edge that closes a cycle. It took no part in the layering and the page marks it. */
  back: boolean
}

/** Everything the flow declares except its graph, plus where that graph goes. */
export interface PlanFlowLayout extends Omit<PlanFlow, 'nodes' | 'edges' | 'change'> {
  change: PlanChange['kind']
  nodes: PlanFlowLayoutNode[]
  edges: PlanFlowLayoutEdge[]
  columns: number
  rows: number
}

/** The largest of some numbers, folded. A spread into `Math.max` has the runtime's ceiling. */
function widest(values: Iterable<number>): number {
  let most = 0
  for (const value of values) {
    if (value > most) most = value
  }
  return most
}

function edgesByFrom(edges: PlanFlowEdge[]): Map<string, PlanFlowEdge[]> {
  const out = new Map<string, PlanFlowEdge[]>()
  for (const edge of edges) {
    const bucket = out.get(edge.from)
    if (bucket) bucket.push(edge)
    else out.set(edge.from, [edge])
  }
  return out
}

/**
 * Edges the layout can draw. An end the flow does not declare is a §2 finding rather
 * than a line, and so is a step looping to itself (`plan:flow-self-loop`), dropped here
 * because a line from a box to itself draws nothing.
 */
function declaredEdges(stepIds: readonly string[], edges: PlanFlowEdge[]): PlanFlowEdge[] {
  const declared = new Set(stepIds)
  return edges.filter((edge) => declared.has(edge.from) && declared.has(edge.to) && edge.from !== edge.to)
}

/**
 * The edges that close a cycle: a depth-first walk in declaration order, where an edge
 * onto a step already on the stack is the one that closes it. Which edge of a cycle
 * that is depends on the order, so the order is the plan's, not a map's.
 */
function backEdges(stepIds: readonly string[], edges: PlanFlowEdge[]): Set<PlanFlowEdge> {
  const out = edgesByFrom(edges)
  const back = new Set<PlanFlowEdge>()
  const done = new Set<string>()
  const onStack = new Set<string>()

  for (const start of stepIds) {
    if (done.has(start)) continue
    onStack.add(start)
    const stack = [{ id: start, next: 0 }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]
      const outgoing = out.get(frame.id) ?? []
      if (frame.next < outgoing.length) {
        const edge = outgoing[frame.next]
        frame.next += 1
        if (onStack.has(edge.to)) back.add(edge)
        else if (!done.has(edge.to)) {
          onStack.add(edge.to)
          stack.push({ id: edge.to, next: 0 })
        }
        continue
      }
      onStack.delete(frame.id)
      done.add(frame.id)
      stack.pop()
    }
  }
  return back
}

/**
 * Longest path from a step with no incoming edge, in one pass over a topological order.
 * Relaxing the edge list until it settles reaches the same answer, at a pass per edge
 * declared before the edge it depends on: quadratic on a flow written back to front,
 * which is what a model writing one from its end produces.
 */
function columns(stepIds: readonly string[], forward: PlanFlowEdge[]): Map<string, number> {
  const out = edgesByFrom(forward)
  const pending = new Map(stepIds.map((id) => [id, 0]))
  for (const edge of forward) pending.set(edge.to, (pending.get(edge.to) as number) + 1)

  const column = new Map(stepIds.map((id) => [id, 0]))
  // Declaration order among the ready steps, so the placement is the plan's order.
  const ready = stepIds.filter((id) => pending.get(id) === 0)
  for (let at = 0; at < ready.length; at += 1) {
    const id = ready[at]
    for (const edge of out.get(id) ?? []) {
      const next = (column.get(id) as number) + 1
      if (next > (column.get(edge.to) as number)) column.set(edge.to, next)
      const left = (pending.get(edge.to) as number) - 1
      pending.set(edge.to, left)
      if (left === 0) ready.push(edge.to)
    }
  }
  return column
}

export function layoutPlanFlows(plan: PlanDraft): PlanFlowLayout[] {
  return plan.flows.map((flow) => {
    // Derived once and handed down. A flow may declare one id twice (§2 reports it, and
    // a finding does not stop the page rendering), and everything below is keyed by id.
    const stepIds = [...new Set(flow.nodes.map((node) => node.id))]
    const edges = declaredEdges(stepIds, flow.edges)
    const back = backEdges(stepIds, edges)
    const column = columns(
      stepIds,
      edges.filter((edge) => !back.has(edge)),
    )

    const filled = new Map<number, number>()
    const nodes: PlanFlowLayoutNode[] = flow.nodes.map((node) => {
      const at = column.get(node.id) as number
      const row = filled.get(at) ?? 0
      filled.set(at, row + 1)
      return { ...node, column: at, row }
    })

    return {
      id: flow.id,
      title: flow.title,
      description: flow.description,
      change: flow.change.kind,
      nodes,
      edges: edges.map((edge) => ({ ...edge, back: back.has(edge) })),
      // `filled` is keyed by column and counts the steps in it, so it carries both.
      columns: widest(filled.keys()) + 1,
      rows: widest(filled.values()),
    }
  })
}
