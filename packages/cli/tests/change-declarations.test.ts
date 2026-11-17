import { describe, expect, test } from 'bun:test'

import { applyPlanDeclarations, declaredExports, declaredTable, planDeclaredFiles, type DeclarationSubject, type OpenPlan } from '../src/change/declarations'
import type { ChangeFact } from '../src/change/lane'
import { parseSourceFile } from '../src/parse-cache'
import { PlanSchema, type PlanDraft } from '../src/plan/schema'
import type { SchemaColumn, SchemaTable } from '../src/schema-parser'
import { loadApprovedCommentsPlan } from './plan-fixture'

const PLAN_FILE = 'docs/plans/comments/plan.json'

function commentsPlan(edit?: (document: Record<string, any>) => void): PlanDraft {
  const document = loadApprovedCommentsPlan() as Record<string, any>
  edit?.(document)
  return PlanSchema.parse(document)
}

const column = (name: string, overrides: Partial<SchemaColumn> = {}): SchemaColumn => ({ name, notNull: true, primaryKey: false, unique: false, ...overrides })

function commentsTable(overrides: Partial<SchemaTable> = {}): SchemaTable {
  return {
    identifier: 'comments',
    tableName: 'comments',
    module: null,
    dialect: 'pg',
    constraints: [],
    columns: [
      column('id', { primaryKey: true, notNull: false }),
      column('body'),
      column('postId', { references: { table: 'posts', column: 'id' } }),
      column('createdAt'),
    ],
    ...overrides,
  }
}

const exportsOf = (source: string, file = 'a.ts'): string[] | undefined => declaredExports(parseSourceFile(source, file)!)

describe('declaredExports', () => {
  test('should list classes, functions, constants and local specifiers, and no type', () => {
    expect(exportsOf('export class A {}\nexport function b() {}\nexport const c = 1\nconst d = 2\nexport { d as e }\nexport type F = 1\nexport interface G {}\n')).toEqual(['A', 'b', 'c', 'e'])
  })

  test('should not count a name re-exported from another file', () => {
    expect(exportsOf("export { A } from './a'\nexport const b = 1\n")).toEqual(['b'])
  })

  test('should name a default export by its declaration as well', () => {
    expect(exportsOf('export default class Provider {}\n')).toEqual(['default', 'Provider'])
  })

  test('should give nothing for a star export, which hides its names', () => {
    expect(exportsOf("export * from './a'\nexport const b = 1\n")).toBeUndefined()
  })
})

describe('planDeclaredFiles', () => {
  test('should own each file the scaffold writes for added elements, routes files excepted', () => {
    const files = planDeclaredFiles(commentsPlan())

    expect([...files.keys()].sort()).toEqual([
      'app/Http/Controllers/CommentController.ts',
      'app/Http/Resources/CommentResource.ts',
      'app/Http/Validators/CommentValidator.ts',
      'app/Models/Comment.ts',
      'app/Policies/CommentPolicy.ts',
      'app/Providers/CommentPolicyProvider.ts',
    ])
    expect(files.get('app/Models/Comment.ts')).toEqual({ elements: ['model.comment'], exports: ['Comment'] })
    expect(files.get('app/Providers/CommentPolicyProvider.ts')?.exports).toEqual(['default', 'CommentPolicyProvider'])
  })

  test('should own nothing of an element the plan does not add', () => {
    const files = planDeclaredFiles(commentsPlan((plan) => {
      plan.resources[0].change = { kind: 'existing' }
    }))

    expect(files.has('app/Http/Resources/CommentResource.ts')).toBe(false)
  })
})

