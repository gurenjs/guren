import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  findDuplicatePlanIds,
  listPlanElements,
  planDraftJsonSchema,
  PlanDraftSchema,
  PlanSchema,
  type PlanDraft,
} from '../src/plan/schema'

function loadFixture(): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8'))
}

function validDraft(): PlanDraft {
  return PlanDraftSchema.parse(loadFixture())
}

describe('PlanDraftSchema', () => {
  test('should accept the comments fixture', () => {
    const result = PlanDraftSchema.safeParse(loadFixture())

    expect(result.success).toBe(true)
  })

  test('should reject a key the schema does not declare', () => {
    const draft = { ...(loadFixture() as Record<string, unknown>), notes: 'free text' }

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject an undeclared key on a nested element rather than strip it', () => {
    const draft = structuredClone(validDraft()) as unknown as {
      models: Array<{ relationships: Array<Record<string, unknown>> }>
    }
    draft.models[1]!.relationships[0]!.foreignKey = 'post_id'

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject a baseline, which only Guren stamps', () => {
    const draft = { ...(loadFixture() as Record<string, unknown>), baseline: { rev: 'abc', contextHash: {} } }

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject a rename that does not say what it renames', () => {
    const draft = validDraft()
    const broken = structuredClone(draft) as unknown as { models: Array<{ change: unknown }> }
    broken.models[1]!.change = { kind: 'rename' }

    expect(PlanDraftSchema.safeParse(broken).success).toBe(false)
  })

  test('should reject an acceptance input whose value is not JSON text', () => {
    const draft = validDraft()
    draft.tasks[0]!.acceptance[0]!.input = [{ name: 'body', json: 'Nice post' }]

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject a question with fewer than two options', () => {
    const draft = validDraft()
    draft.questions[0]!.options = [{ label: 'hard delete', consequence: 'The row is removed.' }]

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject a route path that is not absolute', () => {
    const draft = validDraft()
    draft.routes[0]!.path = 'posts/:postId/comments'

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })
})

describe('PlanSchema', () => {
  test('should require the baseline a draft may not carry', () => {
    const draft = validDraft()

    expect(PlanSchema.safeParse(draft).success).toBe(false)
    expect(
      PlanSchema.safeParse({ ...draft, baseline: { rev: '6445bc71', contextHash: { 'model.post': 'ab12' } } }).success,
    ).toBe(true)
  })
})

describe('planDraftJsonSchema', () => {
  test('should close every object, as a structured-output producer requires', () => {
    const open: string[] = []
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${path}[${index}]`))
        return
      }
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (record.type === 'object' && record.additionalProperties !== false) open.push(path)
      for (const [key, value] of Object.entries(record)) visit(value, `${path}.${key}`)
    }

    visit(planDraftJsonSchema(), '$')

    expect(open).toEqual([])
  })

  test('should target draft-07 and leave baseline out', () => {
    const schema = planDraftJsonSchema() as { $schema?: string; properties?: Record<string, unknown> }

    expect(schema.$schema).toContain('draft-07')
    expect(schema.properties).toHaveProperty('models')
    expect(schema.properties).not.toHaveProperty('baseline')
  })
})

describe('listPlanElements', () => {
  test('should list nested actions and acceptance behaviours beside top-level elements', () => {
    const ids = listPlanElements(validDraft()).map((ref) => `${ref.section}:${ref.id}`)

    expect(ids).toContain('actions:action.comments.destroy')
    expect(ids).toContain('acceptance:AC-comments-4')
    expect(ids).toContain('questions:Q-delete')
    expect(ids).toContain('models:model.comment')
  })
})

describe('findDuplicatePlanIds', () => {
  test('should return nothing for the fixture', () => {
    expect(findDuplicatePlanIds(validDraft())).toEqual([])
  })

  test('should report an id shared across sections', () => {
    const draft = validDraft()
    draft.views[0]!.id = 'route.comments.store'

    expect(findDuplicatePlanIds(draft)).toEqual(['route.comments.store'])
  })
})
