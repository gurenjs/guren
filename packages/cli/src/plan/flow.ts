/**
 * Flow layout (RFC 0030 §3). A plan carries a flow as a graph, and this places it:
 * the page draws the positions it is handed rather than deciding them, so a flow looks
 * the same in the page, in print, and in any later view built on the same value.
 *
 * Layering is longest-path over the acyclic part of the graph. A plan may describe a
 * loop (a retry, a redirect back to the form), so the cycle-breaking is part of the
 * layout rather than a reason to refuse one.
 */

import type { PlanDraft, PlanFlowEdge, PlanFlowNode } from './schema'

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

export interface PlanFlowLayout {
  id: string
  title: string
  description?: string
  change: string
  nodes: PlanFlowLayoutNode[]
  edges: PlanFlowLayoutEdge[]
  columns: number
  rows: number
}

/** Edges whose endpoints the flow declares. One naming a node that does not exist is a §2 finding, not a line. */
function declaredEdges(flow: { nodes: PlanFlowNode[]; edges: PlanFlowEdge[] }): PlanFlowEdge[] {
  const declared = new Set(flow.nodes.map((node) => node.id))
  return flow.edges.filter((edge) => declared.has(edge.from) && declared.has(edge.to) && edge.from !== edge.to)
}

/**
 * The edges that close a cycle: a depth-first walk in declaration order, where an edge
 * onto a node already on the stack is the one that closes it. Which edge of a cycle
 * that is depends on the order, so the order is the plan's, not a map's.
 * The walk carries its own stack because a recursive one overflows between 1,000 and
 * 5,000 chained steps under Node and between 20,000 and 40,000 under Bun.
 */
function backEdges(nodes: PlanFlowNode[], edges: PlanFlowEdge[]): Set<PlanFlowEdge> {
  const out = new Map<string, PlanFlowEdge[]>()
  for (const edge of edges) {
    const bucket = out.get(edge.from)
    if (bucket) bucket.push(edge)
    else out.set(edge.from, [edge])
  }

  const back = new Set<PlanFlowEdge>()
  const done = new Set<string>()
  const onStack = new Set<string>()

  for (const start of nodes) {
    if (done.has(start.id)) continue
    onStack.add(start.id)
    const stack = [{ id: start.id, next: 0 }]

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
 * Longest path from a node with no incoming edge. Every node is reachable in at most
 * `nodes.length` relaxations once the back edges are out, so the loop terminates
 * without needing a topological order of its own.
 */
function columns(nodes: PlanFlowNode[], forward: PlanFlowEdge[]): Map<string, number> {
  const column = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false
    for (const edge of forward) {
      const next = (column.get(edge.from) as number) + 1
      if (next > (column.get(edge.to) as number)) {
        column.set(edge.to, next)
        moved = true
      }
    }
    if (!moved) break
  }
  return column
}

export function layoutPlanFlows(plan: PlanDraft): PlanFlowLayout[] {
  return plan.flows.map((flow) => {
    const edges = declaredEdges(flow)
    const back = backEdges(flow.nodes, edges)
    const forward = edges.filter((edge) => !back.has(edge))
    const column = columns(flow.nodes, forward)

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
      columns: Math.max(...nodes.map((node) => node.column)) + 1,
      rows: Math.max(...filled.values()),
    }
  })
}
