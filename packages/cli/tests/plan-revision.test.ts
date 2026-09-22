import { describe, expect, test } from 'bun:test'

import type { PlanFeedback } from '../src/plan/feedback'
import { planHash } from '../src/plan/identity'
import {
  applyRevision,
  createPlanRevision,
  diffPlans,
  PLAN_TOP_SECTIONS,
  PlanHeadSchema,
  PlanRevisionOpsSchema,
  planRevisionOpsJsonSchema,
  type PlanRevision,
  type PlanRevisionRejectionKind,
} from '../src/plan/revision'
import {
  findDuplicatePlanIds,
  listPlanElements,
  PlanColumnSchema,
  PlanSchema,
  type Plan,
} from '../src/plan/schema'
import { loadParsedCommentsPlan as commentsPlan } from './plan-fixture'

type Json = Record<string, unknown>

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) deepFreeze(member)
    Object.freeze(value)
  }
  return value
}

const DELETED_AT = {
  id: 'column.comment.deletedAt',
  name: 'deletedAt',
  change: { kind: 'add' },
  type: 'datetime',
  nullable: true,
  unique: false,
  index: false,
}

const DELETED_AT_COLUMN = PlanColumnSchema.parse(DELETED_AT)

const ADD_DELETED_AT = {
  op: 'add',
  section: 'columns',
  parent: 'model.comment',
  element: DELETED_AT,
  before: 'column.comment.createdAt',
  reason: 'soft delete',
}

const REMOVE_QUESTION = { op: 'remove', id: 'Q-delete', reason: 'answered: soft delete' }

/** The own fields of an element, as a MODIFY carries them. */
function own(element: Json, ...nested: string[]): Json {
  const copy = { ...element }
  for (const key of ['id', ...nested]) delete copy[key]
  return copy
}

function revise(parent: Plan, ops: unknown[], feedback?: PlanFeedback): { revision: PlanRevision; plan: Plan } {
  const created = createPlanRevision(parent, { ops }, { feedback })
  if (!created.ok) throw new Error(JSON.stringify(created.rejections, null, 2))
  return created
}

function rejectionsOf(parent: Plan, ops: unknown[], feedback?: PlanFeedback): Array<[PlanRevisionRejectionKind, string | undefined]> {
  const created = createPlanRevision(parent, { ops }, { feedback })
  if (created.ok) return []
  return created.rejections.map((rejection) => [rejection.kind, rejection.id])
}

function feedbackOn(parent: Plan, partial: Partial<PlanFeedback>): PlanFeedback {
  return { planHash: planHash(parent), answers: [], elements: [], ...partial }
}

function approve(...ids: string[]): PlanFeedback['elements'] {
  return ids.map((elementId) => ({ elementId, verdict: 'approve' as const, comment: '' }))
}

describe('planRevisionOpsJsonSchema', () => {
  test('should close every object, as a structured-output producer requires', () => {
    const open: string[] = []
    let objects = 0
    const visit = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((item, index) => visit(item, `${path}[${index}]`))
        return
      }
      if (node === null || typeof node !== 'object') return
      const record = node as Json
      if (record.type === 'object') {
        objects++
        if (record.additionalProperties !== false) open.push(path)
      }
      for (const [key, value] of Object.entries(record)) visit(value, `${path}.${key}`)
    }

    visit(planRevisionOpsJsonSchema(), '$')

    // An empty traversal would pass the closed-object assertion without checking anything.
    expect(objects).toBeGreaterThan(60)
    expect(open).toEqual([])
  })

  test('should target draft-07 and ask for ops alone, never for the hashes', () => {
    const schema = planRevisionOpsJsonSchema() as { $schema?: string; properties?: Json; required?: string[] }

    expect(schema.$schema).toContain('draft-07')
    expect(Object.keys(schema.properties ?? {})).toEqual(['ops'])
    expect(schema.required).toEqual(['ops'])
  })

  test('should ask for one op at least, rather than round-trip a refusal of the empty list', () => {
    const schema = planRevisionOpsJsonSchema() as { properties: { ops: { minItems?: number } } }

    expect(schema.properties.ops.minItems).toBe(1)
  })
})

