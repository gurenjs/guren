/**
 * The implementation plan document (RFC 0030 §1). One Zod schema is both the JSON
 * Schema a producer is held to and the validator for whatever comes back.
 * Objects are strict and values are never open records: a structured-output
 * producer needs `additionalProperties: false` throughout, which is why free-form
 * values travel as JSON text (`PlanJsonValue`).
 */

import { z } from 'zod'

export const PLAN_VERSION = 1

const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/

// `constructor` and `toString` match the pattern, and any consumer that keys a plain
// object by id reads the inherited function back instead of `undefined`.
const IdSchema = z
  .string()
  .regex(ID_PATTERN)
  .refine((id) => !(id in Object.prototype), { message: 'must not name an Object.prototype member' })

/**
 * `rename.from` is the previous value of the element's primary name: a model's class
 * `name`, a column's property `name`, a route's `name`. A table renamed under an
 * unchanged class says so with `PlanModel.tableRenamedFrom`.
 */
const ChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('existing') }),
  z.strictObject({ kind: z.literal('add') }),
  z.strictObject({ kind: z.literal('alter') }),
  z.strictObject({ kind: z.literal('rename'), from: z.string().min(1) }),
  z.strictObject({ kind: z.literal('drop'), reason: z.string().min(1) }),
])

const DataMigrationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none'), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal('backfill'), description: z.string().min(1) }),
  z.strictObject({ kind: z.literal('manual'), description: z.string().min(1) }),
])

/** A named value whose content is JSON text, e.g. `{ name: 'published', json: 'true' }`. */
const PlanJsonValueSchema = z.strictObject({
  name: z.string().min(1),
  json: z.string().refine(isJsonText, { message: 'must be valid JSON text' }),
})

export const PLAN_COLUMN_TYPES = [
  'string',
  'text',
  'integer',
  'number',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'json',
  'uuid',
] as const

const PlanColumnSchema = z.strictObject({
  id: IdSchema,
  /** The model property. `columnName` is the SQL name where the two differ. */
  name: z.string().min(1),
  columnName: z.string().min(1).optional(),
  change: ChangeSchema,
  type: z.enum(PLAN_COLUMN_TYPES),
  /** `decimal` only. */
  precision: z.number().int().positive().optional(),
  scale: z.number().int().nonnegative().optional(),
  /** `datetime` only; Postgres stores the two as different column types. */
  withTimezone: z.boolean().optional(),
  nullable: z.boolean(),
  unique: z.boolean(),
  index: z.boolean(),
  primaryKey: z.boolean().optional(),
  /** The default as the schema would write it, as text: `false`, `'draft'`, `now()`. */
  default: z.string().optional(),
  references: z
    .strictObject({
      model: IdSchema,
      column: z.string().min(1),
      onDelete: z.enum(['cascade', 'restrict', 'set null', 'no action']).optional(),
    })
    .optional(),
  dataMigration: DataMigrationSchema.optional(),
})

const PlanRelationshipSchema = z.strictObject({
  name: z.string().min(1),
  type: z.enum(['hasOne', 'hasMany', 'belongsTo', 'belongsToMany']),
  target: IdSchema,
})

const PlanModelSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  name: z.string().min(1),
  table: z.string().min(1),
  tableRenamedFrom: z.string().min(1).optional(),
  module: z.string().optional(),
  /** On an `existing` or `alter` model, only the columns the plan touches or references. */
  columns: z.array(PlanColumnSchema),
  /** Constraints spanning columns; a single-column one is the column's own `unique` / `index`. */
  indexes: z
    .array(z.strictObject({ columns: z.array(z.string().min(1)).min(2), unique: z.boolean() }))
    .default([]),
  relationships: z.array(PlanRelationshipSchema),
  fillable: z.array(z.string()),
  dataMigration: DataMigrationSchema.optional(),
})

const PlanValidatorSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  name: z.string().min(1),
  module: z.string().optional(),
  fields: z.array(
    z.strictObject({
      name: z.string().min(1),
      type: z.enum(PLAN_COLUMN_TYPES),
      required: z.boolean(),
      rules: z.array(z.string()),
    }),
  ),
})

const PlanResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inertia'), view: IdSchema }),
  z.strictObject({ kind: z.literal('redirect'), to: z.string().min(1) }),
  z.strictObject({ kind: z.literal('resource'), resource: IdSchema }),
  z.strictObject({ kind: z.literal('json'), description: z.string().min(1) }),
  z.strictObject({ kind: z.literal('empty') }),
])

const PlanActionSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  name: z.string().min(1),
  params: IdSchema.optional(),
  query: IdSchema.optional(),
  body: IdSchema.optional(),
  authorization: z.strictObject({
    middleware: z.array(z.string()),
    policy: z.strictObject({ id: IdSchema, ability: z.string().min(1) }).optional(),
  }),
  response: PlanResponseSchema,
  rules: z.array(z.string()),
})

const PlanControllerSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  className: z.string().min(1),
  module: z.string().optional(),
  actions: z.array(PlanActionSchema),
})

export const PLAN_HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'QUERY'] as const

const PlanRouteSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  method: z.enum(PLAN_HTTP_METHODS),
  path: z.string().startsWith('/'),
  name: z.string().min(1),
  action: IdSchema,
  middleware: z.array(z.string()),
  /** `key` is the lookup column; absent means the primary key. */
  bind: z.array(z.strictObject({ param: z.string().min(1), model: IdSchema, key: z.string().min(1).optional() })),
  agent: z.strictObject({ toolName: z.string().min(1), readOnly: z.boolean() }).optional(),
})

const PlanViewSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  page: z.string().min(1),
  module: z.string().optional(),
  purpose: z.string().min(1),
  props: z.array(
    z.strictObject({ name: z.string().min(1), type: z.string().min(1), resource: IdSchema.optional() }),
  ),
  form: z
    .strictObject({
      validator: IdSchema,
      submitsTo: IdSchema,
      fields: z.array(
        z.strictObject({
          field: z.string().min(1),
          label: z.string().min(1),
          input: z.enum(['text', 'textarea', 'number', 'checkbox', 'select', 'date', 'datetime', 'file', 'hidden']),
        }),
      ),
    })
    .optional(),
  actions: z.array(z.strictObject({ label: z.string().min(1), route: IdSchema })),
  states: z.strictObject({
    empty: z.string().optional(),
    error: z.string().optional(),
    loading: z.string().optional(),
  }),
})

const PlanResourceSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  name: z.string().min(1),
  module: z.string().optional(),
  model: IdSchema,
  fields: z.array(z.strictObject({ name: z.string().min(1), type: z.string().min(1) })),
})

const PlanPolicySchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  name: z.string().min(1),
  module: z.string().optional(),
  model: IdSchema,
  abilities: z.array(z.strictObject({ name: z.string().min(1), rule: z.string().min(1) })),
})

const PlanSideEffectSchema = z.strictObject({
  id: IdSchema,
  change: ChangeSchema,
  kind: z.enum(['job', 'event', 'listener', 'mail', 'notification']),
  name: z.string().min(1),
  module: z.string().optional(),
  trigger: z.string().min(1),
  description: z.string().min(1),
})

const PlanCommandSchema = z.strictObject({
  id: IdSchema,
  command: z.string().min(1),
  reason: z.string().min(1),
})

export const ACCEPTANCE_KINDS = [
  'success',
  'validation',
  'unauthenticated',
  'forbidden',
  'not-found',
  'state',
] as const

const AcceptanceSchema = z.strictObject({
  id: IdSchema,
  description: z.string().min(1),
  kind: z.enum(ACCEPTANCE_KINDS),
  actor: z.string().min(1),
  route: IdSchema,
  given: z.array(z.string()),
  input: z.array(PlanJsonValueSchema).optional(),
  expect: z.strictObject({
    status: z.number().int().min(100).max(599).optional(),
    redirect: z.string().optional(),
    inertia: IdSchema.optional(),
    errors: z.array(z.string()).optional(),
    database: z
      .array(
        z.strictObject({
          table: z.string().min(1),
          has: z.array(PlanJsonValueSchema).optional(),
          missing: z.array(PlanJsonValueSchema).optional(),
        }),
      )
      .optional(),
  }),
})

const PlanTaskIntentSchema = z.strictObject({
  id: IdSchema,
  entity: z.string().min(1),
  summary: z.string().min(1),
  covers: z.array(IdSchema),
  acceptance: z.array(AcceptanceSchema),
})

const PlanQuestionSchema = z.strictObject({
  id: IdSchema,
  question: z.string().min(1),
  options: z.array(z.strictObject({ label: z.string().min(1), consequence: z.string().min(1) })).min(2),
  assumed: z.string().min(1),
  affects: z.array(IdSchema),
})

