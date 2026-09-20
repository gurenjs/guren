/**
 * Plan revisions (RFC 0030 §4): `{ parent, ops, result }`. A producer emits `ops`
 * only; `parent` and `result` are hashes Guren stamps and re-checks.
 * An op addresses an element by its plan-unique id, nested elements included.
 * MODIFY carries the element's own fields whole, with no `id` and no nested list
 * in its shape: an id cannot change, and a column changes only through an op
 * naming that column. A merge patch would need a second, partial copy of every
 * element schema and a way to say "unset" that closed objects do not have.
 */

import { z } from 'zod'

import { formatSchemaIssues } from '../cli-error'
import type { PlanFeedback } from './feedback'
import { canonicalJson, planHash } from './identity'
import { findDuplicatePlanIds, listPlanElements, PlanSchema, type Plan, type PlanElementSection } from './schema'

const shape = PlanSchema.shape

const Question = shape.questions.unwrap().element
const Model = shape.models.unwrap().element
const Column = Model.shape.columns.element
const Validator = shape.validators.unwrap().element
const Controller = shape.controllers.unwrap().element
const Action = Controller.shape.actions.element
const Route = shape.routes.unwrap().element
const View = shape.views.unwrap().element
const Resource = shape.resources.unwrap().element
const Policy = shape.policies.unwrap().element
const SideEffect = shape.sideEffects.unwrap().element
const Flow = shape.flows.unwrap().element
const Command = shape.commands.unwrap().element
const Task = shape.tasks.unwrap().element
const Acceptance = Task.shape.acceptance.element

const IdSchema = Question.shape.id
const NonEmptySchema = z.string().min(1)
const HashSchema = z.string().regex(/^[0-9a-f]{64}$/)

/** `reopens` is what an op on an approved element must say; it is ignored where nothing is locked. */
const note = { reason: NonEmptySchema, reopens: NonEmptySchema.optional() }

/** The section a nested element lives under. The list key on the parent is the nested section's own name. */
const PARENT_SECTION = { columns: 'models', actions: 'controllers', acceptance: 'tasks' } as const
const NESTED_KEY = { models: 'columns', controllers: 'actions', tasks: 'acceptance' } as const

const TOP_SECTIONS = [
  'questions',
  'models',
  'validators',
  'controllers',
  'routes',
  'views',
  'resources',
  'policies',
  'sideEffects',
  'flows',
  'commands',
  'tasks',
] as const satisfies ReadonlyArray<PlanElementSection>

// Array order is part of the hash, so an ADD says where it goes: before a sibling, or at the end.
const add = <S extends string, E extends z.ZodType>(section: S, element: E) =>
  z.strictObject({ op: z.literal('add'), section: z.literal(section), element, before: IdSchema.optional(), ...note })

const addUnder = <S extends string, E extends z.ZodType>(section: S, element: E) =>
  z.strictObject({
    op: z.literal('add'),
    section: z.literal(section),
    parent: IdSchema,
    element,
    before: IdSchema.optional(),
    ...note,
  })

const modify = <S extends string, E extends z.ZodType>(section: S, element: E) =>
  z.strictObject({ op: z.literal('modify'), section: z.literal(section), id: IdSchema, element, ...note })

const AddOpSchema = z.discriminatedUnion('section', [
  add('questions', Question),
  add('models', Model),
  addUnder('columns', Column),
  add('validators', Validator),
  add('controllers', Controller),
  addUnder('actions', Action),
  add('routes', Route),
  add('views', View),
  add('resources', Resource),
  add('policies', Policy),
  add('sideEffects', SideEffect),
  add('flows', Flow),
  add('commands', Command),
  add('tasks', Task),
  addUnder('acceptance', Acceptance),
])

// The title and the other unnamed fields have no id, so the document head is addressed as the section `plan`.
// Defaulted lists are required here: a MODIFY replaces, and an omitted list would read as an emptied one.
const PlanHeadSchema = z.strictObject({
  title: shape.title,
  summary: shape.summary,
  scope: shape.scope,
  assumptions: shape.assumptions.unwrap(),
  hints: shape.hints.unwrap(),
  locale: shape.locale,
})