describe('PlanRevisionOpsSchema', () => {
  const parses = (op: unknown): boolean => PlanRevisionOpsSchema.safeParse({ ops: [op] }).success
  const model = (): Json => commentsPlan().models[1] as Json

  test('should accept a MODIFY that carries the own fields of the element', () => {
    expect(parses({ op: 'modify', section: 'models', id: 'model.comment', element: own(model(), 'columns'), reason: 'r' })).toBe(true)
  })

  test('should refuse a MODIFY that carries an id, so an op cannot rename what it names', () => {
    const element = { ...own(model(), 'columns'), id: 'model.other' }

    expect(parses({ op: 'modify', section: 'models', id: 'model.comment', element, reason: 'r' })).toBe(false)
  })

  test('should refuse a MODIFY that carries nested elements, which have ids of their own', () => {
    const plan = commentsPlan()
    const parents = [
      ['models', 'columns', plan.models[1]],
      ['controllers', 'actions', plan.controllers[0]],
      ['tasks', 'acceptance', plan.tasks[0]],
    ] as const

    for (const [section, nested, element] of parents) {
      const { id } = element as { id: string }
      expect((element as Json)[nested]).not.toHaveLength(0)
      expect(parses({ op: 'modify', section, id, element: own(element as Json), reason: 'r' })).toBe(false)
      expect(parses({ op: 'modify', section, id, element: own(element as Json, nested), reason: 'r' })).toBe(true)
    }
  })

  test('should refuse a model MODIFY that omits a defaulted list, which would read as emptying it', () => {
    const element = own(model(), 'columns', 'indexes')

    expect(parses({ op: 'modify', section: 'models', id: 'model.comment', element, reason: 'r' })).toBe(false)
  })

  test('should require a parent on a nested ADD and refuse one on a top-level ADD', () => {
    const { parent: _parent, ...orphan } = ADD_DELETED_AT

    expect(parses(ADD_DELETED_AT)).toBe(true)
    expect(parses(orphan)).toBe(false)
    expect(parses({ op: 'add', section: 'models', parent: 'model.post', element: model(), reason: 'r' })).toBe(false)
  })

  test('should hold ids to the plan id rule and every op to a reason', () => {
    const { reason: _reason, ...silent } = REMOVE_QUESTION

    expect(parses({ op: 'remove', id: 'constructor', reason: 'r' })).toBe(false)
    expect(parses({ op: 'remove', id: '9lives', reason: 'r' })).toBe(false)
    expect(parses(silent)).toBe(false)
  })
})

describe('what a revision can reach', () => {
  test('should cover every key of the plan but planVersion and baseline', () => {
    const reachable = [...Object.keys(PlanHeadSchema.shape), ...PLAN_TOP_SECTIONS, 'planVersion', 'baseline']

    expect(reachable.sort()).toEqual(Object.keys(PlanSchema.shape).sort())
  })
})

