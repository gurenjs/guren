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