// Sections default to [], so parsing normalizes an omitted section and an empty one to the same plan.
const draftShape = {
  planVersion: z.literal(PLAN_VERSION),
  title: z.string().min(1),
  summary: z.string().min(1),
  scope: z.strictObject({ goals: z.array(z.string()), nonGoals: z.array(z.string()) }),
  assumptions: z.array(z.string()).default([]),
  questions: z.array(PlanQuestionSchema).default([]),
  models: z.array(PlanModelSchema).default([]),
  validators: z.array(PlanValidatorSchema).default([]),
  controllers: z.array(PlanControllerSchema).default([]),
  routes: z.array(PlanRouteSchema).default([]),
  views: z.array(PlanViewSchema).default([]),
  resources: z.array(PlanResourceSchema).default([]),
  policies: z.array(PlanPolicySchema).default([]),
  sideEffects: z.array(PlanSideEffectSchema).default([]),
  commands: z.array(PlanCommandSchema).default([]),
  tasks: z.array(PlanTaskIntentSchema).default([]),
  hints: z.array(z.string()).default([]),
}

/** What a producer emits. `baseline` is absent: Guren stamps it, a model never does. */
export const PlanDraftSchema = z.strictObject(draftShape)

export const PlanBaselineSchema = z.strictObject({
  rev: z.string().min(1),
  contextHash: z.record(z.string(), z.string()),
})

export const PlanSchema = z.strictObject({ ...draftShape, baseline: PlanBaselineSchema })

export type PlanDraft = z.infer<typeof PlanDraftSchema>
export type Plan = z.infer<typeof PlanSchema>
export type PlanChange = z.infer<typeof ChangeSchema>
export type PlanModel = z.infer<typeof PlanModelSchema>
export type PlanColumn = z.infer<typeof PlanColumnSchema>
export type PlanValidator = z.infer<typeof PlanValidatorSchema>
export type PlanController = z.infer<typeof PlanControllerSchema>
export type PlanAction = z.infer<typeof PlanActionSchema>
export type PlanRoute = z.infer<typeof PlanRouteSchema>
export type PlanView = z.infer<typeof PlanViewSchema>
export type PlanResource = z.infer<typeof PlanResourceSchema>
export type PlanPolicy = z.infer<typeof PlanPolicySchema>
export type PlanSideEffect = z.infer<typeof PlanSideEffectSchema>
export type PlanCommand = z.infer<typeof PlanCommandSchema>
export type PlanTaskIntent = z.infer<typeof PlanTaskIntentSchema>
export type PlanAcceptance = z.infer<typeof AcceptanceSchema>
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>
export type PlanJsonValue = z.infer<typeof PlanJsonValueSchema>

/** The JSON Schema a producer is held to. Draft-07 is what structured outputs validate with. */
export function planDraftJsonSchema(): Record<string, unknown> {
  // `input`: a producer may omit a defaulted section. `.refine()` checks have no JSON Schema form and are enforced on parse only.
  return z.toJSONSchema(PlanDraftSchema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>
}

export type PlanElementSection =
  | 'models'
  | 'columns'
  | 'validators'
  | 'controllers'
  | 'actions'
  | 'routes'
  | 'views'
  | 'resources'
  | 'policies'
  | 'sideEffects'
  | 'commands'
  | 'tasks'
  | 'acceptance'
  | 'questions'

export interface PlanElementRef {
  id: string
  section: PlanElementSection
}

/**
 * Every id a plan declares, in document order. Ids share one namespace: a
 * revision addresses an element by id alone, so a route and a view may not
 * both be `comments`.
 */
export function listPlanElements(plan: PlanDraft): PlanElementRef[] {
  const refs: PlanElementRef[] = []
  const push = (section: PlanElementSection, items: ReadonlyArray<{ id: string }>): void => {
    for (const item of items) refs.push({ id: item.id, section })
  }

  push('questions', plan.questions)
  for (const model of plan.models) {
    refs.push({ id: model.id, section: 'models' })
    push('columns', model.columns)
  }
  push('validators', plan.validators)
  for (const controller of plan.controllers) {
    refs.push({ id: controller.id, section: 'controllers' })
    push('actions', controller.actions)
  }
  push('routes', plan.routes)
  push('views', plan.views)
  push('resources', plan.resources)
  push('policies', plan.policies)
  push('sideEffects', plan.sideEffects)
  push('commands', plan.commands)
  for (const task of plan.tasks) {
    refs.push({ id: task.id, section: 'tasks' })
    push('acceptance', task.acceptance)
  }
  return refs
}

export function findDuplicatePlanIds(plan: PlanDraft): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const { id } of listPlanElements(plan)) {
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return [...duplicates].sort()
}

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}
