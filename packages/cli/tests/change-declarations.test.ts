import { describe, expect, test } from 'bun:test'

import { applyPlanDeclarations, declaredExports, declaredTable, planDeclaredFiles, type DeclarationSubject, type OpenPlan } from '../src/change/declarations'
import type { ChangeFact } from '../src/change/lane'
import { parseSourceFile } from '../src/parse-cache'
import { PlanSchema, type PlanDraft } from '../src/plan/schema'
import { parseSchemaSource } from '../src/schema-parser'
import { loadApprovedCommentsPlan } from './plan-fixture'

const PLAN_FILE = 'docs/plans/comments/plan.json'

function commentsPlan(edit?: (document: Record<string, any>) => void): PlanDraft {
  const document = loadApprovedCommentsPlan() as Record<string, any>
  edit?.(document)
  return PlanSchema.parse(document)
}

const exportsOf = (source: string, file = 'a.ts'): string[] | undefined => declaredExports(parseSourceFile(source, file)!)

/** The table `plan:scaffold` writes for the fixture's comments model into a pg schema holding `posts`. */
const COMMENTS = `export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('comments_post_id_index').on(table.postId),
])
`

const schemaWith = (comments: string): string => `import { index, integer, pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
})

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
})

${comments}`

function tableSubject(text: string, identifier = 'comments'): Extract<DeclarationSubject, { kind: 'table' }> {
  const tables = parseSchemaSource(text, 'db/schema.ts', null)!
  return { kind: 'table', table: tables.find((table) => table.identifier === identifier)!, file: 'db/schema.ts', tables }
}

const tableOf = (comments: string, plan = commentsPlan()): string | undefined => {
  const text = schemaWith(comments)
  return declaredTable(plan, tableSubject(text), text)
}

describe('declaredExports', () => {
  test('should list classes, functions, constants and local specifiers, and no type', () => {
    expect(exportsOf('export class A {}\nexport function b() {}\nexport const c = 1\nconst d = 2\nexport { d as e }\nexport type F = 1\nexport interface G {}\n')).toEqual(['A', 'b', 'c', 'e'])
  })

  test('should name a default export by its declaration as well', () => {
    expect(exportsOf('export default class Provider {}\n')).toEqual(['default', 'Provider'])
  })

  test('should not count a name re-exported from another file, whether through `from` or an import', () => {
    expect(exportsOf("export { A } from './a'\nimport { B } from './b'\nimport type { C } from './c'\nexport { B, C }\nexport const d = 1\n")).toEqual(['d'])
  })

  test('should not count an ambient declaration', () => {
    expect(exportsOf('export declare class A {}\nexport declare const b: number\n')).toEqual([])
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
    expect(files.get('app/Models/Comment.ts')).toMatchObject({ elements: ['model.comment'], exports: ['Comment'], check: { kind: 'exports' } })
    expect(files.get('app/Providers/CommentPolicyProvider.ts')).toMatchObject({ exports: ['default', 'CommentPolicyProvider'], check: { kind: 'whole' } })
    expect(files.get('app/Policies/CommentPolicy.ts')?.check.kind).toBe('policy')
    expect(files.get('app/Http/Controllers/CommentController.ts')?.check.kind).toBe('controller')
  })

  test('should own nothing of an element the plan does not add', () => {
    const files = planDeclaredFiles(commentsPlan((plan) => {
      plan.resources[0].change = { kind: 'existing' }
    }))

    expect(files.has('app/Http/Resources/CommentResource.ts')).toBe(false)
  })

  test("should own nothing of a module's element, which the scaffold still writes at the root's path", () => {
    const files = planDeclaredFiles(commentsPlan((plan) => {
      plan.policies[0].module = 'billing'
    }))

    expect(files.has('app/Policies/CommentPolicy.ts')).toBe(false)
    expect(files.has('app/Providers/CommentPolicyProvider.ts')).toBe(false)
  })
})