describe('applyRevision', () => {
  test('should reproduce the result the revision names', () => {
    const parent = commentsPlan()
    const { revision, plan } = revise(parent, [ADD_DELETED_AT])

    const applied = applyRevision(parent, revision)

    expect(applied.ok).toBe(true)
    if (!applied.ok) return
    expect(applied.hash).toBe(revision.result)
    expect(applied.hash).toBe(planHash(plan))
    expect(applied.hash).not.toBe(revision.parent)
    expect(PlanSchema.safeParse(applied.plan).success).toBe(true)
  })

  test('should never mutate the parent', () => {
    const parent = deepFreeze(commentsPlan())
    const before = JSON.stringify(parent)

    const { revision } = revise(parent, [
      ADD_DELETED_AT,
      REMOVE_QUESTION,
      { op: 'modify', section: 'plan', element: { ...headOf(parent), title: 'Soft-deleted comments' }, reason: 'r' },
    ])

    expect(applyRevision(parent, revision).ok).toBe(true)
    expect(JSON.stringify(parent)).toBe(before)
  })

  test('should carry baseline over unchanged, so the hash moves through ops alone', () => {
    const parent = commentsPlan()
    const { revision, plan } = revise(parent, [REMOVE_QUESTION])
    const restamped = planHash({ ...plan, baseline: { ...plan.baseline, rev: 'ffffffff' } })

    expect(plan.baseline).toEqual(parent.baseline)
    expect(applyRevision(parent, { ...revision, result: restamped })).toMatchObject({
      ok: false,
      rejections: [{ kind: 'result-mismatch' }],
    })
  })

  test('should reject a revision written against another plan', () => {
    const parent = commentsPlan()
    const { revision } = revise(parent, [REMOVE_QUESTION])
    const other = PlanSchema.parse({ ...parent, title: 'Another plan' })

    expect(applyRevision(other, revision)).toMatchObject({ ok: false, rejections: [{ kind: 'parent-mismatch' }] })
  })

  test('should reject a result the ops do not yield', () => {
    const parent = commentsPlan()
    const { revision } = revise(parent, [REMOVE_QUESTION])

    expect(applyRevision(parent, { ...revision, result: revision.parent })).toMatchObject({
      ok: false,
      rejections: [{ kind: 'result-mismatch' }],
    })
  })

  test('should reject a document that is not a revision', () => {
    const parent = commentsPlan()

    expect(applyRevision(parent, { parent: 'abc', ops: [REMOVE_QUESTION], result: 'def' })).toMatchObject({
      ok: false,
      rejections: [{ kind: 'invalid-revision' }],
    })
    expect(createPlanRevision(parent, { ops: [{ op: 'rename', id: 'Q-delete' }] })).toMatchObject({
      ok: false,
      rejections: [{ kind: 'invalid-revision' }],
    })
  })

  test('should reject a result that fails the plan schema', () => {
    const unparsed = { ...commentsPlan(), summary: '' }

    expect(rejectionsOf(unparsed, [REMOVE_QUESTION])).toEqual([['invalid-result', undefined]])
  })

  test('should reject an op that names no element, as target, parent or sibling', () => {
    const parent = commentsPlan()

    expect(rejectionsOf(parent, [{ op: 'remove', id: 'route.missing', reason: 'r' }])).toEqual([['unknown-id', 'route.missing']])
    expect(rejectionsOf(parent, [{ ...ADD_DELETED_AT, parent: 'model.missing' }])).toEqual([['unknown-id', 'model.missing']])
    // A column of another model is an element of the plan and still no sibling.
    expect(rejectionsOf(parent, [{ ...ADD_DELETED_AT, before: 'column.post.id' }])).toEqual([['unknown-id', 'column.post.id']])
    expect(
      rejectionsOf(parent, [{ op: 'modify', section: 'columns', id: 'column.missing', element: own(DELETED_AT), reason: 'r' }]),
    ).toEqual([['unknown-id', 'column.missing']])
  })

  test('should reject a section that is not the one the id belongs to', () => {
    const parent = commentsPlan()

    expect(
      rejectionsOf(parent, [{ op: 'modify', section: 'columns', id: 'model.comment', element: own(DELETED_AT), reason: 'r' }]),
    ).toEqual([['section-mismatch', 'model.comment']])
    expect(rejectionsOf(parent, [{ ...ADD_DELETED_AT, parent: 'controller.comments', before: undefined }])).toEqual([
      ['section-mismatch', 'controller.comments'],
    ])
  })

  test('should reject an ADD whose id the plan already declares, in any section', () => {
    const parent = commentsPlan()

    expect(rejectionsOf(parent, [{ ...ADD_DELETED_AT, element: { ...DELETED_AT, id: 'route.comments.store' } }])).toEqual([
      ['duplicate-id', 'route.comments.store'],
    ])
  })

  test('should reject an ADD whose own nested elements share an id', () => {
    const parent = commentsPlan()
    const model = parent.models[1] as Plan['models'][number]
    const twin = { ...model, id: 'model.reply', columns: [DELETED_AT_COLUMN, DELETED_AT_COLUMN] }

    expect(rejectionsOf(parent, [{ op: 'add', section: 'models', element: twin, reason: 'r' }])).toEqual([
      ['duplicate-id', DELETED_AT.id],
    ])
  })

  test('should reject a parent that declares an id twice, since no op could address it', () => {
    const parent = commentsPlan()
    parent.routes.push(structuredClone(parent.routes[0]) as Plan['routes'][number])

    expect(rejectionsOf(parent, [REMOVE_QUESTION])).toEqual([['duplicate-id', 'route.comments.store']])
  })

  test('should reject a second op on one id, and accept REMOVE then ADD as a move', () => {
    const parent = commentsPlan()
    const [store, destroy] = parent.routes as [Plan['routes'][number], Plan['routes'][number]]
    const move = [
      { op: 'remove', id: store.id, reason: 'reorder' },
      { op: 'add', section: 'routes', element: store, reason: 'reorder' },
    ]

    expect(revise(parent, move).plan.routes.map((route) => route.id)).toEqual([destroy.id, store.id])
    expect(rejectionsOf(parent, [...move].reverse())).toContainEqual(['repeated-id', store.id])
    expect(rejectionsOf(parent, [ADD_DELETED_AT, { op: 'remove', id: DELETED_AT.id, reason: 'r' }])).toEqual([
      ['repeated-id', DELETED_AT.id],
    ])
    // Removing a model takes its columns along, so the column was already named.
    expect(
      rejectionsOf(parent, [
        { op: 'modify', section: 'columns', id: 'column.comment.body', element: { ...own(DELETED_AT), name: 'text' }, reason: 'r' },
        { op: 'remove', id: 'model.comment', reason: 'r' },
      ]),
    ).toContainEqual(['repeated-id', 'column.comment.body'])
  })

  test('should reject a MODIFY that changes nothing', () => {
    const parent = commentsPlan()
    const route = parent.routes[0] as Plan['routes'][number]

    expect(rejectionsOf(parent, [{ op: 'modify', section: 'routes', id: route.id, element: own(route), reason: 'r' }])).toEqual([
      ['unchanged', route.id],
    ])
    expect(rejectionsOf(parent, [{ op: 'modify', section: 'plan', element: headOf(parent), reason: 'r' }])).toEqual([
      ['unchanged', 'plan'],
    ])
  })

  test('should reject ops that cancel out and leave the plan as it was', () => {
    const parent = commentsPlan()
    const last = parent.routes.at(-1) as Plan['routes'][number]
    const retitled = { op: 'modify', section: 'plan', element: { ...headOf(parent), title: 'Another title' }, reason: 'r' }
    const restored = { op: 'modify', section: 'plan', element: headOf(parent), reason: 'r' }
    const putBack = [
      { op: 'remove', id: last.id, reason: 'r' },
      { op: 'add', section: 'routes', element: last, reason: 'r' },
    ]

    expect(rejectionsOf(parent, [retitled, restored])).toEqual([['revision-changes-nothing', undefined]])
    expect(rejectionsOf(parent, putBack)).toEqual([['revision-changes-nothing', undefined]])
    expect(rejectionsOf(parent, [retitled])).toEqual([])
  })

  test('should tell the op that changes nothing from the revision that changes nothing', () => {
    const parent = commentsPlan()
    const route = parent.routes[0] as Plan['routes'][number]
    const retitled = { op: 'modify', section: 'plan', element: { ...headOf(parent), title: 'Another title' }, reason: 'r' }
    const only = (ops: unknown[]): Json => {
      const created = createPlanRevision(parent, { ops })
      if (created.ok) throw new Error('the ops were accepted')
      return created.rejections[0] as unknown as Json
    }

    // A consumer reads `op` to point at the operation at fault, so the kind that has none must not be the same kind.
    expect(only([{ op: 'modify', section: 'routes', id: route.id, element: own(route), reason: 'r' }])).toEqual({
      kind: 'unchanged',
      op: 0,
      id: route.id,
      message: expect.any(String),
    })
    expect(only([retitled, { op: 'modify', section: 'plan', element: headOf(parent), reason: 'r' }])).toEqual({
      kind: 'revision-changes-nothing',
      message: expect.any(String),
    })
  })

  test('should hold a producer to one op and still take a stored revision with none', () => {
    const parent = commentsPlan()
    const hash = planHash(parent)

    expect(rejectionsOf(parent, [])).toEqual([['invalid-revision', undefined]])
    expect(applyRevision(parent, { parent: hash, ops: [], result: hash })).toMatchObject({
      ok: false,
      rejections: [{ kind: 'revision-changes-nothing' }],
    })
  })

  test('should diagnose a stored revision that misses its own result as a mismatch', () => {
    const parent = commentsPlan()
    const hash = planHash(parent)
    const last = parent.routes.at(-1) as Plan['routes'][number]
    const cancelling = [
      { op: 'remove', id: last.id, reason: 'r' },
      { op: 'add', section: 'routes', element: last, reason: 'r' },
    ]
    const bogus = 'f'.repeat(64)
    const kindsOf = (revision: unknown): string[] => {
      const applied = applyRevision(parent, revision)
      return applied.ok ? [] : applied.rejections.map((rejection) => rejection.kind)
    }

    expect(kindsOf({ parent: hash, ops: cancelling, result: hash })).toEqual(['revision-changes-nothing'])
    expect(kindsOf({ parent: hash, ops: cancelling, result: bogus })).toEqual(['result-mismatch'])
    expect(kindsOf({ parent: hash, ops: [], result: bogus })).toEqual(['result-mismatch'])
  })

  test('should reject a REMOVE that leaves another element naming the id', () => {
    const parent = commentsPlan()

    const rejections = rejectionsOf(parent, [{ op: 'remove', id: 'route.comments.destroy', reason: 'r' }])

    expect(rejections.length).toBeGreaterThan(0)
    expect(new Set(rejections.map(([kind, id]) => `${kind}:${id}`))).toEqual(new Set(['dangling-reference:route.comments.destroy']))
  })

  test('should accept a REMOVE once nothing names the id any more', () => {
    const parent = commentsPlan()
    const validator = parent.validators[0] as Plan['validators'][number]
    const unused = { ...validator, id: 'validator.unused' }
    const withUnused = revise(parent, [{ op: 'add', section: 'validators', element: unused, reason: 'r' }]).plan

    expect(rejectionsOf(withUnused, [{ op: 'remove', id: 'validator.unused', reason: 'r' }])).toEqual([])
    expect(rejectionsOf(withUnused, [{ op: 'remove', id: validator.id, reason: 'r' }])).toContainEqual([
      'dangling-reference',
      validator.id,
    ])
  })
})

