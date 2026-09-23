import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { loadPlanAppState } from '../src/plan/app-state'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { judgePlan, type PlanElementStatus, type PlanPropertyStatus } from '../src/plan/status'
import { createTempRoot, linkWorkspaceCore, writeWorkspaceFiles } from './helpers'

// One directory per application: see plan-status-command.test.ts.
const ROOT_PREFIX = 'guren-plan-field-readers-'
let ROOT: string

/** The workspace's own zod, linked in as an install would place it: the fixture never reaches npm. */
const WORKSPACE_ZOD = resolve(import.meta.dir, '../../../node_modules/zod')

const VALIDATORS = `import { z } from 'zod'

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

async function judged(document: PlanDraft, id: string): Promise<PlanElementStatus> {
  const state = await loadPlanAppState(join(ROOT, 'app'), { detail: true })
  const element = judgePlan(document, state).elements.find((candidate) => candidate.id === id)
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
})

describe('plan:status validator fields', () => {
  test('should match every field a literal object schema declares as planned', async () => {
    const element = await judged(validator('CommentPayloadSchema', [
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

  test('should call a planned field the schema does not declare a differ, and drift the validator', async () => {
    const element = await judged(validator('CommentPayloadSchema', [
      { name: 'body', type: 'text', required: true, rules: [] },
      { name: 'postId', type: 'integer', required: true, rules: [] },
    ]), 'val')

    expect(element.properties).toContainEqual({ property: 'field postId', verdict: 'differ', planned: 'declared', actual: 'not declared' })
    expect(element.state).toBe('drifted')
  })

  test('should call a changed bound, a type of another family and a required field made optional a differ', async () => {
    const element = await judged(validator('CommentPayloadSchema', [
      { name: 'body', type: 'boolean', required: true, rules: ['max 500'] },
      { name: 'rating', type: 'integer', required: true, rules: [] },
    ]), 'val')

    expect(verdicts(element)).toMatchObject({
      'field body type': 'differ',
      'field body rule max 500': 'differ',
      'field rating required': 'differ',
    })
  })

  test('should read a schema built by extend() and a helper object, as the runtime holds it', async () => {
    const element = await judged(validator('BuiltSchema', [
      { name: 'title', type: 'string', required: true, rules: ['min 1'] },
      { name: 'published', type: 'boolean', required: false, rules: [] },
    ]), 'val')

    expect(Object.values(verdicts(element)).every((verdict) => verdict === 'match')).toBe(true)
  })

  test('should leave a schema this cannot reach an object of unknown, never a match or a differ', async () => {
    for (const name of ['LazySchema', 'NotASchema']) {
      const element = await judged(validator(name, [{ name: 'body', type: 'text', required: true, rules: ['max 10'] }]), 'val')
      expect(Object.values(verdicts(element))).toEqual(['unknown', 'unknown', 'unknown', 'unknown'])
    }
  })

  test('should leave a union behind a transform unknown rather than a differ', async () => {
    const element = await judged(validator('LoginSchema', [{ name: 'remember', type: 'boolean', required: false, rules: [] }]), 'val')

    expect(verdicts(element)).toEqual({ 'field remember': 'match', 'field remember type': 'unknown', 'field remember required': 'match' })
  })

  test('should leave free-form rule text unknown', async () => {
    const element = await judged(validator('CommentPayloadSchema', [{ name: 'body', type: 'text', required: true, rules: ['must not be spam'] }]), 'val')

    expect(verdicts(element)['field body rule must not be spam']).toBe('unknown')
  })
})

describe('plan:status resource fields', () => {
  test('should match every field the payload type declares, and read an added resource present', async () => {
    const element = await judged(resource('CommentResource', [{ name: 'id', type: 'number' }, { name: 'body', type: 'string' }]), 'res')

    expect(verdicts(element)).toEqual({ 'field id': 'match', 'field id type': 'match', 'field body': 'match', 'field body type': 'match' })
    expect(element.state).toBe('present')
  })

  test('should call a missing field and a primitive of another kind a differ', async () => {
    const element = await judged(resource('CommentResource', [{ name: 'id', type: 'string' }, { name: 'postId', type: 'number' }]), 'res')

    expect(verdicts(element)).toMatchObject({ 'field id type': 'differ', 'field postId': 'differ' })
    expect(element.state).toBe('drifted')
  })

  test('should compare an object type as text only, and never differ on it', async () => {
    const element = await judged(resource('CommentResource', [{ name: 'author', type: 'Author' }]), 'res')

    expect(verdicts(element)).toEqual({ 'field author': 'match', 'field author type': 'unknown' })
  })

  test('should leave an absent field unknown when the payload extends a type that may declare it', async () => {
    const element = await judged(resource('DraftResource', [{ name: 'id', type: 'number' }, { name: 'body', type: 'string' }]), 'res')

    expect(verdicts(element)).toEqual({ 'field id': 'unknown', 'field id type': 'unknown', 'field body': 'match', 'field body type': 'match' })
  })

  test('should leave every field unknown when codegen reads no payload type', async () => {
    const element = await judged(resource('LooseResource', [{ name: 'id', type: 'number' }]), 'res')

    expect(Object.values(verdicts(element))).toEqual(['unknown', 'unknown'])
    expect(element.state).toBe('unjudged')
  })
})