const ModifyOpSchema = z.discriminatedUnion('section', [
  z.strictObject({ op: z.literal('modify'), section: z.literal('plan'), element: PlanHeadSchema, reason: NonEmptySchema }),
  modify('questions', Question.omit({ id: true })),
  modify('models', Model.omit({ id: true, columns: true }).extend({ indexes: Model.shape.indexes.unwrap() })),
  modify('columns', Column.omit({ id: true })),
  modify('validators', Validator.omit({ id: true })),
  modify('controllers', Controller.omit({ id: true, actions: true })),
  modify('actions', Action.omit({ id: true })),
  modify('routes', Route.omit({ id: true })),
  modify('views', View.omit({ id: true })),
  modify('resources', Resource.omit({ id: true })),
  modify('policies', Policy.omit({ id: true })),
  modify('sideEffects', SideEffect.omit({ id: true })),
  modify('flows', Flow.omit({ id: true })),
  modify('commands', Command.omit({ id: true })),
  modify('tasks', Task.omit({ id: true, acceptance: true })),
  modify('acceptance', Acceptance.omit({ id: true })),
])

/** Removing a parent removes what it holds. An id changes by REMOVE and ADD, which says so twice. */
const RemoveOpSchema = z.strictObject({ op: z.literal('remove'), id: IdSchema, ...note })

export const PlanRevisionOpSchema = z.discriminatedUnion('op', [AddOpSchema, ModifyOpSchema, RemoveOpSchema])

/** What a producer emits. */
export const PlanRevisionOpsSchema = z.strictObject({ ops: z.array(PlanRevisionOpSchema).min(1) })

export const PlanRevisionSchema = z.strictObject({
  parent: HashSchema,
  ops: PlanRevisionOpsSchema.shape.ops,
  result: HashSchema,
})

export type PlanRevisionOp = z.infer<typeof PlanRevisionOpSchema>
export type PlanRevision = z.infer<typeof PlanRevisionSchema>

/** The JSON Schema a revising producer is held to; draft-07, as `planDraftJsonSchema()`. */
export function planRevisionOpsJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PlanRevisionOpsSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
}

/**
 * Every place an element names another by id, as `[owner, path]` under the plan.
 * `plan-revision.test.ts` holds the list to the schema's id-typed fields.
 * Flow step ids and edge ends are the flow's own namespace and are not listed.
 */
export const PLAN_REFERENCE_PATHS: ReadonlyArray<readonly [owner: string, path: string]> = [
  ['questions[]', 'affects[]'],
  ['models[]', 'relationships[].target'],
  ['models[].columns[]', 'references.model'],
  ['controllers[].actions[]', 'params'],
  ['controllers[].actions[]', 'query'],
  ['controllers[].actions[]', 'body'],
  ['controllers[].actions[]', 'authorization.policy.id'],
  ['controllers[].actions[]', 'response.view'],
  ['controllers[].actions[]', 'response.resource'],
  ['routes[]', 'action'],
  ['routes[]', 'bind[].model'],
  ['views[]', 'props[].resource'],
  ['views[]', 'form.validator'],
  ['views[]', 'form.submitsTo'],
  ['views[]', 'actions[].route'],
  ['resources[]', 'model'],
  ['policies[]', 'model'],
  ['flows[]', 'nodes[].element'],
  ['tasks[]', 'covers[]'],
  ['tasks[].acceptance[]', 'route'],
  ['tasks[].acceptance[]', 'expect.inertia'],
]

export type PlanRevisionRejectionKind =
  | 'invalid-revision'
  | 'parent-mismatch'
  | 'feedback-mismatch'
  | 'unknown-feedback-id'
  | 'unknown-id'
  | 'section-mismatch'
  | 'duplicate-id'
  | 'repeated-id'
  | 'unchanged'
  | 'locked'
  | 'answered-question-kept'
  | 'dangling-reference'
  | 'invalid-result'
  | 'result-mismatch'

export interface PlanRevisionRejection {
  kind: PlanRevisionRejectionKind
  message: string
  /** Index into `ops`, where one op is at fault. */
  op?: number
  id?: string
}

/** A locked element an op touched with `reopens`; the page lists these apart from the rest. */
export interface PlanReopenedElement {
  id: string
  op: number
  reason: string
}

export interface PlanRevisionOptions {
  /** The review the revision answers. Absent means nothing is locked and no question is answered. */
  feedback?: PlanFeedback
}

export type ApplyRevisionResult =
  | { ok: true; plan: Plan; hash: string; reopened: PlanReopenedElement[] }
  | { ok: false; rejections: PlanRevisionRejection[] }

export type CreateRevisionResult =
  | { ok: true; revision: PlanRevision; plan: Plan; reopened: PlanReopenedElement[] }
  | { ok: false; rejections: PlanRevisionRejection[] }

type Element = Record<string, unknown> & { id: string }
type Holder = Record<string, unknown>

interface Located {
  section: PlanElementSection
  list: Element[]
  index: number
  element: Element
}