function headOf(plan: Plan): Json {
  const { title, summary, scope, assumptions, hints, locale } = plan
  return { title, summary, scope, assumptions, hints, locale }
}

describe('the ids a revision tracks', () => {
  /**
   * The ids an op may address come from `PLAN_TOP_SECTIONS` and the nested-list map,
   * the declared ones from `listPlanElements`; nothing else holds the three together.
   */
  test('should reach every id the plan declares, nested lists included', () => {
    const parent = commentsPlan()
    const declared = listPlanElements(parent)
    const missed = declared.filter(({ id }) =>
      rejectionsOf(parent, [{ op: 'remove', id, reason: 'r' }]).some(([kind]) => kind === 'unknown-id'),
    )

    // A refusal ahead of the ops loop would report every id as reachable without an op ever naming one.
    expect(rejectionsOf(parent, [{ op: 'remove', id: 'no.such.element', reason: 'r' }])).toEqual([
      ['unknown-id', 'no.such.element'],
    ])
    // A fixture with no nested elements would pass the reachability assertion without checking a nested list.
    expect([...new Set(declared.map((ref) => ref.section))]).toEqual(
      expect.arrayContaining(['columns', 'actions', 'acceptance']),
    )
    expect(missed).toEqual([])
  })

  test('should count the nested ids an ADD brings and the ones a REMOVE takes along', () => {
    const parent = commentsPlan()
    const model = parent.models[1] as Plan['models'][number]
    const controller = parent.controllers[0] as Plan['controllers'][number]
    const task = parent.tasks[0] as Plan['tasks'][number]
    const twins = [
      ['models', { ...model, id: 'model.reply' }, model.columns],
      ['controllers', { ...controller, id: 'controller.replies' }, controller.actions],
      ['tasks', { ...task, id: 'task.replies' }, task.acceptance],
    ] as const

    // Nothing in the plan schema refuses a duplicated id, so one an ADD brought uncounted would ship in the result.
    for (const [section, element, nested] of twins) {
      expect(rejectionsOf(parent, [{ op: 'add', section, element, reason: 'r' }])).toEqual(
        nested
          .map((child) => child.id)
          .sort()
          .map((id) => ['duplicate-id', id]),
      )
    }

    const moved = revise(parent, [
      { op: 'remove', id: task.id, reason: 'r' },
      { op: 'add', section: 'tasks', element: { ...task, id: 'task.replies' }, reason: 'r' },
    ])

    expect(findDuplicatePlanIds(moved.plan)).toEqual([])
    expect(listPlanElements(moved.plan).map((ref) => ref.id)).toContain(task.acceptance[0]?.id)
  })
})

