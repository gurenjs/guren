import { describe, expect, test } from 'bun:test'

import {
  findDuplicatePlanIds,
  listPlanElements,
  planDraftJsonSchema,
  PlanDraftSchema,
  PlanSchema,
  type PlanDraft,
} from '../src/plan/schema'
import { loadCommentsPlan, TEST_BASELINE } from './plan-fixture'

function validDraft(): PlanDraft {
  return PlanDraftSchema.parse(loadCommentsPlan())
}

describe('PlanDraftSchema', () => {
  test('should accept the comments fixture', () => {
    const result = PlanDraftSchema.safeParse(loadCommentsPlan())

    expect(result.success).toBe(true)
  })

  test('should reject a key the schema does not declare', () => {
    const draft = { ...loadCommentsPlan(), notes: 'free text' }

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject an undeclared key on a nested element rather than strip it', () => {
    const draft = validDraft() as unknown as {
      models: Array<{ relationships: Array<Record<string, unknown>> }>
    }
    draft.models[1]!.relationships[0]!.foreignKey = 'post_id'

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject a baseline, which only Guren stamps', () => {
    const draft = { ...loadCommentsPlan(), baseline: { rev: 'abc', contextHash: {} } }

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should reject a rename that does not say what it renames', () => {
    const draft = validDraft() as unknown as { models: Array<{ change: unknown }> }
    draft.models[1]!.change = { kind: 'rename' }

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
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

  test('should fill an omitted section with an empty one', () => {
    const draft = validDraft()

    expect(draft.sideEffects).toEqual([])
    expect(draft.commands).toEqual([])
    expect(draft.models[1]!.indexes).toEqual([])
  })

  test('should reject a column without an id, since a revision addresses it by one', () => {
    const draft = validDraft() as unknown as { models: Array<{ columns: Array<{ id?: string }> }> }
    delete draft.models[1]!.columns[1]!.id

    expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
  })

  test('should accept a binding by a column other than the primary key', () => {
    const draft = validDraft()
    draft.routes[0]!.bind = [{ param: 'postId', model: 'model.post', key: 'slug' }]

    expect(PlanDraftSchema.safeParse(draft).success).toBe(true)
  })

  test('should reject an id that names an Object.prototype member', () => {
    for (const id of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      const draft = validDraft()
      draft.views[0]!.id = id

      expect(PlanDraftSchema.safeParse(draft).success).toBe(false)
    }
  })

  test('should accept an id that merely contains such a name', () => {
    const draft = validDraft()
    draft.views[0]!.id = 'view.constructor'

    expect(PlanDraftSchema.safeParse(draft).success).toBe(true)
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
      PlanSchema.safeParse({ ...draft, baseline: TEST_BASELINE }).success,
    ).toBe(true)
  })
})

describe('planDraftJsonSchema', () => {
  test('should close every object, as a structured-output producer requires', () => {
    const open: string[] = []
    let objects = 0
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${path}[${index}]`))
        return
      }
      if (node === null || typeof node !== 'object') return
      const record = node as Record<string, unknown>
      if (record.type === 'object') {
        objects++
        if (record.additionalProperties !== false) open.push(path)
      }
      for (const [key, value] of Object.entries(record)) visit(value, `${path}.${key}`)
    }

    visit(planDraftJsonSchema(), '$')

    // An empty traversal would pass the closed-object assertion without checking anything.
    expect(objects).toBeGreaterThan(30)
    expect(open).toEqual([])
  })

  test('should target draft-07 and leave baseline out', () => {
    const schema = planDraftJsonSchema() as { $schema?: string; properties?: Record<string, unknown> }

    expect(schema.$schema).toContain('draft-07')
    expect(schema.properties).toHaveProperty('models')
    expect(schema.properties).not.toHaveProperty('baseline')
  })

  test('should let a producer omit a section and still require the ones with no default', () => {
    const schema = planDraftJsonSchema() as { required?: string[] }

    expect(schema.required).toEqual(['planVersion', 'title', 'summary', 'scope'])
  })
})

describe('listPlanElements', () => {
  test('should list every element in document order, nested ones after their parent', () => {
    const ids = listPlanElements(validDraft()).map((ref) => `${ref.section}:${ref.id}`)

    expect(ids).toEqual([
      'questions:Q-delete',
      'models:model.post',
      'columns:column.post.id',
      'models:model.comment',
      'columns:column.comment.id',
      'columns:column.comment.body',
      'columns:column.comment.postId',
      'columns:column.comment.createdAt',
      'validators:validator.comment',
      'controllers:controller.comments',
      'actions:action.comments.store',
      'actions:action.comments.destroy',
      'routes:route.comments.store',
      'routes:route.comments.destroy',
      'views:view.posts.show',
      'resources:resource.comment',
      'policies:policy.comment',
      'tasks:task.comments',
      'acceptance:AC-comments-1',
      'acceptance:AC-comments-2',
      'acceptance:AC-comments-3',
      'acceptance:AC-comments-4',
    ])
  })
})

describe('findDuplicatePlanIds', () => {
  test('should return nothing for the fixture', () => {
    expect(findDuplicatePlanIds(validDraft())).toEqual([])
  })

  test('should report a nested id that repeats a top-level one', () => {
    const draft = validDraft()
    draft.models[1]!.columns[0]!.id = 'model.post'
    draft.tasks[0]!.acceptance[0]!.id = 'model.post'

    expect(findDuplicatePlanIds(draft)).toEqual(['model.post'])
  })

  test('should report an id shared across sections', () => {
    const draft = validDraft()
    draft.views[0]!.id = 'route.comments.store'

    expect(findDuplicatePlanIds(draft)).toEqual(['route.comments.store'])
  })
})