function locate(plan: Holder, id: string): Located | undefined {
  for (const section of TOP_SECTIONS) {
    const list = plan[section] as Element[]
    for (const [index, element] of list.entries()) {
      if (element.id === id) return { section, list, index, element }
      const key = nestedKey(section)
      if (!key) continue
      const nested = element[key] as Element[]
      const at = nested.findIndex((child) => child.id === id)
      if (at >= 0) return { section: key, list: nested, index: at, element: nested[at] as Element }
    }
  }
  return undefined
}

function nestedKey(section: string): PlanElementSection | undefined {
  return (NESTED_KEY as Record<string, PlanElementSection | undefined>)[section]
}

function withNested(section: string, element: Element): string[] {
  const key = nestedKey(section)
  return [element.id, ...(key ? (element[key] as Element[]).map((child) => child.id) : [])]
}

function ownFields(section: string, element: Holder): Holder {
  const own = { ...element }
  delete own.id
  const key = nestedKey(section)
  if (key) delete own[key]
  return own
}

function planHead(plan: Holder): Holder {
  return Object.fromEntries(Object.keys(PlanHeadSchema.shape).map((key) => [key, plan[key]]))
}

function collect(value: unknown, path: string): unknown[] {
  let found: unknown[] = [value]
  for (const segment of path.split('.')) {
    const many = segment.endsWith('[]')
    const key = many ? segment.slice(0, -2) : segment
    found = found.flatMap((item) => {
      const member = item !== null && typeof item === 'object' ? (item as Holder)[key] : undefined
      if (member === undefined) return []
      return many ? (member as unknown[]) : [member]
    })
  }
  return found
}

function referencesTo(plan: Holder, id: string): string[] {
  const owners: string[] = []
  for (const [ownerPath, path] of PLAN_REFERENCE_PATHS) {
    for (const owner of collect(plan, ownerPath) as Element[]) {
      if (collect(owner, path).includes(id)) owners.push(owner.id)
    }
  }
  return owners
}

/** An approved parent was approved with what it holds, so its nested elements are locked with it. */
function lockedIds(parent: Plan, feedback: PlanFeedback | undefined, rejections: PlanRevisionRejection[]): Set<string> {
  const locked = new Set<string>()
  for (const entry of feedback?.elements ?? []) {
    const found = locate(parent, entry.elementId)
    if (!found) {
      rejections.push({
        kind: 'unknown-feedback-id',
        id: entry.elementId,
        message: `The feedback names "${entry.elementId}", which the parent plan does not declare.`,
      })
      continue
    }
    if (entry.verdict !== 'approve') continue
    for (const id of withNested(found.section, found.element)) locked.add(id)
  }
  return locked
}