describe('nested elements and document order', () => {
  test('should put a nested ADD before the sibling it names, and at the end without one', () => {
    const parent = commentsPlan()
    const { before: _before, ...appended } = ADD_DELETED_AT
    const columns = (plan: Plan): string[] => (plan.models[1] as Plan['models'][number]).columns.map((column) => column.id)

    const placed = revise(parent, [ADD_DELETED_AT])
    const last = revise(parent, [appended])

    expect(columns(placed.plan)).toEqual([
      'column.comment.id',
      'column.comment.body',
      'column.comment.postId',
      'column.comment.deletedAt',
      'column.comment.createdAt',
    ])
    expect(columns(last.plan).at(-1)).toBe('column.comment.deletedAt')
    expect(placed.revision.result).not.toBe(last.revision.result)
  })

  test('should modify a nested element and leave its siblings and its parent alone', () => {
    const parent = commentsPlan()
    const model = parent.models[1] as Plan['models'][number]
    const body = model.columns[1] as Plan['models'][number]['columns'][number]

    const { plan } = revise(parent, [
      { op: 'modify', section: 'columns', id: body.id, element: { ...own(body), type: 'string' }, reason: 'shorter' },
    ])
    const revised = plan.models[1] as Plan['models'][number]

    expect(revised.columns[1]).toEqual({ ...body, type: 'string' })
    expect({ ...revised, columns: [] }).toEqual({ ...model, columns: [] })
    expect(revised.columns.filter((_, index) => index !== 1)).toEqual(model.columns.filter((_, index) => index !== 1))
  })

  test('should keep the nested elements of a modified parent', () => {
    const parent = commentsPlan()
    const model = parent.models[1] as Plan['models'][number]

    const { plan } = revise(parent, [
      { op: 'modify', section: 'models', id: model.id, element: { ...own(model, 'columns'), fillable: [] }, reason: 'r' },
    ])

    expect(plan.models[1]).toEqual({ ...model, fillable: [] })
  })

  test('should remove and add an acceptance behaviour under its task', () => {
    const parent = commentsPlan()
    const task = parent.tasks[0] as Plan['tasks'][number]
    const behaviour = task.acceptance[0] as Plan['tasks'][number]['acceptance'][number]

    const { plan } = revise(parent, [
      { op: 'remove', id: 'AC-comments-4', reason: 'r' },
      { op: 'add', section: 'acceptance', parent: task.id, element: { ...behaviour, id: 'AC-comments-5' }, before: behaviour.id, reason: 'r' },
    ])

    expect((plan.tasks[0] as Plan['tasks'][number]).acceptance.map((entry) => entry.id)).toEqual([
      'AC-comments-5',
      'AC-comments-1',
      'AC-comments-2',
      'AC-comments-3',
    ])
  })
})

