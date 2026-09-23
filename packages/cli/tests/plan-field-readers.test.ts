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

export const BoundsSchema = z.object({
  digits: z.string().max(3).transform(Number),
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
  'app/Http/Resources/TaskResource.ts': RESOURCE('Task', "interface Base { id: number }\n\nexport interface TaskResourceData extends Record<string, unknown>, Base {\n  status: 'draft' | 'in progress'\n  rank: 1 | 2\n}"),
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

    expect(verdicts(element)).toEqual({ 'field remember': 'match', 'field remember type': 'unknown', 'field remember required': 'match' })
  })

  test('should leave free-form rule text unknown', () => {
    const element = judged(validator('CommentPayloadSchema', [{ name: 'body', type: 'text', required: true, rules: ['must not be spam'] }]), 'val')

    expect(verdicts(element)['field body rule must not be spam']).toBe('unknown')
  })

  test('should judge the validated value: a coerced or stringbool field matches, a transform is unknown, never a differ', () => {
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
      'field size type': 'match',
      'field contact type': 'match',
      'field contact required': 'match',
      'field contact rule min 1': 'match',
      'field contact rule email': 'match',
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
    expect(verdicts(element)).toMatchObject({ 'field filled required': 'unknown', 'field a.b type': 'match', 'field gone': 'match' })
  })

  test('should leave a recursive schema unread rather than fail the command', () => {
    const element = judged(validator('TreeSchema', [{ name: 'name', type: 'string', required: true, rules: [] }]), 'val')

    expect(element.properties[0]).toMatchObject({ verdict: 'unknown', reason: expect.stringContaining('could not be walked') })
  })

  test('should not read a key the walker drops unrendered as omissible', () => {
    const element = judged(validator('OpaqueSchema', [
      { name: 'upload', type: 'json', required: true, rules: [] },
      { name: 'lazy', type: 'string', required: true, rules: [] },
      { name: 'maybe', type: 'string', required: false, rules: [] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field upload required': 'unknown', 'field lazy required': 'unknown', 'field maybe required': 'match' })
  })

  test('should leave every type unknown under a transform on the object itself, and still read the checks that ran before it', () => {
    const element = judged(validator('ReshapedSchema', [{ name: 'amount', type: 'integer', required: true, rules: [] }, { name: 'label', type: 'string', required: true, rules: ['max 20'] }]), 'val')

    expect(verdicts(element)).toMatchObject({ 'field amount type': 'unknown', 'field label type': 'unknown', 'field label rule max 20': 'match' })
  })

  test('should read a bound only in the planned type’s unit, never a transformed field’s input length', () => {
    const element = judged(validator('BoundsSchema', [{ name: 'digits', type: 'integer', required: true, rules: ['max 500'] }]), 'val')

    expect(verdicts(element)['field digits rule max 500']).toBe('unknown')
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
  })

  test('should keep an index signature from opening the key set, as a Record heritage does', () => {
    const element = judged(resource('TagResource', [{ name: 'name', type: 'string' }, { name: 'slug', type: 'string' }]), 'res')

    expect(verdicts(element)).toMatchObject({ 'field name': 'match', 'field slug': 'differ' })
  })
})