function applyOps(
  parent: Plan,
  ops: ReadonlyArray<PlanRevisionOp>,
  feedback: PlanFeedback | undefined,
): { plan: Plan; reopened: PlanReopenedElement[] } | PlanRevisionRejection[] {
  const rejections: PlanRevisionRejection[] = []

  // A lock that names another plan's elements is a lock silently not applied.
  if (feedback?.planHash !== undefined && feedback.planHash !== planHash(parent)) {
    return [{ kind: 'feedback-mismatch', message: `The feedback was given on plan ${feedback.planHash}, not on the parent.` }]
  }
  for (const id of findDuplicatePlanIds(parent)) {
    rejections.push({ kind: 'duplicate-id', id, message: `The parent declares "${id}" twice, so no op can address it.` })
  }
  if (rejections.length > 0) return rejections

  const locked = lockedIds(parent, feedback, rejections)
  // `baseline` is carried over untouched: no op names it, so the hash moves through ops alone.
  const plan = structuredClone(parent) as Plan & Holder
  const reopened: PlanReopenedElement[] = []
  const targeted = new Map<string, PlanRevisionOp['op']>()
  const removedBy = new Map<string, number>()

  ops.forEach((op, index) => {
    const reject = (kind: PlanRevisionRejectionKind, id: string, message: string): void => {
      rejections.push({ kind, op: index, id, message: `ops[${index}]: ${message}` })
    }
    // One op per id keeps the list the page shows the whole story; REMOVE then ADD is how an element moves.
    const claim = (ids: string[]): boolean => {
      const repeated = ids.filter((id) => targeted.has(id) && !(targeted.get(id) === 'remove' && op.op === 'add'))
      for (const id of repeated) reject('repeated-id', id, `"${id}" is already the target of an earlier op.`)
      for (const id of ids) targeted.set(id, op.op)
      return repeated.length === 0
    }
    const touch = (ids: string[]): void => {
      for (const id of ids.filter((candidate) => locked.has(candidate))) {
        if ('reopens' in op && op.reopens !== undefined) reopened.push({ id, op: index, reason: op.reopens })
        else reject('locked', id, `"${id}" was approved; an op on it must carry \`reopens\`.`)
      }
    }

    if (op.op === 'remove') {
      const found = locate(plan, op.id)
      if (!found) return reject('unknown-id', op.id, `"${op.id}" names no element.`)
      const ids = withNested(found.section, found.element)
      if (!claim(ids)) return
      touch(ids)
      found.list.splice(found.index, 1)
      for (const id of ids) removedBy.set(id, index)
      return
    }

    if (op.op === 'modify') {
      if (op.section === 'plan') {
        if (canonicalJson(planHead(plan)) === canonicalJson(op.element)) {
          return reject('unchanged', 'plan', 'the plan head already reads this way.')
        }
        Object.assign(plan, op.element)
        return
      }
      const found = locate(plan, op.id)
      if (!found) return reject('unknown-id', op.id, `"${op.id}" names no element.`)
      if (found.section !== op.section) {
        return reject('section-mismatch', op.id, `"${op.id}" is a ${found.section} element, not a ${op.section} one.`)
      }
      if (!claim([op.id])) return
      touch([op.id])
      if (canonicalJson(ownFields(op.section, found.element)) === canonicalJson(op.element)) {
        return reject('unchanged', op.id, `"${op.id}" already reads this way.`)
      }
      const key = nestedKey(op.section)
      found.list[found.index] = { id: op.id, ...op.element, ...(key ? { [key]: found.element[key] } : {}) }
      return
    }

    let list = plan[op.section] as Element[]
    if ('parent' in op) {
      const holder = locate(plan, op.parent)
      if (!holder) return reject('unknown-id', op.parent, `parent "${op.parent}" names no element.`)
      const expected = PARENT_SECTION[op.section]
      if (holder.section !== expected) {
        return reject('section-mismatch', op.parent, `parent "${op.parent}" is a ${holder.section} element, not a ${expected} one.`)
      }
      touch([op.parent])
      list = holder.element[op.section] as Element[]
    }
    const at = op.before === undefined ? list.length : list.findIndex((sibling) => sibling.id === op.before)
    if (at < 0) return reject('unknown-id', op.before as string, `\`before\` "${op.before}" is not among the siblings.`)
    if (!claim(withNested(op.section, op.element))) return
    list.splice(at, 0, op.element)
    const duplicates = findDuplicatePlanIds(plan)
    if (duplicates.length === 0) return
    list.splice(at, 1)
    for (const id of duplicates) reject('duplicate-id', id, `"${id}" is already declared.`)
  })

  const remaining = new Set(listPlanElements(plan).map((ref) => ref.id))
  for (const [id, index] of removedBy) {
    if (remaining.has(id)) continue
    for (const owner of new Set(referencesTo(plan, id))) {
      rejections.push({
        kind: 'dangling-reference',
        op: index,
        id,
        message: `ops[${index}]: "${id}" is removed while "${owner}" still names it.`,
      })
    }
  }

  // Removing the question is what clears its "depends on" marks: the page derives them from `affects`.
  for (const answer of feedback?.answers ?? []) {
    const found = locate(parent, answer.questionId)
    if (found?.section !== 'questions') {
      rejections.push({
        kind: 'unknown-feedback-id',
        id: answer.questionId,
        message: `The feedback answers "${answer.questionId}", which is no question of the parent plan.`,
      })
    } else if (plan.questions.some((question) => question.id === answer.questionId)) {
      rejections.push({
        kind: 'answered-question-kept',
        id: answer.questionId,
        message: `"${answer.questionId}" was answered; the revision that applies the answer removes the question.`,
      })
    }
  }

  if (rejections.length > 0) return rejections

  const parsed = PlanSchema.safeParse(plan)
  if (!parsed.success) return [{ kind: 'invalid-result', message: formatSchemaIssues(parsed.error) }]
  return { plan: parsed.data, reopened }
}

function parseFailure(error: z.ZodError): { ok: false; rejections: PlanRevisionRejection[] } {
  return { ok: false, rejections: [{ kind: 'invalid-revision', message: formatSchemaIssues(error) }] }
}

/** Stamps `parent` and `result` on a producer's ops. `document` is model output, so it is parsed here. */
export function createPlanRevision(parent: Plan, document: unknown, options: PlanRevisionOptions = {}): CreateRevisionResult {
  const parsed = PlanRevisionOpsSchema.safeParse(document)
  if (!parsed.success) return parseFailure(parsed.error)

  const applied = applyOps(parent, parsed.data.ops, options.feedback)
  if (Array.isArray(applied)) return { ok: false, rejections: applied }
  const revision = { parent: planHash(parent), ops: parsed.data.ops, result: planHash(applied.plan) }
  return { ok: true, revision, ...applied }
}