describe('review state', () => {
  const retype = (reopens?: string): Json => ({
    op: 'modify',
    section: 'columns',
    id: 'column.comment.body',
    element: { ...own(commentsPlan().models[1]?.columns[1] as Json), type: 'string' },
    reason: 'shorter',
    ...(reopens ? { reopens } : {}),
  })

  test('should reject an op on an approved element that does not say it reopens it', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { elements: approve('column.comment.body') })

    expect(rejectionsOf(parent, [retype()], feedback)).toEqual([['locked', 'column.comment.body']])
    expect(rejectionsOf(parent, [retype()])).toEqual([])
  })

  test('should report reopened elements apart, and only those that were locked', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { elements: approve('column.comment.body') })

    const created = createPlanRevision(parent, { ops: [retype('the editor caps comments'), { ...ADD_DELETED_AT, reopens: 'unneeded' }] }, { feedback })

    expect(created).toMatchObject({ ok: true, reopened: [{ id: 'column.comment.body', op: 0, reason: 'the editor caps comments' }] })
    expect(created.ok && applyRevision(parent, created.revision, { feedback })).toMatchObject({
      reopened: [{ id: 'column.comment.body' }],
    })
  })

  test('should leave an element with a changes verdict or a bare comment unlocked', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, {
      elements: [{ elementId: 'column.comment.body', verdict: 'changes', comment: 'too long' }],
    })

    expect(rejectionsOf(parent, [retype()], feedback)).toEqual([])
  })

  test('should lock the nested elements of an approved parent, and the parent against a nested ADD', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { elements: approve('model.comment') })

    expect(rejectionsOf(parent, [retype()], feedback)).toEqual([['locked', 'column.comment.body']])
    expect(rejectionsOf(parent, [ADD_DELETED_AT], feedback)).toEqual([['locked', 'model.comment']])
    expect(rejectionsOf(parent, [{ ...ADD_DELETED_AT, reopens: 'soft delete needs the column' }], feedback)).toEqual([])
  })

  test('should let an ADD go before an approved sibling, since approval covers an element and not its place', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { elements: approve('column.comment.createdAt') })

    const created = createPlanRevision(parent, { ops: [ADD_DELETED_AT] }, { feedback })

    expect(created).toMatchObject({ ok: true, reopened: [] })
  })

  test('should hold a REMOVE of a parent to the locks on what it holds', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { elements: approve('AC-comments-1') })

    expect(rejectionsOf(parent, [{ op: 'remove', id: 'task.comments', reason: 'r' }], feedback)).toEqual([['locked', 'AC-comments-1']])
  })

  test('should reject feedback given on another plan, or naming what the parent lacks', () => {
    const parent = commentsPlan()

    expect(rejectionsOf(parent, [REMOVE_QUESTION], { planHash: 'f'.repeat(64), answers: [], elements: [] })).toEqual([
      ['feedback-mismatch', undefined],
    ])
    expect(rejectionsOf(parent, [REMOVE_QUESTION], { answers: [], elements: approve('model.gone') })).toEqual([
      ['unknown-feedback-id', 'model.gone'],
    ])
    expect(rejectionsOf(parent, [REMOVE_QUESTION], { answers: [{ questionId: 'model.comment', text: 'x' }], elements: [] })).toEqual([
      ['unknown-feedback-id', 'model.comment'],
    ])
  })

  test('should require the revision that applies an answer to remove the question', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { answers: [{ questionId: 'Q-delete', option: 'soft delete' }] })

    expect(rejectionsOf(parent, [ADD_DELETED_AT], feedback)).toEqual([['answered-question-kept', 'Q-delete']])
    expect(rejectionsOf(parent, [ADD_DELETED_AT, REMOVE_QUESTION], feedback)).toEqual([])
    expect(rejectionsOf(parent, [ADD_DELETED_AT])).toEqual([])
  })

  test('should let the revision reuse the id of the question it removes in another section', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { answers: [{ questionId: 'Q-delete', option: 'soft delete' }] })
    const reused = [
      REMOVE_QUESTION,
      {
        op: 'add',
        section: 'commands',
        element: { id: 'Q-delete', command: 'bun run db:migrate', reason: 'run the migration' },
        reason: 'r',
      },
    ]

    expect(rejectionsOf(parent, reused, feedback)).toEqual([])
    expect(rejectionsOf(parent, reused)).toEqual([])
  })

  test('should not let a question removed and added again count as removed', () => {
    const parent = commentsPlan()
    const feedback = feedbackOn(parent, { answers: [{ questionId: 'Q-delete', text: 'soft' }] })
    const question = parent.questions[0] as Plan['questions'][number]

    expect(
      rejectionsOf(parent, [REMOVE_QUESTION, { op: 'add', section: 'questions', element: question, reason: 'r' }], feedback),
    ).toEqual([['answered-question-kept', 'Q-delete']])
  })
})

