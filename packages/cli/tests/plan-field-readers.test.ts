import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { loadPlanAppState, type PlanAppState } from '../src/plan/app-state'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { judgePlan, type PlanElementStatus, type PlanPropertyStatus } from '../src/plan/status'
import { createTempRoot, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

// One directory per application: see plan-status-command.test.ts.
const ROOT_PREFIX = 'guren-plan-field-readers-'
let ROOT: string
let STATE: PlanAppState

/** The workspace's own zod, linked in as an install would place it: the fixture never reaches npm. */
const WORKSPACE_ZOD = resolve(import.meta.dir, '../../../node_modules/zod')

const VALIDATORS = `import { z } from 'zod'
import { z as z3 } from 'zod/v3'
import * as zm from 'zod/mini'

export const MiniSchema = zm.looseObject({ a: zm.string() })

export const LegacySchema = z3.object({ body: z3.string() })

export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1).max(2000),
  rating: z.number().int().optional(),
  email: z.email(),
})

const base = { title: z.string().min(1) }
export const BuiltSchema = z.object(base).extend({ published: z.boolean().default(false) })

export const LazySchema = z.lazy(() => z.object({ body: z.string() }))

export const LoginSchema = z.object({
  remember: z
    .union([z.boolean(), z.string().transform((value: string) => value === 'on')])
    .optional()
    .transform((value): boolean => Boolean(value))
    .default(false),
})

export const NotASchema = { body: 'text' }

export const FormSchema = z.object({
  count: z.string().transform(Number),
  agreed: z.stringbool(),
  page: z.coerce.number().int(),
  size: z.preprocess((value) => Number(value), z.number().int()),
  filled: z.string().optional().transform((value) => value ?? 'x').pipe(z.string()),
  'a.b': z.preprocess((value) => String(value), z.string()),
  nothing: z.literal(null).nullable(),
  gone: z.undefined(),
  contact: z.string().min(1).pipe(z.email()),
})

export const TreeSchema = z.object({
  name: z.string(),
  get children() {
    return z.array(TreeSchema)
  },
})

export const OpaqueSchema = z.object({
  upload: z.file(),
  lazy: z.lazy(() => z.string()),
  maybe: z.lazy(() => z.string()).optional(),
})

export const ReshapedSchema = z.object({ amount: z.string(), label: z.string().max(20) }).transform((value) => ({ ...value, amount: Number(value.amount) }))

export const PresenceSchema = z.object({
  upload: z.file().optional(),
  page: z.string().default('1').pipe(z.coerce.number().int().min(1)),
  tab: z.string().catch('all').pipe(z.enum(['all', 'mine'])),
  nick: z.string().optional().refine((value) => value !== undefined),
  toString: z.file(),
})
export const RequiredSchema = PresenceSchema.required()
export const RefinedObjectSchema = z.object({ note: z.string().optional() }).superRefine(() => {})
export const RepipedSchema = z.looseObject({ a: z.string().optional() }).pipe(z.object({ a: z.string(), b: z.string().optional() }))

export const RefinedDefaultSchema = z.object({ a: z.string().default('').refine((value) => value !== '') })
export const RefineInPipeSchema = z.object({ a: z.string().optional().refine((value) => value !== undefined).transform((value) => value) })
export const IssueInTransformSchema = z.object({
  a: z.string().optional().transform((value, ctx) => {
    if (value === undefined) ctx.addIssue({ code: 'custom', message: 'required' })
    return value
  }),
})
export const NullishRefinedSchema = z.object({ a: z.string().nullish().refine((value) => value != null).transform((value) => value) })
export const ObjectIssueSchema = z.object({ a: z.string().optional() }).transform((value, ctx) => {
  if (!value.a) ctx.addIssue({ code: 'custom', message: 'required' })
  return value
})
export const PipedTransformBoundSchema = z.object({ a: z.string().max(3).transform((value) => value + 'xx').pipe(z.string()) })
export const CaughtObjectSchema = z.object({ a: z.string() }).catch({ a: 'x' })
export const ReshapedBoundSchema = z.object({ a: z.string().max(3) }).transform((value) => ({ a: value.a + 'xxxx' }))

export const VersionedSchema = z.object({
  filled: z.string().default('x'),
  primed: z.string().prefault('x'),
  count: z.coerce.number(),
  when: z.coerce.date(),
  at: z.date(),
  kept: z.string().optional(),
}).required()
export const CodecSchema = z.object({
  a: z.codec(z.string(), z.string().max(3), { decode: (value) => value.slice(0, 3), encode: (value) => value }),
})
export const OverwrittenSchema = z.object({ a: z.string().overwrite((value) => value.padEnd(5)).min(5), b: z.string().trim().min(1) })
export const ProtoSchema = z.object({ ['__proto__']: z.string() })

export const BoundsSchema = z.object({
  digits: z.string().max(3).transform(Number),
  trimmed: z.string().max(3).transform((value) => value.trim()),
  quantity: z.number().int().min(0).gt(0),
  note: z.string().max(500),
  title: z.string().max(2000),
})
`

const RESOURCE = (name: string, body: string): string => `import { Resource } from '@guren/core'

${body}

export class ${name}Resource extends Resource<Record<string, unknown>, ${name}ResourceData> {
  toArray(): ${name}ResourceData {
    return {} as ${name}ResourceData
  }
}
`

const FILES: Record<string, string> = {
  'src/app.ts': "import { createApp } from '@guren/core'\nimport { registerWebRoutes } from '../routes/web.js'\n\nexport default createApp({ routes: registerWebRoutes })\n",
  'routes/web.ts': "import type { Router } from '@guren/core'\n\nexport function registerWebRoutes(router: Router): void {\n  void router\n}\n",
  'app/Http/Validators/CommentValidator.ts': VALIDATORS,
  'app/Http/Resources/CommentResource.ts': RESOURCE('Comment', 'export interface CommentResourceData extends Record<string, unknown> {\n  id: number\n  body: string\n  author?: { name: string }\n}'),
  'app/Http/Resources/DraftResource.ts': RESOURCE('Draft', 'interface Base { id: number }\n\nexport interface DraftResourceData extends Base {\n  body: string\n}'),
  'app/Http/Resources/TaskResource.ts': RESOURCE('Task', "interface Base { id: number }\n\nexport interface TaskResourceData extends Record<string, unknown>, Base {\n  status: 'draft' | 'in progress'\n  rank: 1 | 2\n  big: 0x1Fn\n}"),
  'app/Http/Resources/TagResource.ts': RESOURCE('Tag', 'export interface TagResourceData {\n  [key: string]: unknown\n  name: string\n}'),
  'app/Http/Resources/LooseResource.ts': "import { Resource } from '@guren/core'\n\nexport class LooseResource extends Resource<Record<string, unknown>> {\n  toArray() {\n    return {}\n  }\n}\n",
  'bunfig.toml': '[install]\nauto = "disable"\n',
}

type Field = { name: string; type: string; required: boolean; rules: string[] }

function plan(sections: Record<string, unknown>): PlanDraft {
  return PlanDraftSchema.parse({ planVersion: 1, title: 'Fields', summary: 'Field readers.', locale: 'en', scope: { goals: [], nonGoals: [] }, ...sections })
}

const validator = (name: string, fields: Field[]): PlanDraft => plan({ validators: [{ id: 'val', change: { kind: 'add' }, name, fields }] })
const resource = (name: string, fields: Array<{ name: string; type: string }>): PlanDraft =>
  plan({ models: [{ id: 'm', change: { kind: 'existing' }, name: 'Comment', table: 'comments', columns: [], relationships: [], fillable: [] }], resources: [{ id: 'res', change: { kind: 'add' }, name, model: 'm', fields }] })

/** `judgePlan()` is pure, so one reading of the fixture serves every test. */
function judged(document: PlanDraft, id: string): PlanElementStatus {
  const element = judgePlan(document, STATE).elements.find((candidate) => candidate.id === id)
  if (!element) throw new Error(`no element ${id}`)
  return element
}

function verdicts(element: PlanElementStatus): Record<string, PlanPropertyStatus['verdict']> {
  return Object.fromEntries(element.properties.map((property) => [property.property, property.verdict]))
}

beforeAll(async () => {
  ROOT = await createTempRoot(ROOT_PREFIX)
  const dir = join(ROOT, 'app')
  await writeWorkspaceFiles(dir, FILES)
  await linkWorkspaceCore(dir)
  await mkdir(join(dir, 'node_modules'), { recursive: true })
  await symlink(WORKSPACE_ZOD, join(dir, 'node_modules', 'zod'), 'dir')
  STATE = await loadPlanAppState(dir, { detail: true })
})

describe('plan:status validator fields', () => {
  test('should match every field a literal object schema declares as planned', () => {
    const element = judged(validator('CommentPayloadSchema', [
      { name: 'body', type: 'text', required: true, rules: ['min 1', 'max 2000'] },
      { name: 'rating', type: 'integer', required: false, rules: [] },
      { name: 'email', type: 'string', required: true, rules: ['email'] },
    ]), 'val')

    expect(verdicts(element)).toEqual({
      'field body': 'match',
      'field body type': 'match',
      'field body required': 'match',
      'field body rule min 1': 'match',
      'field body rule max 2000': 'match',
      'field rating': 'match',
      'field rating type': 'match',
      'field rating required': 'match',
      'field email': 'match',
      'field email type': 'match',
      'field email required': 'match',
      'field email rule email': 'match',
    })
  })

  test('should call a planned field the schema does not declare a differ, and drift the validator', () => {
    const element = judged(validator('CommentPayloadSchema', [
      { name: 'body', type: 'text', required: true, rules: [] },
      { name: 'postId', type: 'integer', required: true, rules: [] },
    ]), 'val')

    expect(element.properties).toContainEqual({ property: 'field postId', verdict: 'differ', planned: 'declared', actual: 'not declared' })
    expect(element.state).toBe('drifted')
  })

  test('should call a tighter bound, a type of another family and a required field made optional a differ', () => {
    const element = judged(validator('CommentPayloadSchema', [
      { name: 'body', type: 'text', required: true, rules: ['max 3000'] },
      { name: 'email', type: 'boolean', required: true, rules: [] },
      { name: 'rating', type: 'integer', required: true, rules: [] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({
      'field email type': 'differ',
      'field body rule max 3000': 'differ',
      'field rating required': 'differ',
    })
  })

  test('should read a schema built by extend() and a helper object, as the runtime holds it', () => {
    const element = judged(validator('BuiltSchema', [
      { name: 'title', type: 'string', required: true, rules: ['min 1'] },
      { name: 'published', type: 'boolean', required: false, rules: [] },
    ]), 'val')

    expect(Object.values(verdicts(element)).every((verdict) => verdict === 'match')).toBe(true)
  })

  test('should leave a schema this cannot reach an object of unknown, never a match or a differ', () => {
    for (const name of ['LazySchema', 'NotASchema']) {
      const element = judged(validator(name, [{ name: 'body', type: 'text', required: true, rules: ['max 10'] }]), 'val')
      expect(Object.values(verdicts(element))).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    }
  })

  test('should say a zod v3 schema is refused rather than not a schema', () => {
    const element = judged(validator('LegacySchema', [{ name: 'body', type: 'text', required: true, rules: [] }]), 'val')

    expect(element.properties[0]).toMatchObject({ verdict: 'unknown', reason: expect.stringContaining('zod v3') })
  })

  test('should leave a union behind a transform unknown rather than a differ', () => {
    const element = judged(validator('LoginSchema', [{ name: 'remember', type: 'boolean', required: false, rules: [] }]), 'val')

    expect(verdicts(element)).toEqual({ 'field remember': 'match', 'field remember type': 'unknown', 'field remember required': 'unknown' })
  })

  test('should leave free-form rule text unknown', () => {
    const element = judged(validator('CommentPayloadSchema', [{ name: 'body', type: 'text', required: true, rules: ['must not be spam'] }]), 'val')

    expect(verdicts(element)['field body rule must not be spam']).toBe('unknown')
  })

  test('should judge the validated value: a coerced or stringbool field matches, a transform or preprocess is unknown, never a differ', () => {
    const element = judged(validator('FormSchema', [
      { name: 'count', type: 'integer', required: true, rules: [] },
      { name: 'agreed', type: 'boolean', required: true, rules: [] },
      { name: 'page', type: 'integer', required: true, rules: [] },
      { name: 'size', type: 'integer', required: true, rules: [] },
      { name: 'contact', type: 'string', required: true, rules: ['min 1', 'email'] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({
      'field count type': 'unknown',
      'field agreed type': 'match',
      'field page type': 'match',
      'field size type': 'unknown',
      'field contact type': 'match',
      'field contact required': 'unknown',
      'field contact rule min 1': 'unknown',
      'field contact rule email': 'unknown',
      'field page required': 'unknown',
    })
  })

  test('should not differ where the walker approximates: a pipe that fills a missing value, a dotted key, a null literal', () => {
    const element = judged(validator('FormSchema', [
      { name: 'filled', type: 'string', required: false, rules: [] },
      { name: 'a.b', type: 'string', required: true, rules: [] },
      { name: 'nothing', type: 'string', required: false, rules: [] },
      { name: 'gone', type: 'string', required: false, rules: [] },
    ]), 'val')

    expect(Object.values(verdicts(element))).not.toContain('differ')
    expect(verdicts(element)).toMatchObject({ 'field filled required': 'unknown', 'field a.b': 'match', 'field gone': 'match' })
  })

  test('should read presence off the outermost wrapper, and leave a fill or a refinement unknown rather than differ', () => {
    const fields: Field[] = [
      { name: 'upload', type: 'json', required: false, rules: [] },
      { name: 'page', type: 'integer', required: false, rules: [] },
      { name: 'tab', type: 'string', required: false, rules: [] },
      { name: 'nick', type: 'string', required: true, rules: [] },
    ]
    expect(verdicts(judged(validator('PresenceSchema', fields), 'val'))).toMatchObject({
      'field upload required': 'unknown',
      'field page required': 'unknown',
      'field tab required': 'unknown',
      'field nick required': 'unknown',
    })
    const required = verdicts(judged(validator('RequiredSchema', fields.map((field) => ({ ...field, required: true }))), 'val'))
    expect(Object.entries(required).filter(([, verdict]) => verdict === 'differ')).toEqual([])
    expect(required['field upload required']).toBe('unknown')
    expect(verdicts(judged(validator('PresenceSchema', [{ name: 'toString', type: 'json', required: true, rules: [] }]), 'val'))['field toString required']).toBe('unknown')
  })

  test('should leave a key an object refinement may require unknown', () => {
    const element = judged(validator('RefinedObjectSchema', [{ name: 'note', type: 'string', required: true, rules: [] }]), 'val')

    expect(verdicts(element)['field note required']).toBe('unknown')
  })

  test('should leave presence and keys unknown when the object pipes into a second one', () => {
    const element = judged(validator('RepipedSchema', [{ name: 'a', type: 'string', required: true, rules: [] }, { name: 'b', type: 'string', required: false, rules: [] }]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field a required': 'unknown', 'field b': 'unknown' })
  })

  test('should read no presence that changed across zod 4 versions: nonoptional over a fill, a null-accepting coercion', () => {
    const element = judged(validator('VersionedSchema', [
      { name: 'filled', type: 'string', required: false, rules: [] },
      { name: 'primed', type: 'string', required: false, rules: [] },
      { name: 'count', type: 'number', required: false, rules: [] },
      { name: 'when', type: 'datetime', required: false, rules: [] },
      { name: 'kept', type: 'string', required: true, rules: [] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({
      'field filled required': 'unknown',
      'field primed required': 'unknown',
      'field count required': 'unknown',
      'field when required': 'unknown',
      'field when type': 'match',
      'field kept required': 'match',
    })
  })

  test('should read a Date as a datetime and never as a string', () => {
    const verdictOf = (type: string): string => verdicts(judged(validator('VersionedSchema', [{ name: 'at', type, required: true, rules: [] }]), 'val'))['field at type']!

    expect([verdictOf('datetime'), verdictOf('string'), verdictOf('date')]).toEqual(['match', 'unknown', 'unknown'])
  })

  test('should read no rule of a codec, whose decode runs between its stages', () => {
    const element = judged(validator('CodecSchema', [{ name: 'a', type: 'string', required: true, rules: ['max 10'] }]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field a type': 'match', 'field a required': 'unknown', 'field a rule max 10': 'unknown' })
  })

  test('should read no rule past a custom overwrite, and read one past zod’s own trim', () => {
    const element = judged(validator('OverwrittenSchema', [
      { name: 'a', type: 'string', required: true, rules: ['min 1'] },
      { name: 'b', type: 'string', required: true, rules: ['min 1'] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field a rule min 1': 'unknown', 'field b rule min 1': 'match' })
  })

  test('should leave a zod/mini schema unread, whose checks and catchall carry no _def', () => {
    const element = judged(validator('MiniSchema', [{ name: 'b', type: 'string', required: true, rules: [] }]), 'val')

    expect(element.properties[0]).toMatchObject({ verdict: 'unknown', reason: expect.stringContaining('zod/mini') })
  })

  test('should find a __proto__ key the object declares', () => {
    const element = judged(validator('ProtoSchema', [{ name: '__proto__', type: 'string', required: true, rules: [] }]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field __proto__': 'match', 'field __proto__ type': 'match' })
  })

  test('should read a recursive schema without walking into it', () => {
    const element = judged(validator('TreeSchema', [
      { name: 'name', type: 'string', required: true, rules: [] },
      { name: 'children', type: 'json', required: true, rules: [] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field name type': 'match', 'field children': 'match', 'field children type': 'unknown' })
  })

  test('should leave a file or lazy field’s presence unknown, as nodes outside the allowlist', () => {
    const element = judged(validator('OpaqueSchema', [
      { name: 'upload', type: 'json', required: true, rules: [] },
      { name: 'lazy', type: 'string', required: true, rules: [] },
      { name: 'maybe', type: 'string', required: false, rules: [] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field upload required': 'unknown', 'field lazy required': 'unknown', 'field maybe required': 'unknown' })
  })

  test('should leave everything but a key’s existence unknown under a transform on the object itself', () => {
    const element = judged(validator('ReshapedSchema', [{ name: 'amount', type: 'integer', required: true, rules: [] }, { name: 'label', type: 'string', required: true, rules: ['max 20'] }]), 'val')

    expect(verdicts(element)).toEqual({
      'field amount': 'match',
      'field amount type': 'unknown',
      'field amount required': 'unknown',
      'field label': 'match',
      'field label type': 'unknown',
      'field label required': 'unknown',
      'field label rule max 20': 'unknown',
    })
  })

  test('should never differ on a node outside the allowlist, wherever it sits', () => {
    const cases: Array<[string, Field]> = [
      ['RefinedDefaultSchema', { name: 'a', type: 'string', required: false, rules: [] }],
      ['RefineInPipeSchema', { name: 'a', type: 'string', required: true, rules: [] }],
      ['IssueInTransformSchema', { name: 'a', type: 'string', required: true, rules: [] }],
      ['NullishRefinedSchema', { name: 'a', type: 'string', required: true, rules: [] }],
      ['ObjectIssueSchema', { name: 'a', type: 'string', required: true, rules: [] }],
      ['PipedTransformBoundSchema', { name: 'a', type: 'string', required: true, rules: ['max 5'] }],
      ['CaughtObjectSchema', { name: 'a', type: 'string', required: false, rules: [] }],
      ['ReshapedBoundSchema', { name: 'a', type: 'string', required: true, rules: ['max 7'] }],
    ]
    for (const [schema, field] of cases) {
      const element = judged(validator(schema, [field]), 'val')
      expect([schema, Object.values(verdicts(element)).includes('differ')]).toEqual([schema, false])
      expect(verdicts(element)[`field ${field.name}`]).toBe('match')
    }
  })

  test('should read a bound only in the planned type’s unit, never a transformed field’s input length', () => {
    const element = judged(validator('BoundsSchema', [
      { name: 'digits', type: 'integer', required: true, rules: ['max 500'] },
      { name: 'trimmed', type: 'string', required: true, rules: ['max 5'] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field digits rule max 500': 'unknown', 'field trimmed rule max 5': 'unknown' })
  })

  test('should call only a bound tighter than planned a differ, reading an integer’s exclusive bound as the next integer', () => {
    const element = judged(validator('BoundsSchema', [
      { name: 'quantity', type: 'integer', required: true, rules: ['min 1'] },
      { name: 'note', type: 'text', required: true, rules: ['max 2000'] },
      { name: 'title', type: 'text', required: true, rules: ['max 500'] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({
      'field quantity rule min 1': 'match',
      'field note rule max 2000': 'differ',
      'field title rule max 500': 'unknown',
    })
  })
})

describe('plan:status resource fields', () => {
  test('should match every field the payload type declares, and read an added resource present', () => {
    const element = judged(resource('CommentResource', [{ name: 'id', type: 'number' }, { name: 'body', type: 'string' }]), 'res')

    expect(verdicts(element)).toEqual({ 'field id': 'match', 'field id type': 'match', 'field body': 'match', 'field body type': 'match' })
    expect(element.state).toBe('present')
  })

  test('should call a missing field and a primitive of another kind a differ', () => {
    const element = judged(resource('CommentResource', [{ name: 'id', type: 'string' }, { name: 'postId', type: 'number' }]), 'res')

    expect(verdicts(element)).toMatchObject({ 'field id type': 'differ', 'field postId': 'differ' })
    expect(element.state).toBe('drifted')
  })

  test('should compare an object type as text only, and never differ on it', () => {
    const element = judged(resource('CommentResource', [{ name: 'author', type: 'Author' }]), 'res')

    expect(verdicts(element)).toEqual({ 'field author': 'match', 'field author type': 'unknown' })
  })

  test('should leave an absent field unknown when the payload extends a type that may declare it', () => {
    const element = judged(resource('DraftResource', [{ name: 'id', type: 'number' }, { name: 'body', type: 'string' }]), 'res')

    expect(verdicts(element)).toEqual({ 'field id': 'unknown', 'field id type': 'unknown', 'field body': 'match', 'field body type': 'match' })
  })

  test('should leave every field unknown when codegen reads no payload type, saying why', () => {
    const element = judged(resource('LooseResource', [{ name: 'id', type: 'number' }]), 'res')

    expect(Object.values(verdicts(element))).toEqual(['unknown', 'unknown'])
    expect(element.properties[0]!.reason).toContain('has no toArray() return type')
    expect(element.state).toBe('unjudged')
  })

  test('should read a heritage list that names more than a Record as open', () => {
    const element = judged(resource('TaskResource', [{ name: 'id', type: 'number' }]), 'res')

    expect(verdicts(element)).toEqual({ 'field id': 'unknown', 'field id type': 'unknown' })
  })

  test('should compare literal unions by value, never by quoting or spacing, and differ only from a keyword they are not', () => {
    const verdictOf = (name: string, type: string): string => verdicts(judged(resource('TaskResource', [{ name, type }]), 'res'))[`field ${name} type`]!

    expect(verdictOf('status', '"draft" | "in progress"')).toBe('match')
    expect(verdictOf('status', "'draft' | 'inprogress'")).toBe('unknown')
    expect(verdictOf('status', 'string')).toBe('unknown')
    expect(verdictOf('status', 'number')).toBe('differ')
    expect(verdictOf('rank', 'number')).toBe('unknown')
    expect(verdictOf('rank', 'bigint')).toBe('differ')
    expect(verdictOf('big', 'bigint')).toBe('unknown')
  })

  test('should keep an index signature from opening the key set, as a Record heritage does', () => {
    const element = judged(resource('TagResource', [{ name: 'name', type: 'string' }, { name: 'slug', type: 'string' }]), 'res')

    expect(verdicts(element)).toMatchObject({ 'field name': 'match', 'field slug': 'differ' })
  })
})
