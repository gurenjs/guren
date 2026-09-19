import { describe, expect, test } from 'bun:test'
import type { z } from 'zod'

import { layoutPlanFlows } from '../src/plan/flow'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { loadCommentsPlan } from './plan-fixture'

/** What a plan *document* spells, which is not `PlanFlow`: an edge's `kind` defaults. */
type PlanFlowInput = NonNullable<z.input<typeof PlanDraftSchema>['flows']>[number]

function planWith(flow: Partial<PlanFlowInput> & Pick<PlanFlowInput, 'nodes' | 'edges'>): PlanDraft {
  return PlanDraftSchema.parse({
    ...loadCommentsPlan(),
    flows: [{ id: 'flow.comment', change: { kind: 'add' }, title: 'Leaving a comment', ...flow }],
  })
}

function placed(plan: PlanDraft): Record<string, [number, number]> {
  const layout = layoutPlanFlows(plan)[0]
  return Object.fromEntries(layout.nodes.map((node) => [node.id, [node.column, node.row]]))
}

describe('layoutPlanFlows', () => {
  test('should put a chain in one row, one column per step', () => {
    const plan = planWith({
      nodes: [
        { id: 'user', label: 'A signed-in user', kind: 'actor' },
        { id: 'form', label: 'The comment form', kind: 'page' },
        { id: 'store', label: 'comments.store', kind: 'route', element: 'route.comments.store' },
      ],
      edges: [
        { from: 'user', to: 'form' },
        { from: 'form', to: 'store' },
      ],
    })

    expect(placed(plan)).toEqual({ user: [0, 0], form: [1, 0], store: [2, 0] })
  })

  test('should stack a fan-out into rows of one column', () => {
    const plan = planWith({
      nodes: [
        { id: 'store', label: 'store', kind: 'action' },
        { id: 'row', label: 'the comment row', kind: 'store' },
        { id: 'mail', label: 'notify the author', kind: 'job' },
      ],
      edges: [
        { from: 'store', to: 'row' },
        { from: 'store', to: 'mail', kind: 'async' },
      ],
    })

    expect(placed(plan)).toEqual({ store: [0, 0], row: [1, 0], mail: [1, 1] })
  })

  test('should place a node after its furthest predecessor, not its first', () => {
    // `end` is reachable in one hop and in two; the long path decides.
    const plan = planWith({
      nodes: [
        { id: 'a', label: 'a', kind: 'actor' },
        { id: 'b', label: 'b', kind: 'action' },
        { id: 'end', label: 'end', kind: 'page' },
      ],
      edges: [
        { from: 'a', to: 'end' },
        { from: 'a', to: 'b' },
        { from: 'b', to: 'end' },
      ],
    })

    expect(placed(plan).end).toEqual([2, 0])
  })

  test('should lay out a loop rather than refuse it, and mark the edge that closes it', () => {
    const plan = planWith({
      nodes: [
        { id: 'form', label: 'form', kind: 'page' },
        { id: 'validate', label: 'validate', kind: 'action' },
        { id: 'saved', label: 'saved', kind: 'store' },
      ],
      edges: [
        { from: 'form', to: 'validate' },
        { from: 'validate', to: 'saved' },
        { from: 'validate', to: 'form', label: 'invalid' },
      ],
    })
    const layout = layoutPlanFlows(plan)[0]

    expect(placed(plan)).toEqual({ form: [0, 0], validate: [1, 0], saved: [2, 0] })
    expect(layout.edges.filter((edge) => edge.back).map((edge) => edge.label)).toEqual(['invalid'])
  })

  test('should drop an edge naming a node the flow does not declare', () => {
    const plan = planWith({
      nodes: [{ id: 'form', label: 'form', kind: 'page' }],
      edges: [{ from: 'form', to: 'nowhere' }],
    })

    expect(layoutPlanFlows(plan)[0].edges).toEqual([])
  })

  test('should drop an edge from a node to itself', () => {
    const plan = planWith({
      nodes: [{ id: 'form', label: 'form', kind: 'page' }],
      edges: [{ from: 'form', to: 'form' }],
    })

    expect(layoutPlanFlows(plan)[0].edges).toEqual([])
  })

  test('should report the grid the page has to draw', () => {
    const plan = planWith({
      nodes: [
        { id: 'a', label: 'a', kind: 'actor' },
        { id: 'b', label: 'b', kind: 'action' },
        { id: 'c', label: 'c', kind: 'action' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
      ],
    })
    const layout = layoutPlanFlows(plan)[0]

    expect([layout.columns, layout.rows]).toEqual([2, 2])
  })

  test('should carry the element a node names, which is what links it to the rest', () => {
    const plan = planWith({
      nodes: [{ id: 'store', label: 'store', kind: 'route', element: 'route.comments.store' }],
      edges: [],
    })

    expect(layoutPlanFlows(plan)[0].nodes[0].element).toBe('route.comments.store')
  })

  test('should lay out no flow for a plan that declares none', () => {
    expect(layoutPlanFlows(PlanDraftSchema.parse(loadCommentsPlan()))).toEqual([])
  })
})

describe('layoutPlanFlows on graphs that are not a clean chain', () => {
  function chain(length: number): Pick<PlanFlowInput, 'nodes' | 'edges'> {
    return {
      nodes: Array.from({ length }, (_, index) => ({
        id: `n${index}`,
        label: `n${index}`,
        kind: 'action' as const,
      })),
      edges: Array.from({ length: length - 1 }, (_, index) => ({ from: `n${index}`, to: `n${index + 1}` })),
    }
  }

  test('should place a flow that is entirely a cycle, with no step to start from', () => {
    const plan = planWith({
      nodes: [
        { id: 'a', label: 'a', kind: 'action' },
        { id: 'b', label: 'b', kind: 'action' },
        { id: 'c', label: 'c', kind: 'action' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' },
      ],
    })
    const layout = layoutPlanFlows(plan)[0]

    expect(placed(plan)).toEqual({ a: [0, 0], b: [1, 0], c: [2, 0] })
    expect(layout.edges.filter((edge) => edge.back)).toHaveLength(1)
  })

  test('should give a step with no edges a place of its own', () => {
    const plan = planWith({
      nodes: [
        { id: 'a', label: 'a', kind: 'action' },
        { id: 'b', label: 'b', kind: 'action' },
        { id: 'lonely', label: 'lonely', kind: 'actor' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    })

    expect(placed(plan)).toEqual({ a: [0, 0], b: [1, 0], lonely: [0, 1] })
  })

  test('should stack two flows that share no step into their own rows', () => {
    const plan = planWith({
      nodes: ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, kind: 'action' })),
      edges: [
        { from: 'a', to: 'b' },
        { from: 'c', to: 'd' },
      ],
    })
    const layout = layoutPlanFlows(plan)[0]

    expect(placed(plan)).toEqual({ a: [0, 0], b: [1, 0], c: [0, 1], d: [1, 1] })
    expect([layout.columns, layout.rows]).toEqual([2, 2])
  })

  test('should reach the same placement however the edges are declared', () => {
    // Reverse declaration is the worst case for the relaxation: one edge settles a pass.
    const { nodes, edges } = chain(120)
    const forward = placed(planWith({ nodes, edges }))
    const backward = placed(planWith({ nodes, edges: edges.slice().reverse() }))

    expect(backward).toEqual(forward)
    expect(forward.n119).toEqual([119, 0])
  })

  test('should place the same plan the same way every time', () => {
    const { nodes, edges } = chain(40)

    expect(JSON.stringify(layoutPlanFlows(planWith({ nodes, edges })))).toBe(
      JSON.stringify(layoutPlanFlows(planWith({ nodes, edges }))),
    )
  })

  test('should walk a chain deeper than a call stack would carry', () => {
    // A recursive walk overflows here: measured between 1,000 and 5,000 steps under
    // Node and between 20,000 and 40,000 under Bun, so which runtime ran it decided
    // whether the command survived.
    const { nodes, edges } = chain(50000)

    expect(layoutPlanFlows(planWith({ nodes, edges }))[0].columns).toBe(50000)
  })
})