describe('declaredTable', () => {
  test('should match the added model whose table it is, with exactly its planned columns', () => {
    expect(declaredTable(commentsPlan(), commentsTable())).toBe('model.comment')
  })

  test.each<[string, Partial<SchemaTable>]>([
    ['another SQL name', { tableName: 'notes' }],
    ['another module', { module: 'billing' }],
    ['an unplanned column', { columns: [...commentsTable().columns, column('rating')] }],
    ['a planned column missing', { columns: commentsTable().columns.slice(0, 3) }],
    ['a column the plan makes not null declared nullable', { columns: commentsTable().columns.map((entry) => (entry.name === 'body' ? { ...entry, notNull: false } : entry)) }],
    ['a unique the plan does not state', { columns: commentsTable().columns.map((entry) => (entry.name === 'body' ? { ...entry, unique: true } : entry)) }],
    ['a foreign key the plan does not state', { columns: commentsTable().columns.map((entry) => (entry.name === 'body' ? { ...entry, references: { table: 'users', column: 'id' } } : entry)) }],
    ['a foreign key the plan states left out', { columns: commentsTable().columns.map((entry) => (entry.name === 'postId' ? { ...entry, references: undefined } : entry)) }],
    ['another primary key', { columns: commentsTable().columns.map((entry) => (entry.name === 'body' ? { ...entry, primaryKey: true } : entry)) }],
    ['columns the reader cannot see', { opaqueColumns: true }],
    ['a column whose options it cannot see', { columns: commentsTable().columns.map((entry) => (entry.name === 'body' ? { ...entry, opaqueOptions: true as const } : entry)) }],
    ['a column built by a helper', { columns: commentsTable().columns.map((entry) => (entry.name === 'body' ? { ...entry, opaqueBuilder: true as const } : entry)) }],
    ['no SQL name', { tableName: undefined }],
  ])('should not match a table with %s', (_why, overrides) => {
    expect(declaredTable(commentsPlan(), commentsTable(overrides))).toBeUndefined()
  })

  test('should not match a model the plan alters or keeps', () => {
    expect(declaredTable(commentsPlan((plan) => {
      plan.models[1].change = { kind: 'alter' }
    }), commentsTable())).toBeUndefined()
  })

  test('should not match a column the plan does not add', () => {
    expect(declaredTable(commentsPlan((plan) => {
      plan.models[1].columns[1].change = { kind: 'existing' }
    }), commentsTable())).toBeUndefined()
  })
})

describe('applyPlanDeclarations', () => {
  const MODEL = `import { defineModel } from '@guren/core'
import { comments } from '@/db/schema'

export class Comment extends defineModel(comments) {}
`
  const fileFact = (path: string): ChangeFact => ({ code: 'file-added', lane: 'medium', files: [path], evidence: 'path', message: `${path} added` })

  async function judge(plans: OpenPlan[], head: Record<string, string>, fact: ChangeFact, subject: DeclarationSubject): Promise<ChangeFact> {
    const [result] = await applyPlanDeclarations([fact], new Map([[fact, subject]]), plans, async (path) => head[path] ?? null)
    return result!
  }

  test('should lower an added file the plan owns and name the declaration', async () => {
    const fact = fileFact('app/Models/Comment.ts')
    const result = await judge([{ file: PLAN_FILE, plan: commentsPlan() }], { 'app/Models/Comment.ts': MODEL }, fact, { kind: 'file', path: 'app/Models/Comment.ts' })

    expect(result).toEqual({ ...fact, lane: 'low', declaredBy: `${PLAN_FILE}#model.comment` })
  })

  test('should keep a file at the planned path that exports another name', async () => {
    const fact = fileFact('app/Models/Comment.ts')
    const result = await judge([{ file: PLAN_FILE, plan: commentsPlan() }], { 'app/Models/Comment.ts': MODEL.replace('class Comment', 'class Note') }, fact, { kind: 'file', path: 'app/Models/Comment.ts' })

    expect(result).toBe(fact)
  })

  test('should keep a file that does not parse', async () => {
    const fact = fileFact('app/Models/Comment.ts')
    const result = await judge([{ file: PLAN_FILE, plan: commentsPlan() }], { 'app/Models/Comment.ts': 'export class Comment {' }, fact, { kind: 'file', path: 'app/Models/Comment.ts' })

    expect(result).toBe(fact)
  })

  test('should keep a file no plan names', async () => {
    const fact = fileFact('app/Models/Note.ts')
    const result = await judge([{ file: PLAN_FILE, plan: commentsPlan() }], { 'app/Models/Note.ts': 'export class Note {}\n' }, fact, { kind: 'file', path: 'app/Models/Note.ts' })

    expect(result).toBe(fact)
  })

  test('should keep what two open plans both claim', async () => {
    const fact = fileFact('app/Models/Comment.ts')
    const plans = [{ file: PLAN_FILE, plan: commentsPlan() }, { file: 'docs/plans/other/plan.json', plan: commentsPlan() }]
    const result = await judge(plans, { 'app/Models/Comment.ts': MODEL }, fact, { kind: 'file', path: 'app/Models/Comment.ts' })

    expect(result).toBe(fact)
  })

  test('should lower an added table to low and keep a fact with no subject', async () => {
    const table: ChangeFact = { code: 'schema-changed', lane: 'medium', target: 'comments', files: ['db/schema.ts'], evidence: 'static', message: 'table comments added (4 columns)' }
    const other: ChangeFact = { code: 'source-edited', lane: 'medium', files: ['db/schema.ts'], evidence: 'static', message: 'code beside the tables changed' }
    const result = await applyPlanDeclarations([table, other], new Map([[table, { kind: 'table', table: commentsTable() }]]), [{ file: PLAN_FILE, plan: commentsPlan() }], async () => null)

    expect(result).toEqual([{ ...table, lane: 'low', declaredBy: `${PLAN_FILE}#model.comment` }, other])
  })
})