describe('declaredTable', () => {
  test('should match the table exactly as the scaffold writes it into this schema', () => {
    expect(tableOf(COMMENTS)).toBe('model.comment')
  })

  test('should match a table only reformatted', () => {
    expect(tableOf(COMMENTS.replace(/'/g, '"').replace(/,\n\}, \(table\)/, '\n}, (table)'))).toBe('model.comment')
  })

  test.each<[string, string, string]>([
    ['another SQL name', "pgTable('comments'", "pgTable('notes'"],
    ['an unplanned column', "  body: text('body').notNull(),", "  body: text('body').notNull(),\n  rating: integer('rating'),"],
    ['a planned column missing', "  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),\n", ''],
    ['a duplicated key hiding a missing column', "  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),", "  body: text('body2').notNull(),"],
    ['a column the plan makes not null declared nullable', "body: text('body').notNull()", "body: text('body')"],
    ['another type', "body: text('body')", "body: integer('body')"],
    ['another SQL column name', "body: text('body')", "body: text('content')"],
    ['a default the plan does not state', "body: text('body').notNull()", "body: text('body').notNull().default('approved')"],
    ['the planned default missing', '.notNull().defaultNow(),', '.notNull(),'],
    ['a unique the plan does not state', "body: text('body').notNull()", "body: text('body').notNull().unique()"],
    ['another foreign key target', '() => posts.id', '() => users.id'],
    ['another delete rule', "{ onDelete: 'cascade' }", "{ onDelete: 'set null' }"],
    ['the planned foreign key missing', ".references(() => posts.id, { onDelete: 'cascade' })", ''],
    ['the planned index missing', "  index('comments_post_id_index').on(table.postId),\n", ''],
    ['a runtime default', "body: text('body').notNull()", "body: text('body').notNull().$defaultFn(() => 'x')"],
  ])('should not match a table with %s', (_why, from, to) => {
    expect(COMMENTS.includes(from)).toBe(true)
    expect(tableOf(COMMENTS.replace(from, to))).toBeUndefined()
  })

  test('should not match a table of another module', () => {
    const text = schemaWith(COMMENTS)
    const subject = tableSubject(text)

    expect(declaredTable(commentsPlan(), { ...subject, table: { ...subject.table, module: 'billing' } }, text)).toBeUndefined()
  })

  test('should not match a model the plan alters, or a column it does not add', () => {
    expect(tableOf(COMMENTS, commentsPlan((plan) => {
      plan.models[1].change = { kind: 'alter' }
    }))).toBeUndefined()
    expect(tableOf(COMMENTS, commentsPlan((plan) => {
      plan.models[1].columns[1].change = { kind: 'existing' }
    }))).toBeUndefined()
  })
})

describe('applyPlanDeclarations', () => {
  const MODEL = `import { defineModel } from '@guren/core'
import { comments } from '@/db/schema'

export class Comment extends defineModel(comments) {}
`
  const fileFact = (path: string, code: ChangeFact['code'] = 'file-added'): ChangeFact => ({ code, lane: 'medium', files: [path], evidence: 'path', message: `${path} added` })
  const scaffolded = (path: string): string => planDeclaredFiles(commentsPlan()).get(path)!.contents
  const only = (plan = commentsPlan()): OpenPlan[] => [{ file: PLAN_FILE, plan }]

  async function judge(plans: OpenPlan[], path: string, content: string, code?: ChangeFact['code']): Promise<ChangeFact> {
    const fact = fileFact(path, code)
    const [result] = await applyPlanDeclarations([fact], new Map([[fact, { kind: 'file', path }]]), plans, async (asked) => (asked === path ? content : null))
    return result!
  }

  test('should lower an added file the plan owns and name the declaration', async () => {
    expect(await judge(only(), 'app/Models/Comment.ts', MODEL)).toEqual({ ...fileFact('app/Models/Comment.ts'), lane: 'low', declaredBy: `${PLAN_FILE}#model.comment` })
  })

  test.each<[string, string]>([
    ['exports another name', MODEL.replace('class Comment', 'class Note')],
    ['re-exports the name from elsewhere', "export { Comment } from '../elsewhere'\n"],
    ['does not parse', 'export class Comment {'],
  ])('should keep a file at the planned path that %s', async (_why, content) => {
    expect((await judge(only(), 'app/Models/Comment.ts', content)).lane).toBe('medium')
  })

  test('should keep a file no plan names', async () => {
    expect((await judge(only(), 'app/Models/Note.ts', 'export class Note {}\n')).lane).toBe('medium')
  })

  test('should lower the provider the scaffold writes, and keep one that does anything more at boot', async () => {
    const path = 'app/Providers/CommentPolicyProvider.ts'
    const provider = scaffolded(path)
    const more = provider.replace(/(\n  (?:async )?boot\(\)[^{]*\{)/, "$1\n    this.container.make('gate').before(() => true)")

    expect(more).not.toBe(provider)
    expect((await judge(only(), path, provider)).lane).toBe('low')
    expect((await judge(only(), path, more)).lane).toBe('medium')
  })

  test('should lower a policy with exactly the planned abilities, and keep one with any other', async () => {
    const path = 'app/Policies/CommentPolicy.ts'
    const policy = scaffolded(path)
    const before = policy.replace(/\n\}\n?$/, '\n\n  before() {\n    return true\n  }\n}\n')

    expect(before).not.toBe(policy)
    expect((await judge(only(), path, policy, 'policy-added')).lane).toBe('low')
    expect((await judge(only(), path, before, 'policy-added')).lane).toBe('medium')
  })

  test('should lower a controller holding only planned actions, and keep one with another member', async () => {
    const path = 'app/Http/Controllers/CommentController.ts'
    const controller = scaffolded(path)
    const extra = controller.replace(/\n\}\n?$/, '\n\n  async purgeAll() {\n    return null\n  }\n}\n')
    const constructed = controller.replace(/(class CommentController extends [^{]+\{)/, '$1\n  constructor() {\n    super()\n  }\n')

    expect(extra).not.toBe(controller)
    expect(constructed).not.toBe(controller)
    expect((await judge(only(), path, controller)).lane).toBe('low')
    expect((await judge(only(), path, extra)).lane).toBe('medium')
    expect((await judge(only(), path, constructed)).lane).toBe('medium')
  })

  test('should keep what a second open plan also claims, even where only one matches in full', async () => {
    const other = commentsPlan((plan) => {
      plan.validators[0].name = 'CommentRatingSchema'
    })
    const plans = [...only(), { file: 'docs/plans/ratings/plan.json', plan: other }]

    expect((await judge(plans, 'app/Models/Comment.ts', MODEL)).lane).toBe('medium')
    expect((await judge(plans, 'app/Http/Validators/CommentValidator.ts', scaffolded('app/Http/Validators/CommentValidator.ts'))).lane).toBe('medium')
  })

  test('should keep a table a second open plan claims with other columns', async () => {
    const text = schemaWith(COMMENTS)
    const table: ChangeFact = { code: 'schema-changed', lane: 'medium', target: 'comments', files: ['db/schema.ts'], evidence: 'static', message: 'table comments added (4 columns)' }
    const subjects = new Map([[table, tableSubject(text)]])
    const other = commentsPlan((plan) => {
      plan.models[1].columns.push({ ...plan.models[1].columns[1], id: 'column.comment.rating', name: 'rating' })
    })

    expect((await applyPlanDeclarations([table], subjects, only(), async () => text))[0]).toEqual({ ...table, lane: 'low', declaredBy: `${PLAN_FILE}#model.comment` })
    expect((await applyPlanDeclarations([table], subjects, [...only(), { file: 'docs/plans/ratings/plan.json', plan: other }], async () => text))[0]).toBe(table)
  })
})