describe('diffPlans', () => {
  function roundTrip(parent: Plan, child: Plan): ReturnType<typeof diffPlans> {
    const ops = diffPlans(parent, child, { reason: 'edited by hand' })
    const created = createPlanRevision(parent, { ops })
    if (!created.ok) throw new Error(JSON.stringify(created.rejections, null, 2))
    expect(created.revision.result).toBe(planHash(child))
    expect(applyRevision(parent, created.revision)).toMatchObject({ ok: true, hash: planHash(child) })
    return ops
  }

  test('should reproduce a plan edited in several places at once', () => {
    const parent = commentsPlan()
    const draft = structuredClone(parent) as Plan
    const comment = draft.models[1] as Plan['models'][number]
    draft.title = 'Soft-deleted comments'
    draft.assumptions.push('Deleted comments stay in the table')
    draft.questions = []
    comment.fillable = []
    comment.columns.splice(3, 0, DELETED_AT_COLUMN)
    comment.columns.reverse()
    ;(draft.controllers[0] as Plan['controllers'][number]).actions.reverse()
    draft.routes.reverse()
    ;(draft.routes[0] as Plan['routes'][number]).middleware = ['auth', 'throttle']
    ;(draft.tasks[0] as Plan['tasks'][number]).acceptance.splice(1, 1)
    const child = PlanSchema.parse(draft)

    const ops = roundTrip(parent, child)

    expect(ops.map((op) => op.op)).toContain('add')
    expect(ops.map((op) => op.op)).toContain('modify')
    expect(ops.map((op) => op.op)).toContain('remove')
  })

  test('should yield the fewest ops: one per changed element and none for the rest', () => {
    const parent = commentsPlan()
    const draft = structuredClone(parent) as Plan
    ;(draft.models[1] as Plan['models'][number]).columns.splice(3, 0, DELETED_AT_COLUMN)
    ;(draft.routes[1] as Plan['routes'][number]).path = '/comments/:comment'
    const child = PlanSchema.parse(draft)

    expect(roundTrip(parent, child)).toMatchObject([
      { op: 'modify', section: 'routes', id: 'route.comments.destroy' },
      { op: 'add', section: 'columns', parent: 'model.comment', before: 'column.comment.createdAt' },
    ])
    expect(diffPlans(parent, commentsPlan(), { reason: 'r' })).toEqual([])
    expect(rejectionsOf(parent, diffPlans(parent, commentsPlan(), { reason: 'r' }))).toEqual([['invalid-revision', undefined]])
  })

  test('should move one element rather than rewrite the list around it', () => {
    const parent = commentsPlan()
    const draft = structuredClone(parent) as Plan
    const columns = (draft.models[1] as Plan['models'][number]).columns
    columns.push(columns.shift() as (typeof columns)[number])
    const child = PlanSchema.parse(draft)

    expect(roundTrip(parent, child)).toMatchObject([
      { op: 'remove', id: 'column.comment.id' },
      { op: 'add', section: 'columns', parent: 'model.comment', element: { id: 'column.comment.id' } },
    ])
  })

  test('should move a nested element to another parent', () => {
    const parent = commentsPlan()
    const draft = structuredClone(parent) as Plan
    const [post, comment] = draft.models as [Plan['models'][number], Plan['models'][number]]
    post.columns.push(comment.columns.pop() as Plan['models'][number]['columns'][number])

    roundTrip(parent, PlanSchema.parse(draft))
  })

  test('should put reopens on every op when asked, so a hand edit can pass the locks', () => {
    const parent = commentsPlan()
    const draft = structuredClone(parent) as Plan
    ;(draft.routes[0] as Plan['routes'][number]).path = '/posts/:post/replies'
    const feedback = feedbackOn(parent, { elements: approve('route.comments.store') })

    const ops = diffPlans(parent, PlanSchema.parse(draft), { reason: 'r', reopens: 'renamed by hand' })

    expect(createPlanRevision(parent, { ops }, { feedback })).toMatchObject({ ok: true, reopened: [{ id: 'route.comments.store' }] })
  })

  test('should throw on a baseline that differs, which no op can express', () => {
    const parent = commentsPlan()
    const child = { ...parent, baseline: { ...parent.baseline, rev: 'ffffffff' } }

    expect(() => diffPlans(parent, child, { reason: 'r' })).toThrow('baseline')
  })
})
