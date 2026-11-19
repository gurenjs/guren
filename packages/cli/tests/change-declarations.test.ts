import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { readCreationStatements, type MigrationDialect } from '@guren/orm/internal/migration-guard'

import { applyPlanDeclarations, declaredExports, declaredMigration, declaredRoute, declaredTable, planCreatesStatements, planDeclaredFiles, type DeclarationSubject, type OpenPlan } from '../src/change/declarations'
import type { ChangeFact } from '../src/change/lane'
import type { RouteSecurityRecord } from '../src/change/security-records'
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

  test('should count a default export as `default` only, which an importer of the name does not find', () => {
    expect(exportsOf('export default class Provider {}\n')).toEqual(['default'])
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
  test('should own each file the scaffold writes for added elements, the routes file included', () => {
    const files = planDeclaredFiles(commentsPlan())

    expect([...files.keys()].sort()).toEqual([
      'app/Http/Controllers/CommentController.ts',
      'app/Http/Resources/CommentResource.ts',
      'app/Http/Validators/CommentValidator.ts',
      'app/Models/Comment.ts',
      'app/Policies/CommentPolicy.ts',
      'app/Providers/CommentPolicyProvider.ts',
      'routes/comments.ts',
    ])
    expect(files.get('routes/comments.ts')).toMatchObject({ elements: ['route.comments.store', 'route.comments.destroy'], exports: ['registerCommentRoutes'], check: { kind: 'routes' } })
    expect(files.get('app/Models/Comment.ts')).toMatchObject({ elements: ['model.comment'], exports: ['Comment'], check: { kind: 'exports' } })
    expect(files.get('app/Providers/CommentPolicyProvider.ts')).toMatchObject({ exports: ['default'], check: { kind: 'whole' } })
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

  test('should not match a table the scaffold would refuse to write, which lacks what it refused over', () => {
    const text = `import { index, integer, pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'

${COMMENTS.replace(".references(() => posts.id, { onDelete: 'cascade' })", '')}`

    expect(declaredTable(commentsPlan(), tableSubject(text), text)).toBeUndefined()
  })

  test('should resolve a parent the plan also adds, as the step after it finds that table', () => {
    const plan = commentsPlan((document) => {
      document.models[0].change = { kind: 'add' }
      document.models[0].columns[0].change = { kind: 'add' }
    })

    expect(tableOf(COMMENTS, plan)).toBe('model.comment')
    expect(tableOf(COMMENTS.replace(".references(() => posts.id, { onDelete: 'cascade' })", ''), plan)).toBeUndefined()
  })

  test('should not match a statement whose builders are imported under other names', () => {
    const text = schemaWith(COMMENTS).replace('integer, pgTable, serial, text,', 'text as integer, pgTable, serial, integer as text,')

    expect(declaredTable(commentsPlan(), tableSubject(text), text)).toBeUndefined()
  })

  test("should match a statement whose builders come from its dialect's drizzle subpath and the barrel re-exporting it", () => {
    // What `appendTableToSchema()` writes into a schema importing from `drizzle-orm/pg-core`: the new builders from the barrel.
    const text = schemaWith(COMMENTS).replace("import { index, integer, pgTable, serial, text, timestamp } from '@guren/orm/drizzle/pg'", "import { index, integer, timestamp } from '@guren/orm/drizzle/pg'\nimport { pgTable, serial, text } from 'drizzle-orm/pg-core'")

    expect(text).toContain("from 'drizzle-orm/pg-core'")
    expect(declaredTable(commentsPlan(), tableSubject(text), text)).toBe('model.comment')
    expect(declaredTable(commentsPlan(), tableSubject(text), text.replace("from 'drizzle-orm/pg-core'", "from 'drizzle-orm/sqlite-core'"))).toBeUndefined()
  })

  test("should not match a statement that takes a builder from another dialect's barrel", () => {
    const text = schemaWith(COMMENTS).replace('pgTable, serial, text, timestamp }', "pgTable, serial, timestamp }\nimport { text } from '@guren/orm/drizzle/sqlite'")

    expect(text).toContain("import { text } from '@guren/orm/drizzle/sqlite'")
    // The schema reader gives no tables for a file mixing barrels, and lane.ts then emits no table fact; the subject is the plain one.
    expect(declaredTable(commentsPlan(), tableSubject(schemaWith(COMMENTS)), text)).toBeUndefined()
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

  test('should keep a definePolicy() policy, which holds keys its abilities leave out, and a class exported under an alias', async () => {
    const path = 'app/Policies/CommentPolicy.ts'
    const defined = "import { definePolicy } from '@guren/core'\n\nexport const CommentPolicy = definePolicy({ before: () => true, delete: () => false })\n"
    const aliased = `${scaffolded(path).replace('export class CommentPolicy', 'export default class Foo')}\nconst x = {}\nexport { x as CommentPolicy }\n`

    expect((await judge(only(), path, defined, 'policy-added')).lane).toBe('medium')
    expect((await judge(only(), path, aliased, 'policy-added')).lane).toBe('medium')
  })

  test.each<[string, (policy: string) => string]>([
    ['a statement beside the class', (policy) => `${policy}\n;(CommentPolicy.prototype as any).before = () => true\n`],
    ['a static block', (policy) => policy.replace('extends Policy {', 'extends Policy {\n  static {\n    Object.assign(CommentPolicy.prototype, {})\n  }\n')],
    ['an import run for its effects', (policy) => `import './register'\n${policy}`],
  ])('should keep a policy file holding %s', async (_why, edit) => {
    const path = 'app/Policies/CommentPolicy.ts'
    const changed = edit(scaffolded(path))

    expect(changed).not.toBe(scaffolded(path))
    expect((await judge(only(), path, changed, 'policy-added')).lane).toBe('medium')
  })

  test("should keep a controller extending the application's own base class, whose members are not read", async () => {
    const path = 'app/Http/Controllers/CommentController.ts'
    const local = scaffolded(path).replace("import { Controller, HttpException } from '@guren/core'", "import { HttpException } from '@guren/core'\nimport { Controller } from './Controller'")

    expect(local).not.toBe(scaffolded(path))
    expect((await judge(only(), path, local)).lane).toBe('medium')
  })

  test('should keep a policy the file exports as default, which the provider imports by name', async () => {
    const path = 'app/Policies/CommentPolicy.ts'

    expect((await judge(only(), path, scaffolded(path).replace('export class CommentPolicy', 'export default class CommentPolicy'), 'policy-added')).lane).toBe('medium')
  })

  test('should keep a controller whose exported name is another class', async () => {
    const path = 'app/Http/Controllers/CommentController.ts'
    const aliased = `${scaffolded(path).replace('export default class CommentController', 'class CommentController')}\nclass Other extends Controller {\n  purgeAll() {}\n}\nexport { Other as CommentController, Other as default }\n`

    expect((await judge(only(), path, aliased)).lane).toBe('medium')
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

  test('should keep a file a second open plan names, though its own scaffold writes nothing there', async () => {
    const path = 'app/Http/Controllers/CommentController.ts'
    const other = commentsPlan((plan) => {
      plan.controllers[0].change = { kind: 'existing' }
      for (const action of plan.controllers[0].actions) action.change = { kind: 'existing' }
    })

    expect(planDeclaredFiles(other).has(path)).toBe(false)
    expect((await judge([...only(), { file: 'docs/plans/moderation/plan.json', plan: other }], path, scaffolded(path))).lane).toBe('medium')
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

  test("should account for a declared table's own residue, and keep it beside a table no plan declares", async () => {
    const text = schemaWith(COMMENTS)
    const table: ChangeFact = { code: 'schema-changed', lane: 'medium', target: 'comments', files: ['db/schema.ts'], evidence: 'static', message: 'table comments added (4 columns)' }
    const residue: ChangeFact = { code: 'source-edited', lane: 'medium', target: 'comments', files: ['db/schema.ts'], evidence: 'static', message: 'db/schema.ts: table comments holds code' }
    const subjects = new Map<ChangeFact, DeclarationSubject>([[table, tableSubject(text)], [residue, { kind: 'table-residue', file: 'db/schema.ts', identifier: 'comments' }]])
    const edited = schemaWith(COMMENTS.replace("index('comments_post_id_index')", "index('comments_body_index')"))

    expect(await applyPlanDeclarations([table, residue], subjects, only(), async () => text)).toEqual([{ ...table, lane: 'low', declaredBy: `${PLAN_FILE}#model.comment` }])
    expect(await applyPlanDeclarations([table, residue], subjects, only(), async () => edited)).toEqual([table, residue])
  })
})

/** The fixture run of `@guren/orm`: the comments plan's tables and a `tags` model beside them, per dialect. */
const CREATION = join(import.meta.dir, '../../orm/tests/fixtures/drizzle-kit-migrations/creation')

/** The comments plan with the `tags` model the creation fixtures were generated from. */
function tagsPlan(edit?: (document: Record<string, any>) => void): PlanDraft {
  return commentsPlan((document) => {
    const column = (id: string, name: string, type: string, extra: Record<string, unknown> = {}) => ({ id, name, change: { kind: 'add' }, type, nullable: false, unique: false, index: false, ...extra })
    document.models.push({
      id: 'model.tag', change: { kind: 'add' }, name: 'Tag', table: 'tags', relationships: [], fillable: ['slug'],
      columns: [
        column('column.tag.id', 'id', 'integer', { primaryKey: true }),
        column('column.tag.slug', 'slug', 'string', { unique: true }),
        column('column.tag.label', 'label', 'string', { default: "'untitled'" }),
        column('column.tag.weight', 'weight', 'decimal', { precision: 8, scale: 2, nullable: true }),
        column('column.tag.active', 'active', 'boolean', { default: 'false' }),
        column('column.tag.meta', 'meta', 'json', { nullable: true }),
        column('column.tag.ref', 'ref', 'uuid', { nullable: true, index: true }),
        column('column.tag.seenOn', 'seenOn', 'date', { nullable: true, columnName: 'seen_on' }),
        column('column.tag.postId', 'postId', 'integer', { nullable: true, references: { model: 'model.post', column: 'id', onDelete: 'set null' } }),
        column('column.tag.createdAt', 'createdAt', 'datetime', { default: 'now()' }),
      ],
      indexes: [{ columns: ['label', 'weight'], unique: false }],
    })
    document.tasks[0].covers.push('model.tag')
    edit?.(document)
  })
}

describe('declaredMigration', () => {
  /** The fixture run of `dialect` as a migrations folder at the head, with `over` replacing a file's content. */
  function migration(dialect: string, over: Record<string, string | null> = {}) {
    const root = join(CREATION, dialect)
    const [base, head] = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
    const subject: Extract<DeclarationSubject, { kind: 'migration' }> = { kind: 'migration', dir: `drizzle/${head}`, files: [`drizzle/${head}/migration.sql`, `drizzle/${head}/snapshot.json`], previous: `drizzle/${base}` }
    const readHead = async (path: string): Promise<string | null> => {
      if (path in over) return over[path]!
      if (path === 'db/schema.ts') return readFileSync(join(root, 'schema.ts.txt'), 'utf8')
      const [folder, file] = path.replace('drizzle/', '').split('/')
      try {
        return readFileSync(join(root, folder!, file!), 'utf8')
      } catch {
        return null
      }
    }
    const schema = parseSchemaSource(readFileSync(join(root, 'schema.ts.txt'), 'utf8'), 'db/schema.ts', null)!
    return { subject, readHead, schema, sql: `drizzle/${head}/migration.sql`, snapshot: `drizzle/${head}/snapshot.json`, text: readFileSync(join(root, head!, 'migration.sql'), 'utf8') }
  }
  const DIALECT: Record<string, MigrationDialect> = { pg: 'postgres', mysql: 'mysql', sqlite: 'sqlite' }
  const open = (plan = tagsPlan()): OpenPlan[] => [{ file: PLAN_FILE, plan }]

  test.each(['pg', 'mysql', 'sqlite'])('should declare the %s migration drizzle-kit writes for the tables the plan adds', async (dialect) => {
    const { subject, readHead } = migration(dialect)

    expect(await declaredMigration(subject, open(), readHead)).toBe(`${PLAN_FILE}#model.comment,model.tag`)
  })

  test.each<[string, (sql: string, quote: string, dialect: string) => string]>([
    ['a statement about another table', (sql, q) => `${sql};\nCREATE INDEX ${q}posts_id_index${q} ON ${q}posts${q} (${q}id${q});`],
    ['a column the plan does not add', (sql, q) => sql.replace(`${q}body${q} text NOT NULL,`, `${q}body${q} text NOT NULL,\n\t${q}secret${q} text,`)],
    ['a planned column missing', (sql) => sql.replace(/\n\t.body. text NOT NULL,/, '')],
    ['a planned NOT NULL missing', (sql, q) => sql.replace(`${q}body${q} text NOT NULL`, `${q}body${q} text`)],
    ['a unique the plan does not state', (sql, q) => sql.replace(`${q}body${q} text NOT NULL`, `${q}body${q} text NOT NULL UNIQUE`)],
    ['a planned unique missing', (sql, q, dialect) => (dialect === 'mysql' ? sql.replace(/,\n\tCONSTRAINT `slug_unique` UNIQUE INDEX\(`slug`\)/, '') : sql.replace(`${q}slug${q} text NOT NULL UNIQUE`, `${q}slug${q} text NOT NULL`))],
    ['another default', (sql) => sql.replace("'untitled'", "'other'")],
    ['a foreign key deleting otherwise', (sql) => sql.replace('ON DELETE CASCADE', 'ON DELETE RESTRICT')],
    ['an index the plan does not plan', (sql, q) => sql.replace(`(${q}post_id${q});`, `(${q}body${q});`)],
    ['a planned index missing', (sql) => sql.split('--> statement-breakpoint').filter((piece) => !piece.includes('CREATE INDEX')).join('--> statement-breakpoint')],
    ['a planned index stated twice', (sql, q) => `${sql};\nCREATE INDEX ${q}tags_ref_again${q} ON ${q}tags${q} (${q}ref${q});`],
    ['another column type', (sql, q) => sql.replace(`${q}body${q} text NOT NULL`, `${q}body${q} integer NOT NULL`)],
    ['a key the database does not number', (sql, _q, dialect) => (dialect === 'pg' ? sql.replaceAll('"id" serial PRIMARY KEY', '"id" integer PRIMARY KEY') : sql.replaceAll(' AUTO_INCREMENT', '').replaceAll(' AUTOINCREMENT', ''))],
    ["a date where the plan's now() is a timestamp", (sql, _q, dialect) => ({
      pg: () => sql.replace('"created_at" timestamp with time zone DEFAULT now()', '"created_at" timestamp with time zone DEFAULT CURRENT_DATE'),
      mysql: () => sql.replace('`created_at` timestamp NOT NULL DEFAULT (CURRENT_TIMESTAMP)', '`created_at` timestamp NOT NULL DEFAULT (CURRENT_DATE)'),
      sqlite: () => sql.replace('`created_at` integer DEFAULT (unixepoch())', '`created_at` integer DEFAULT CURRENT_DATE'),
    })[dialect]!()],
    ['an index ahead of its table', (sql) => {
      const pieces = sql.split('--> statement-breakpoint')
      const [index] = pieces.splice(pieces.findIndex((piece) => piece.includes('tags_ref_index')), 1)
      pieces.splice(1, 0, index!)
      return pieces.join('--> statement-breakpoint')
    }],
  ])('should declare nothing for a migration with %s', async (_label, edit) => {
    for (const dialect of ['pg', 'mysql', 'sqlite']) {
      const quote = dialect === 'pg' ? '"' : '`'
      const { subject, sql, schema, text } = migration(dialect)
      const edited = edit(text, quote, dialect)

      expect(edited).not.toBe(text)
      expect(await declaredMigration(subject, open(), migration(dialect, { [sql]: edited }).readHead)).toBeUndefined()
      // The plan rule alone, with no snapshot to disagree with the edit.
      expect(planCreatesStatements(tagsPlan(), readCreationStatements(text, DIALECT[dialect]!)!, schema, schema[0]!.dialect)).toEqual(['model.comment', 'model.tag'])
      const statements = readCreationStatements(edited, DIALECT[dialect]!)
      expect(statements && planCreatesStatements(tagsPlan(), statements, schema, schema[0]!.dialect)).toBeUndefined()
    }
  })

  test.each<[string, string]>([
    ['pg', 'CREATE TABLE "members" (\n\t"tenant_id" integer,\n\t"item_id" integer,\n\tCONSTRAINT "members_pkey" PRIMARY KEY("tenant_id","item_id")\n);\n'],
    ['mysql', 'CREATE TABLE `members` (\n\t`tenant_id` int NOT NULL,\n\t`item_id` int NOT NULL,\n\tCONSTRAINT PRIMARY KEY(`tenant_id`,`item_id`)\n);\n'],
    ['sqlite', 'CREATE TABLE `members` (\n\t`tenant_id` integer NOT NULL,\n\t`item_id` integer NOT NULL,\n\tCONSTRAINT `members_pk` PRIMARY KEY(`tenant_id`, `item_id`)\n);\n'],
  ])('should hold a %s composite key in the order the scaffold writes it', (dialect, sql) => {
    const { schema } = migration(dialect)
    const plan = tagsPlan((document) => {
      const column = (id: string, name: string, columnName: string) => ({ id, name, columnName, change: { kind: 'add' }, type: 'integer', nullable: false, unique: false, index: false, primaryKey: true })
      document.models.push({ id: 'model.member', change: { kind: 'add' }, name: 'Member', table: 'members', relationships: [], fillable: [], indexes: [], columns: [column('column.member.tenantId', 'tenantId', 'tenant_id'), column('column.member.itemId', 'itemId', 'item_id')] })
      document.tasks[0].covers.push('model.member')
    })
    const reversed = sql.replace(/PRIMARY KEY\((.)tenant_id(.),( ?)(.)item_id(.)\)/, 'PRIMARY KEY($1item_id$2,$3$4tenant_id$5)')

    expect(reversed).not.toBe(sql)
    expect(planCreatesStatements(plan, readCreationStatements(sql, DIALECT[dialect]!)!, schema, schema[0]!.dialect)).toEqual(['model.member'])
    expect(planCreatesStatements(plan, readCreationStatements(reversed, DIALECT[dialect]!)!, schema, schema[0]!.dialect)).toBeUndefined()
  })

  test('should declare nothing behind a separator inside a comment, which the migrator runs as its own statement', async () => {
    for (const dialect of ['pg', 'mysql', 'sqlite']) {
      const { subject, sql, text } = migration(dialect)

      expect(await declaredMigration(subject, open(), migration(dialect, { [sql]: `${text}\n-- x --> statement-breakpoint DROP TABLE users;\n` }).readHead)).toBeUndefined()
    }
  })

  test('should declare nothing when the folder holds another file, or its snapshot is missing or misstates the SQL', async () => {
    const { subject, readHead, snapshot } = migration('pg')
    const forged = JSON.parse((await readHead(snapshot))!)
    forged.ddl.find((entry: Record<string, unknown>) => entry.entityType === 'columns' && entry.table === 'tags' && entry.name === 'slug').type = 'varchar(1)'

    expect(await declaredMigration({ ...subject, files: [...subject.files, `${subject.dir}/notes.sql`] }, open(), readHead)).toBeUndefined()
    expect(await declaredMigration(subject, open(), migration('pg', { [snapshot]: JSON.stringify(forged) }).readHead)).toBeUndefined()
    expect(await declaredMigration(subject, open(), migration('pg', { [`${subject.previous}/snapshot.json`]: null }).readHead)).toBeUndefined()
    expect(await declaredMigration({ ...subject, files: [subject.files[0]!] }, open(), migration('pg', { [snapshot]: null }).readHead)).toBeUndefined()
  })

  test('should declare nothing for a table a second open plan claims, or one the plan adds in a module', async () => {
    const { subject, readHead } = migration('pg')
    const second = tagsPlan((document) => {
      document.models = document.models.filter((model: { id: string }) => model.id !== 'model.comment')
    })
    const inModule = tagsPlan((document) => {
      document.models.find((model: { id: string }) => model.id === 'model.tag').module = 'blog'
    })

    expect(await declaredMigration(subject, [...open(), { file: 'docs/plans/tags/plan.json', plan: second }], readHead)).toBeUndefined()
    expect(await declaredMigration(subject, open(inModule), readHead)).toBeUndefined()
    expect(await declaredMigration(subject, open(commentsPlan()), readHead)).toBeUndefined()
  })
})

/** Real records of the fixture app: `scaffold` after the comments scaffold step, `mount` after its `--mount`. */
const ROUTES_FIXTURE = join(import.meta.dir, 'fixtures/change-routes')
const ROUTE_RECORDS = JSON.parse(readFileSync(join(ROUTES_FIXTURE, 'records.json'), 'utf8')) as Record<'scaffold' | 'mount', { routes: RouteSecurityRecord[] }>
const [STORE, DESTROY, HOME] = ROUTE_RECORDS.mount.routes as [RouteSecurityRecord, RouteSecurityRecord, RouteSecurityRecord]
const AUTH = STORE.middleware[0]!

describe('declaredRoute', () => {
  const only = (plan = commentsPlan()): OpenPlan[] => [{ file: PLAN_FILE, plan }]
  const routes = [STORE, DESTROY, HOME]

  test('should declare each route the mounted scaffold registers, by its plan element', () => {
    expect(declaredRoute(STORE, routes, only())).toBe(`${PLAN_FILE}#route.comments.store`)
    expect(declaredRoute(DESTROY, routes, only())).toBe(`${PLAN_FILE}#route.comments.destroy`)
  })

  test.each<[string, (route: RouteSecurityRecord) => RouteSecurityRecord]>([
    ['another path', (route) => ({ ...route, path: '/comments' })],
    ['another method', (route) => ({ ...route, method: 'PUT' })],
    ['no name', ({ name: _name, ...route }) => route],
    ['a module', (route) => ({ ...route, module: 'billing' })],
    ['an action in another file', (route) => ({ ...route, action: route.action!.replace('Controllers/', 'Controllers/Admin/') })],
    ['another action', (route) => ({ ...route, action: route.action!.replace('.destroy', '.store') })],
    ['an inline handler', ({ action: _action, ...route }) => route],
    ['no middleware', (route) => ({ ...route, middleware: [] })],
    ['an inline middleware beside it', (route) => ({ ...route, middleware: [...route.middleware, { kind: 'inline', name: null, capabilities: {} }] })],
    ['an `auth` that does not require a user', (route) => ({ ...route, middleware: [{ ...AUTH, capabilities: {} }] })],
    ['an `auth` nothing registers', (route) => ({ ...route, middleware: [{ ...AUTH, unresolved: true }] })],
    ['another binding', (route) => ({ ...route, bindings: { id: 'Post' } })],
    ['no binding', ({ bindings: _bindings, ...route }) => route],
    ['an agent tool', (route) => ({ ...route, agent: { toolName: 'comments_destroy' } })],
    ['a body contract', (route) => ({ ...route, contracts: STORE.contracts })],
    ['no authorize() call', (route) => ({ ...route, handler: { authenticates: false, authorizes: [], validates: [] } })],
    ['an authorize() call for another ability', (route) => ({ ...route, handler: { authenticates: false, authorizes: [{ member: 'authorize', ability: 'update', subject: '[Comment, comment]' }], validates: [] } })],
    ['an unread body', (route) => ({ ...route, handler: { unread: 'not found' } })],
  ])('should not declare a route with %s', (_why, edit) => {
    const route = edit(DESTROY)
    expect(declaredRoute(route, [STORE, route, HOME], only())).toBeUndefined()
  })

  test.each<[string, (route: RouteSecurityRecord) => RouteSecurityRecord]>([
    ['no body contract', (route) => ({ ...route, contracts: {} })],
    ['a contract of another export', (route) => ({ ...route, contracts: { body: { ...route.contracts.body!, exports: ['app/Http/Validators/CommentValidator.ts#OtherSchema'] } } })],
    ['a params contract the plan does not state', (route) => ({ ...route, contracts: { ...route.contracts, params: route.contracts.body! } })],
  ])('should not declare a store route with %s', (_why, edit) => {
    const route = edit(STORE)
    expect(declaredRoute(route, [route, DESTROY, HOME], only())).toBeUndefined()
  })

  test('should not declare a route registered ahead of one whose requests it answers', () => {
    // `--mount` calls the scaffold's registrar first, so DELETE /comments/:id answers DELETE /comments/archived too.
    const archived: RouteSecurityRecord = { ...HOME, method: 'DELETE', path: '/comments/archived', name: 'comments.archived' }
    expect(declaredRoute(DESTROY, [STORE, DESTROY, archived, HOME], only())).toBeUndefined()
    expect(declaredRoute(DESTROY, [archived, STORE, DESTROY, HOME], only())).toBe(`${PLAN_FILE}#route.comments.destroy`)
    expect(declaredRoute(DESTROY, [STORE, DESTROY, { ...archived, module: 'billing' }, HOME], only())).toBeUndefined()
  })

  test('should not declare a route a second open plan names, one the plan alters, or one binding a planned key', () => {
    expect(declaredRoute(DESTROY, routes, [...only(), { file: 'docs/plans/moderation/plan.json', plan: commentsPlan() }])).toBeUndefined()
    expect(declaredRoute(DESTROY, routes, only(commentsPlan((plan) => {
      plan.routes[1].change = { kind: 'alter' }
    })))).toBeUndefined()
    // The manifest names a binding's model and not its lookup column.
    expect(declaredRoute(DESTROY, routes, only(commentsPlan((plan) => {
      plan.routes[1].bind[0].key = 'slug'
    })))).toBeUndefined()
  })

  test("should declare a route's agent tool only as the plan states it", () => {
    const tool = { ...DESTROY, agent: { toolName: 'comments_destroy', readOnlyHint: false } }
    const withAgent = commentsPlan((plan) => {
      plan.routes[1].agent = { toolName: 'comments_destroy', readOnly: false }
    })
    expect(declaredRoute(tool, [STORE, tool, HOME], only(withAgent))).toBe(`${PLAN_FILE}#route.comments.destroy`)
    expect(declaredRoute({ ...tool, agent: { ...tool.agent, readOnlyHint: true } }, [STORE, tool, HOME], only(withAgent))).toBeUndefined()
    expect(declaredRoute({ ...tool, agent: { ...tool.agent, approval: 'required' } }, [STORE, tool, HOME], only(withAgent))).toBeUndefined()
    expect(declaredRoute(DESTROY, routes, only(withAgent))).toBeUndefined()
  })
})

describe('applyPlanDeclarations on a mount', () => {
  const ENTRY = 'routes/web.ts'
  const BASE = readFileSync(join(ROUTES_FIXTURE, 'web.base.ts.txt'), 'utf8')
  const HEAD = readFileSync(join(ROUTES_FIXTURE, 'web.head.ts.txt'), 'utf8')
  const only = (plan = commentsPlan()): OpenPlan[] => [{ file: PLAN_FILE, plan }]
  const routes = [STORE, DESTROY, HOME]

  /** The facts `judgeChangeLane()` gives the mount commit, each with its subject. */
  function mountFacts(added: RouteSecurityRecord[] = [STORE, DESTROY], extra: Array<[ChangeFact, DeclarationSubject]> = []): { facts: ChangeFact[]; subjects: Map<ChangeFact, DeclarationSubject> } {
    const subjects = new Map<ChangeFact, DeclarationSubject>()
    const entry: ChangeFact = { code: 'source-edited', lane: 'medium', files: [ENTRY], evidence: 'path', message: `${ENTRY} modified` }
    subjects.set(entry, { kind: 'routes-entry', path: ENTRY })
    for (const route of added) {
      subjects.set({ code: 'route-added', lane: 'medium', files: [ENTRY], evidence: 'registered', message: `${route.method} ${route.path}` }, { kind: 'route', change: 'add', route, routes })
    }
    for (const [fact, subject] of extra) subjects.set(fact, subject)
    return { facts: [...subjects.keys()], subjects }
  }
  const read = (text: string) => async (path: string): Promise<string | null> => (path === ENTRY ? text : null)

  test('should drop the entry edit of exactly the mount, once each route it adds is declared', async () => {
    const { facts, subjects } = mountFacts()
    const result = await applyPlanDeclarations(facts, subjects, only(), read(HEAD), read(BASE))

    expect(result.map((fact) => [fact.code, fact.lane, fact.declaredBy])).toEqual([
      ['route-added', 'low', `${PLAN_FILE}#route.comments.store`],
      ['route-added', 'low', `${PLAN_FILE}#route.comments.destroy`],
    ])
  })

  test.each<[string, string]>([
    ['another line beside the mount', HEAD.replace("  router.get('/'", "  router.get('/admin', (c) => c.text('admin'))\n  router.get('/'")],
    ['the call without its import', HEAD.replace("import { registerCommentRoutes } from './comments.js'\n", "import { registerCommentRoutes } from './other.js'\n")],
    ['the call placed last', HEAD.replace('  registerCommentRoutes(router)\n\n', '').replace("name('home')\n", "name('home')\n  registerCommentRoutes(router)\n")],
  ])('should keep an entry edit holding %s', async (_why, head) => {
    const { facts, subjects } = mountFacts()
    const result = await applyPlanDeclarations(facts, subjects, only(), read(head), read(BASE))

    expect(result.filter((fact) => fact.code === 'source-edited')).toHaveLength(1)
  })

  test('should keep the entry edit when a route it adds is undeclared, one is missing, or another route changed', async () => {
    const undeclared = mountFacts([STORE, { ...DESTROY, middleware: [] }])
    expect((await applyPlanDeclarations(undeclared.facts, undeclared.subjects, only(), read(HEAD), read(BASE))).filter((fact) => fact.code === 'source-edited')).toHaveLength(1)
    const missing = mountFacts([STORE])
    expect((await applyPlanDeclarations(missing.facts, missing.subjects, only(), read(HEAD), read(BASE))).filter((fact) => fact.code === 'source-edited')).toHaveLength(1)
    const changed: ChangeFact = { code: 'route-changed', lane: 'medium', files: [ENTRY], evidence: 'registered', message: 'GET /' }
    const beside = mountFacts([STORE, DESTROY], [[changed, { kind: 'route', change: 'alter', route: HOME, base: HOME, routes }]])
    expect((await applyPlanDeclarations(beside.facts, beside.subjects, only(), read(HEAD), read(BASE))).filter((fact) => fact.code === 'source-edited')).toHaveLength(1)
  })

  test('should keep the entry edit with no route fact, which a change whose records were not compared has', async () => {
    const { facts, subjects } = mountFacts([])
    expect(await applyPlanDeclarations(facts, subjects, only(), read(HEAD), read(BASE))).toEqual(facts)
  })
})

describe('applyPlanDeclarations on a scaffolded routes file', () => {
  const PATH = 'routes/comments.ts'
  const COMMENTS_ROUTES = readFileSync(join(ROUTES_FIXTURE, 'comments.ts.txt'), 'utf8')
  const POST_MODEL = "import { defineModel } from '@guren/core'\nimport { posts } from '@/db/schema'\n\nexport class Post extends defineModel(posts) {}\n"
  const fact: ChangeFact = { code: 'file-added', lane: 'medium', files: [PATH], evidence: 'path', message: `${PATH} added` }
  const judge = async (routesFile: string, files: Record<string, string> = { 'app/Models/Post.ts': POST_MODEL }) => {
    const head: Record<string, string> = { [PATH]: routesFile, ...files }
    const [result] = await applyPlanDeclarations([fact], new Map([[fact, { kind: 'file', path: PATH }]]), [{ file: PLAN_FILE, plan: commentsPlan() }], async (path) => head[path] ?? null)
    return result!
  }

  test('should lower the file the scaffold wrote, binding the model the head declares', async () => {
    expect(await judge(COMMENTS_ROUTES)).toMatchObject({ lane: 'low', declaredBy: `${PLAN_FILE}#route.comments.store,route.comments.destroy` })
  })

  test('should keep it with a route more, or when the head keeps the bound model elsewhere', async () => {
    expect((await judge(COMMENTS_ROUTES.replace(/\n}\n$/, "\n  router.get('/comments', [CommentController, 'store'])\n}\n"))).lane).toBe('medium')
    expect((await judge(COMMENTS_ROUTES, {})).lane).toBe('medium')
  })
})