/** The plan a revision yields, or why it is refused. Never mutates `parent`. */
export function applyRevision(parent: Plan, revision: unknown, options: PlanRevisionOptions = {}): ApplyRevisionResult {
  const parsed = PlanRevisionSchema.safeParse(revision)
  if (!parsed.success) return parseFailure(parsed.error)

  const actual = planHash(parent)
  if (parsed.data.parent !== actual) {
    const message = `The revision was written against plan ${parsed.data.parent}; this plan is ${actual}.`
    return { ok: false, rejections: [{ kind: 'parent-mismatch', message }] }
  }

  const applied = applyOps(parent, parsed.data.ops, options.feedback)
  if (Array.isArray(applied)) return { ok: false, rejections: applied }

  const hash = planHash(applied.plan)
  if (hash !== parsed.data.result) {
    const message = `The ops yield plan ${hash}, not the ${parsed.data.result} the revision names.`
    return { ok: false, rejections: [{ kind: 'result-mismatch', message }] }
  }
  return { ok: true, hash, ...applied }
}

export interface DiffPlansOptions {
  reason: string
  /** Put on every op; it only counts where the feedback locked the element. */
  reopens?: string
}

/**
 * The fewest ops that turn `parent` into `child`, for a plan edited by hand. An element
 * that changed place is a REMOVE and an ADD. Throws where no op could express the edit.
 */
export function diffPlans(parent: Plan, child: Plan, options: DiffPlansOptions): PlanRevisionOp[] {
  if (canonicalJson(parent.baseline) !== canonicalJson(child.baseline)) {
    throw new Error('A revision carries `baseline` over unchanged, so no ops express a plan with another one.')
  }

  const stamp = { reason: options.reason, ...(options.reopens === undefined ? {} : { reopens: options.reopens }) }
  const removes: unknown[] = []
  const modifies: unknown[] = []
  const adds: unknown[] = []

  if (canonicalJson(planHead(parent)) !== canonicalJson(planHead(child))) {
    modifies.push({ op: 'modify', section: 'plan', element: planHead(child), reason: options.reason })
  }

  const diffList = (section: string, before: Element[], after: Element[], parentId?: string): void => {
    const kept = commonOrder(before.map((element) => element.id), after.map((element) => element.id))
    for (const element of before) {
      if (!kept.has(element.id)) removes.push({ op: 'remove', id: element.id, ...stamp })
    }
    after.forEach((element, index) => {
      if (!kept.has(element.id)) {
        const anchor = after.slice(index + 1).find((later) => kept.has(later.id))
        const where = { ...(parentId === undefined ? {} : { parent: parentId }), ...(anchor ? { before: anchor.id } : {}) }
        adds.push({ op: 'add', section, ...where, element, ...stamp })
        return
      }
      const previous = before.find((candidate) => candidate.id === element.id) as Element
      const own = ownFields(section, element)
      if (canonicalJson(ownFields(section, previous)) !== canonicalJson(own)) {
        modifies.push({ op: 'modify', section, id: element.id, element: own, ...stamp })
      }
      const key = nestedKey(section)
      if (key) diffList(key, previous[key] as Element[], element[key] as Element[], element.id)
    })
  }

  for (const section of TOP_SECTIONS) diffList(section, parent[section], child[section])
  // Removes first: an element that moved is free to be added again, and every `before` names a kept sibling.
  return z.array(PlanRevisionOpSchema).parse([...removes, ...modifies, ...adds])
}

/** The ids of a longest common subsequence: the elements that did not move. */
function commonOrder(before: string[], after: string[]): Set<string> {
  const lengths = Array.from({ length: before.length + 1 }, () => Array.from({ length: after.length + 1 }, () => 0))
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const row = lengths[i] as number[]
      const next = lengths[i + 1] as number[]
      row[j] = before[i] === after[j] ? (next[j + 1] as number) + 1 : Math.max(next[j] as number, row[j + 1] as number)
    }
  }
  const kept = new Set<string>()
  for (let i = 0, j = 0; i < before.length && j < after.length; ) {
    if (before[i] === after[j]) {
      kept.add(before[i] as string)
      i++
      j++
    } else if (((lengths[i + 1] as number[])[j] as number) >= ((lengths[i] as number[])[j + 1] as number)) i++
    else j++
  }
  return kept
}
