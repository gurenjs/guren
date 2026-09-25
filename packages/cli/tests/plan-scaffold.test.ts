import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import { builtinSubCommands } from '../src/commands'
import { formatPlanScaffold, planScaffoldFile, type PlanScaffoldReport } from '../src/plan-scaffold'
import { parsePlanDocument } from '../src/plan-render'
import { loadPlanAppState } from '../src/plan/app-state'
import { emitPlanScaffold, type PlanScaffoldOutput } from '../src/plan/scaffold'
import { PLAN_VERSION } from '../src/plan/schema'
import { writePlanActiveStep } from '../src/plan/state'
import { judgePlan, type PlanStatus } from '../src/plan/status'
import { derivePlanTasks, findPlanStep } from '../src/plan/tasks'
import { readSchemaTables } from '../src/schema-runtime'
import type { SchemaDialect } from '../src/schema-parser'
import { checkTypes, createTempRoot, linkWorkspaceCore, renderedAppCompilerOptions, snapshotTree, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'
import { approvedAgainst, approvePlanFile, loadParsedCommentsPlan, type PlanInput } from './plan-fixture'

// A temp app resolves `drizzle-orm` from Bun's global cache or not at all, so each one links
// the copy `@guren/orm` pins, and the barrel the emitted schema imports, as schema-runtime.test.ts does.
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')
const WORKSPACE_ORM = resolve(import.meta.dir, '../../orm')

const STEP = 'task/entity/model.widget/scaffold'
const PLAN_FILE = 'widgets.plan.json'

let ROOT: string

type ModelInput = NonNullable<PlanInput['models']>[number]
type ColumnInput = ModelInput['columns'][number]
type WidgetsPlan = PlanInput & { models: ModelInput[] }

function column(model: string, name: string, type: ColumnInput['type'], fields: Partial<ColumnInput> = {}): ColumnInput {
  return { id: `column.${model}.${name}`, name, change: { kind: 'add' }, type, nullable: false, unique: false, index: false, ...fields }
}

const existingId = (model: string): ColumnInput => column(model, 'id', 'integer', { change: { kind: 'existing' }, primaryKey: true })

/** Every plan column type, and every option `plan:status` compares, on one added model. */
function widgetsPlan(): WidgetsPlan {
  return {
    planVersion: PLAN_VERSION,
    title: 'Widgets',
    summary: 'Widgets that belong to a post and carry tags.',
    locale: 'en',
    scope: { goals: ['widgets'], nonGoals: [] },
    models: [
      { id: 'model.post', change: { kind: 'existing' }, name: 'Post', table: 'posts', columns: [existingId('post')], relationships: [], fillable: [] },
      { id: 'model.tag', change: { kind: 'existing' }, name: 'Tag', table: 'tags', columns: [existingId('tag')], relationships: [], fillable: [] },
      {
        id: 'model.widgetTag',
        change: { kind: 'existing' },
        name: 'WidgetTag',
        table: 'widget_tags',
        columns: [
          column('widgetTag', 'widgetId', 'integer', { change: { kind: 'existing' }, references: { model: 'model.widget', column: 'id' } }),
          column('widgetTag', 'tagId', 'integer', { change: { kind: 'existing' }, references: { model: 'model.tag', column: 'id' } }),
        ],
        relationships: [],
        fillable: [],
      },
      {
        id: 'model.widget',
        change: { kind: 'add' },
        name: 'Widget',
        table: 'widgets',
        columns: [
          column('widget', 'id', 'integer', { primaryKey: true }),
          column('widget', 'title', 'string', { unique: true, default: "'untitled'" }),
          column('widget', 'body', 'text', { nullable: true }),
          column('widget', 'count', 'integer', { index: true, default: '0' }),
          column('widget', 'ratio', 'number', { nullable: true }),
          column('widget', 'price', 'decimal', { precision: 10, scale: 2, default: '0' }),
          column('widget', 'active', 'boolean', { default: 'false' }),
          column('widget', 'releasedOn', 'date', { nullable: true, columnName: 'released_on' }),
          column('widget', 'publishedAt', 'datetime', { withTimezone: true, default: 'now()', columnName: 'published_at' }),
          column('widget', 'meta', 'json', { nullable: true }),
          column('widget', 'token', 'uuid', { unique: true }),
          column('widget', 'postId', 'integer', { index: true, columnName: 'post_id', references: { model: 'model.post', column: 'id', onDelete: 'cascade' } }),
          column('widget', 'parentId', 'integer', { nullable: true, columnName: 'parent_id', references: { model: 'model.widget', column: 'id', onDelete: 'set null' } }),
        ],
        indexes: [
          { columns: ['title', 'count'], unique: true },
          { columns: ['ratio', 'active'], unique: false },
        ],
        relationships: [
          { name: 'post', type: 'belongsTo', target: 'model.post' },
          { name: 'parent', type: 'belongsTo', target: 'model.widget' },
          { name: 'children', type: 'hasMany', target: 'model.widget' },
          { name: 'tags', type: 'belongsToMany', target: 'model.tag' },
        ],
        fillable: ['title', 'body'],
      },
    ],
  }
}

/** The tables the plan names as existing, in each dialect; the pivot carries no key to a table that does not exist yet. */
const SCHEMAS: Record<SchemaDialect, string> = {
  pg: `import { integer, pgTable, serial, text } from '@guren/orm/drizzle/pg'

export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
})

export const tags = pgTable('tags', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})

export const widgetTags = pgTable('widget_tags', {
  widgetId: integer('widget_id').notNull(),
  tagId: integer('tag_id').notNull(),
})
`,
  mysql: `import { int, mysqlTable, varchar } from '@guren/orm/drizzle/mysql'

export const posts = mysqlTable('posts', {
  id: int('id').primaryKey().autoincrement(),
  title: varchar('title', { length: 255 }).notNull(),
})

export const tags = mysqlTable('tags', {
  id: int('id').primaryKey().autoincrement(),
  name: varchar('name', { length: 255 }).notNull(),
})

export const widgetTags = mysqlTable('widget_tags', {
  widgetId: int('widget_id').notNull(),
  tagId: int('tag_id').notNull(),
})
`,
  sqlite: `import { integer, sqliteTable, text } from '@guren/orm/drizzle/sqlite'

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

export const widgetTags = sqliteTable('widget_tags', {
  widgetId: integer('widget_id').notNull(),
  tagId: integer('tag_id').notNull(),
})
`,
}

const model = (name: string, table: string): string => `import { defineModel } from '@guren/core'
import { ${table} } from '../../db/schema.js'

export class ${name} extends defineModel(${table}) {}
`

/**
 * Where the readers stop, per dialect; every other planned property must read `match`. No
 * reader reports a foreign key action; SQLite keeps booleans, dates, JSON and UUIDs in
 * `integer`/`text` under a mode no reader reports, and its `numeric` has no size; MySQL has no
 * `uuid` builder and neither it nor SQLite reports `withTimezone`; SQLite's `unixepoch()` is compared as text.
 */
const READER_LIMITS: Record<SchemaDialect, string[]> = {
  pg: ['column.widget.postId references.onDelete', 'column.widget.parentId references.onDelete'],
  mysql: [
    'column.widget.postId references.onDelete',
    'column.widget.parentId references.onDelete',
    'column.widget.token type',
    'column.widget.publishedAt withTimezone',
  ],
  sqlite: [
    'column.widget.postId references.onDelete',
    'column.widget.parentId references.onDelete',
    'column.widget.active type',
    'column.widget.releasedOn type',
    'column.widget.publishedAt type',
    'column.widget.meta type',
    'column.widget.token type',
    'column.widget.price precision,scale',
    'column.widget.publishedAt withTimezone',
    'column.widget.publishedAt default',
  ],
}


/** The document stamped and ready to approve, as `plan:approve` would stamp it against the fixture app. */
function approve(document: WidgetsPlan): Record<string, unknown> {
  return approvedAgainst(document as unknown as Record<string, unknown>)
}

interface AppOptions {
  dialect?: SchemaDialect
  document?: WidgetsPlan | Record<string, unknown>
  /** Approve the plan file; false leaves a stamped plan unapproved. */
  approve?: boolean
  /** The step `plan:next` marked; `null` marks none. */
  mark?: string | null
  files?: Record<string, string>
  packageJson?: Record<string, unknown>
  /** Link drizzle, the ORM and core, which only a run of the readers needs; a refusal's tree snapshot skips none of it. */
  link?: boolean
}

async function createApp(name: string, options: AppOptions = {}): Promise<{ dir: string; plan: string }> {
  const dir = join(ROOT, name)
  const dialect = options.dialect ?? 'pg'
  const document = options.document ?? approve(widgetsPlan())
  await writeWorkspaceFiles(dir, {
    'package.json': JSON.stringify(options.packageJson ?? { name, type: 'module', dependencies: { '@guren/inertia-client': '*' } }),
    'bunfig.toml': '[install]\nauto = "disable"\n',
    'db/schema.ts': SCHEMAS[dialect],
    'app/Models/Post.ts': model('Post', 'posts'),
    'app/Models/Tag.ts': model('Tag', 'tags'),
    [PLAN_FILE]: JSON.stringify(document),
    ...options.files,
  })
  if (options.link) {
    await linkWorkspaceCore(dir)
    await symlink(WORKSPACE_DRIZZLE, join(dir, 'node_modules', 'drizzle-orm'), 'dir')
    await symlink(WORKSPACE_ORM, join(dir, 'node_modules', '@guren', 'orm'), 'dir')
  }
  const plan = join(dir, PLAN_FILE)
  if (options.approve !== false && 'baseline' in document) await approvePlanFile(plan)
  const mark = options.mark === undefined ? STEP : options.mark
  if (mark !== null) await writePlanActiveStep(dir, 'widgets', { plan: PLAN_FILE, step: mark, startedAt: '2026-09-25T00:00:00.000Z', continuations: 0 })
  return { dir, plan }
}

/** `plan:status`'s own reading of the app, the one `plan:verify` judges a step by. */
async function statusOf(dir: string, plan: string): Promise<PlanStatus> {
  return judgePlan(parsePlanDocument(JSON.parse(await readFile(plan, 'utf8'))), await loadPlanAppState(dir, { detail: true }))
}

/** Every planned property of the elements that does not read `match`, as `<id> <property>`. */
function unmatched(status: PlanStatus, ids: readonly string[]): string[] {
  return status.elements
    .filter((element) => ids.includes(element.id))
    .flatMap((element) => element.properties.filter((property) => property.verdict !== 'match').map((property) => `${element.id} ${property.property}`))
}

async function refusal(work: () => Promise<unknown>): Promise<string> {
  try {
    await work()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('the run was not refused')
}

describe('plan:scaffold', () => {
  beforeAll(async () => {
    ROOT = await createTempRoot('guren-plan-scaffold-')
  })

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true })
  })

  describe('round trip through the plan:status readers', () => {
    const DIALECTS = ['pg', 'mysql', 'sqlite'] as const
    const runs = new Map<SchemaDialect, { dir: string; plan: string; report: PlanScaffoldReport }>()

    beforeAll(async () => {
      for (const dialect of DIALECTS) {
        const { dir, plan } = await createApp(`round-${dialect}`, { dialect, link: true })
        runs.set(dialect, { dir, plan, report: await planScaffoldFile(plan, { appRoot: dir, step: STEP }) })
      }
    })

    for (const dialect of DIALECTS) {
      test(`should write a ${dialect} table and model every planned property reads back from, bar the readers' own limits`, async () => {
        const { dir, plan, report } = runs.get(dialect)!

        expect(report.created).toEqual(['app/Models/Widget.ts'])
        expect(report.appended).toEqual({ file: 'db/schema.ts', tables: ['widgets'] })
        expect(report.omitted).toEqual([])
        const widgets = (await readSchemaTables(dir)).tables.find((table) => table.identifier === 'widgets')
        // A static reading would pass for the wrong reason: the runtime one is what plan:verify judges by.
        expect(widgets?.source).toBe('runtime')
        const status = await statusOf(dir, plan)
        const written = status.elements.filter((element) => report.emitted.includes(element.id))
        expect(written.map((element) => [element.id, element.state])).toEqual(report.emitted.map((id) => [id, 'present']))
        expect(unmatched(status, report.emitted).sort()).toEqual([...READER_LIMITS[dialect]].sort())
      })
    }

    test('should write output that typechecks, in every dialect', () => {
      const dirs = DIALECTS.map((dialect) => runs.get(dialect)!.dir)
      const rootNames = dirs.flatMap((dir) => ['db/schema.ts', 'app/Models/Widget.ts', 'app/Models/Post.ts', 'app/Models/Tag.ts'].map((file) => join(dir, file)))
      expect(checkTypes(rootNames, renderedAppCompilerOptions(dirs[0]!))).toEqual([])
    }, TSC_TIMEOUT)

    test('should write the pg table and model byte for byte', async () => {
      const { dir } = runs.get('pg')!
      expect(await readFile(join(dir, 'db/schema.ts'), 'utf8')).toContain(`export const widgets = pgTable('widgets', {
  id: serial('id').primaryKey(),
  title: text('title').notNull().unique().default('untitled'),
  body: text('body'),
  count: integer('count').notNull().default(0),
  ratio: doublePrecision('ratio'),
  price: numeric('price', { precision: 10, scale: 2 }).notNull().default('0'),
  active: boolean('active').notNull().default(false),
  releasedOn: date('released_on'),
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb('meta'),
  token: uuid('token').notNull().unique(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  parentId: integer('parent_id'),
}, (table) => [
  index('widgets_count_index').on(table.count),
  index('widgets_post_id_index').on(table.postId),
  foreignKey({ columns: [table.parentId], foreignColumns: [table.id] }).onDelete('set null'),
  uniqueIndex('widgets_title_count_unique').on(table.title, table.count),
  index('widgets_ratio_active_index').on(table.ratio, table.active),
])`)
      expect(await readFile(join(dir, 'app/Models/Widget.ts'), 'utf8')).toBe(`import { defineModel, type BelongsToManyRecord, type BelongsToRecord, type HasManyRecord } from '@guren/core'
import { widgets, posts, tags, widgetTags } from '../../db/schema.js'

export type WidgetRecord = typeof widgets.$inferSelect
export type NewWidgetRecord = typeof widgets.$inferInsert
type PostRecord = typeof posts.$inferSelect
type TagRecord = typeof tags.$inferSelect

export class Widget extends defineModel(widgets, {
  fillable: ['title', 'body'],
}) {
  static override relationTypes: {
    post: BelongsToRecord<PostRecord>
    parent: BelongsToRecord<WidgetRecord>
    children: HasManyRecord<WidgetRecord>
    tags: BelongsToManyRecord<TagRecord>
  } = {
    post: null,
    parent: null,
    children: [],
    tags: [],
  }
}

Widget.belongsTo('post', () => import('./Post.js').then((module) => module.Post), 'postId', 'id')
Widget.belongsTo('parent', () => import('./Widget.js').then((module) => module.Widget), 'parentId', 'id')
Widget.hasMany('children', () => import('./Widget.js').then((module) => module.Widget), 'parentId', 'id')
Widget.belongsToMany('tags', () => import('./Tag.js').then((module) => module.Tag), widgetTags, 'widgetId', 'tagId', 'id', 'id')
`)
    })

    test('should write a composite primary key each of its columns reads back as in the key', async () => {
      const document = widgetsPlan()
      document.models = [{
        id: 'model.pin',
        change: { kind: 'add' },
        name: 'Pin',
        table: 'pins',
        columns: [column('pin', 'boardId', 'integer', { primaryKey: true }), column('pin', 'noteId', 'integer', { primaryKey: true })],
        relationships: [],
        fillable: [],
      }]
      const { dir, plan } = await createApp('composite', { document: approve(document), mark: 'task/entity/model.pin/scaffold', link: true })

      await planScaffoldFile(plan, { appRoot: dir, step: 'task/entity/model.pin/scaffold' })

      expect(await readFile(join(dir, 'db/schema.ts'), 'utf8')).toContain('primaryKey({ columns: [table.boardId, table.noteId] })')
      expect(unmatched(await statusOf(dir, plan), ['model.pin', 'column.pin.boardId', 'column.pin.noteId'])).toEqual([])
    })
  })

  describe('refusals, each with nothing written', () => {
    async function refusedWithNothingWritten(name: string, options: AppOptions, step = STEP): Promise<string> {
      const { dir, plan } = await createApp(name, options)
      const before = await snapshotTree(dir)
      const message = await refusal(() => planScaffoldFile(plan, { appRoot: dir, step }))
      expect(await snapshotTree(dir)).toEqual(before)
      expect(message).toContain('Nothing was scaffolded.')
      return message
    }

    test('should refuse a draft, which plan:next still hands the step out for', async () => {
      const message = await refusedWithNothingWritten('draft', { document: widgetsPlan() })
      expect(message).toContain(`${PLAN_FILE} is a draft: plan:scaffold writes code from an approved plan only.`)
    })

    test('should refuse a plan no approval names, as the other gated commands do', async () => {
      const { dir, plan } = await createApp('unapproved', { approve: false })
      const message = await refusal(() => planScaffoldFile(plan, { appRoot: dir, step: STEP }))
      expect(message).toContain('is not approved at its current hash')
      expect(message).toContain('nothing is scaffolded from it')
    })

    test('should refuse another step kind and name the task’s scaffold step', async () => {
      const message = await refusedWithNothingWritten('wrong-kind', { mark: 'task/entity/model.widget/data' }, 'task/entity/model.widget/data')
      expect(message).toContain('task/entity/model.widget/data is a data step, and plan:scaffold writes a scaffold step only. The scaffold step of task/entity/model.widget is task/entity/model.widget/scaffold.')
    })

    test('should refuse a step the plan does not derive and list its scaffold steps', async () => {
      const message = await refusedWithNothingWritten('no-step', { mark: 'task/entity/model.gadget/scaffold' }, 'task/entity/model.gadget/scaffold')
      expect(message).toContain(`task/entity/model.gadget/scaffold is no step of the plan, and plan:scaffold writes a scaffold step only. Its scaffold steps: ${STEP}.`)
    })

    test('should refuse a step plan:next has not marked, so the writes count as that step’s work', async () => {
      expect(await refusedWithNothingWritten('unmarked', { mark: null })).toContain(`${STEP} is not the step plan:next marked. Run guren plan:next`)
      expect(await refusedWithNothingWritten('other-mark', { mark: 'task/entity/model.widget/data' })).toContain('(it marked task/entity/model.widget/data)')
    })

    test('should refuse a model in a module: v1 writes to the project root only', async () => {
      const document = widgetsPlan()
      document.models[3]!.module = 'billing'
      const message = await refusedWithNothingWritten('module', { document: approve(document) })
      expect(message).toContain('model.widget sits in module "billing": plan:scaffold writes to the project root only.')
    })

    test('should refuse an API-only application', async () => {
      const message = await refusedWithNothingWritten('api-only', { packageJson: { name: 'api', type: 'module', dependencies: { '@guren/core': '*' } } })
      expect(message).toContain('This application is API-only, so its plans have no scaffold step')
    })

    test('should refuse every target already there, before writing any of the others', async () => {
      const message = await refusedWithNothingWritten('in-the-way', { files: { 'app/Models/Widget.ts': 'export const hand = 1\n' } })
      expect(message).toContain('app/Models/Widget.ts already exists.')
      expect(message).toContain('model.widget: the application already declares a Widget model.')
    })

    test('should refuse a table name another app root declares', async () => {
      const message = await refusedWithNothingWritten('module-table', {
        files: {
          'modules/billing/index.ts': "import { defineModule } from '@guren/core'\n\nexport default defineModule({ name: 'billing', providers: [] })\n",
          'modules/billing/db/schema.ts': "import { pgTable, serial } from '@guren/orm/drizzle/pg'\n\nexport const widgets = pgTable('widgets', {\n  id: serial('id').primaryKey(),\n})\n",
        },
      })
      expect(message).toContain('model.widget: modules/billing/db/schema.ts already declares the table widgets.')
    })

    test('should refuse a foreign key to a table the schema does not declare yet', async () => {
      const document = widgetsPlan()
      document.models[3]!.columns.push(column('widget', 'gadgetId', 'integer', { references: { model: 'model.gadget', column: 'id' } }))
      document.models.push({ id: 'model.gadget', change: { kind: 'add' }, name: 'Gadget', table: 'gadgets', columns: [column('gadget', 'id', 'integer', { primaryKey: true })], relationships: [], fillable: [] })
      const message = await refusedWithNothingWritten('fk-missing', { document: approve(document) })
      expect(message).toContain('model.widget.gadgetId references model.gadget.id, whose table gadgets db/schema.ts does not declare yet.')
    })

    test('should refuse a MySQL key on a text or json column, which drizzle-kit and MySQL reject, and name the fix', async () => {
      const document = widgetsPlan()
      const widget = document.models[3]!
      widget.columns.push(column('widget', 'summary', 'text', { unique: true }), column('widget', 'extra', 'json', { index: true }))
      widget.indexes = [{ columns: ['title', 'summary'], unique: false }]
      const message = await refusedWithNothingWritten('mysql-text-key', { dialect: 'mysql', document: approve(document) })
      expect(message).toContain('column.widget.summary is a text column planned unique.')
      expect(message).toContain('column.widget.extra is a json column planned index.')
      expect(message).toContain("model.widget's index (title, summary) covers the text column summary.")
      expect(message).toContain('Plan the column as `string` (varchar(255)), or drop the key (plan:revise).')
      // The same plan on pg keys a text column fine.
      expect(emitWidgets(document, 'pg').refusals).toEqual([])
    })

    test('should refuse a null default, which a nullable column without one already has', async () => {
      const document = widgetsPlan()
      document.models[3]!.columns.push(column('widget', 'note', 'text', { nullable: true, default: 'null' }))
      const message = await refusedWithNothingWritten('null-default', { document: approve(document) })
      expect(message).toContain('column.widget.note plans default null')
    })

    test('should refuse a re-run of a scaffolded step on the targets it wrote, leaving them as written', async () => {
      const { dir, plan } = await createApp('rerun')
      await planScaffoldFile(plan, { appRoot: dir, step: STEP })
      const before = await snapshotTree(dir)

      const message = await refusal(() => planScaffoldFile(plan, { appRoot: dir, step: STEP }))

      expect(await snapshotTree(dir)).toEqual(before)
      expect(message).toContain('app/Models/Widget.ts already exists.')
      expect(message).toContain('model.widget: db/schema.ts already exports widgets.')
      expect(message).toContain('If this step was scaffolded before, it has nothing left to write: run guren plan:verify for it.')
    })
  })

  // A read-only directory stops the model write after the schema's; uid 0 writes through it.
  test.skipIf(process.getuid?.() === 0)('should name what is already written when a write fails part way', async () => {
    const { dir, plan } = await createApp('partial')
    await mkdir(join(dir, 'app/Models'), { recursive: true })
    await chmod(join(dir, 'app/Models'), 0o555)
    try {
      const message = await refusal(() => planScaffoldFile(plan, { appRoot: dir, step: STEP }))
      expect(message).toContain(`plan:scaffold stopped part way through ${STEP}:`)
      expect(message).toContain('Already written: db/schema.ts. The step is half scaffolded')
      expect(message).not.toContain('Nothing was scaffolded.')
      expect(await readFile(join(dir, 'db/schema.ts'), 'utf8')).toContain("export const widgets = pgTable('widgets'")
    } finally {
      await chmod(join(dir, 'app/Models'), 0o755)
    }
  })

  test('should leave out a relationship whose target has no model yet, and say the model reads drifted until it is added', async () => {
    const document = widgetsPlan()
    document.models[3]!.relationships.push({ name: 'gadgets', type: 'hasMany', target: 'model.gadget' })
    document.models.push({
      id: 'model.gadget',
      change: { kind: 'add' },
      name: 'Gadget',
      table: 'gadgets',
      columns: [column('gadget', 'id', 'integer', { primaryKey: true }), column('gadget', 'widgetId', 'integer', { references: { model: 'model.widget', column: 'id' } })],
      relationships: [],
      fillable: [],
    })
    const { dir, plan } = await createApp('omitted', { document: approve(document), link: true })

    const report = await planScaffoldFile(plan, { appRoot: dir, step: STEP })

    expect(report.omitted).toEqual([{ model: 'model.widget', relationship: 'gadgets', reason: 'the application has no Gadget model yet' }])
    expect(await readFile(join(dir, 'app/Models/Widget.ts'), 'utf8')).not.toContain("'gadgets'")
    const text = formatPlanScaffold(report, PLAN_FILE)
    expect(text).toContain('until then plan:status reads the model as drifted:')
    expect(text).toContain('  model.widget gadgets: the application has no Gadget model yet')
    expect((await statusOf(dir, plan)).elements.find((element) => element.id === 'model.widget')?.state).toBe('drifted')
  })

  test('should write a string default with a line break or a line separator as a valid literal', () => {
    const document = widgetsPlan()
    document.models[3]!.columns.push(column('widget', 'motto', 'string', { default: "'one\ntwo three'" }))
    const output = emitWidgets(document, 'pg')

    const table = output.tables[0]!.block
    expect(table).toContain("motto: text('motto').notNull().default('one\\ntwo\\u2028three'),")
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(table)).not.toThrow()
  })

  test('should list the step’s generates it does not write, for the http step, and no page', () => {
    const plan = loadParsedCommentsPlan()
    const { step } = findPlanStep(derivePlanTasks(plan), 'task/entity/model.comment/scaffold')!
    const output = emitPlanScaffold(plan, step, { dialect: 'pg', tables: [{ identifier: 'posts', tableName: 'posts', module: null, columns: ['id'] }], models: ['Post'] })

    expect(output.refusals).toEqual([])
    expect(output.emitted).toEqual(['model.comment', 'column.comment.id', 'column.comment.body', 'column.comment.postId', 'column.comment.createdAt'])
    expect(output.left.map((element) => element.section)).toEqual(['validators', 'controllers', 'actions', 'actions', 'routes', 'routes', 'resources', 'policies'])
  })

  test('should print the report as JSON through the registered command', async () => {
    const { dir, plan } = await createApp('json')
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runCommand(builtinSubCommands['plan:scaffold'] as CommandDef, { rawArgs: [plan, '--step', STEP, '--app', dir, '--json'] })
      const report = JSON.parse(String(log.mock.calls[0]![0])) as PlanScaffoldReport
      expect(Object.keys(report).sort()).toEqual(['appended', 'created', 'emitted', 'left', 'omitted', 'plan', 'reportVersion', 'step'])
      expect(report).toMatchObject({ reportVersion: 1, step: STEP, plan: { file: PLAN_FILE, title: 'Widgets' }, created: ['app/Models/Widget.ts'] })
      expect(report.plan.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      log.mockRestore()
    }
  })
})

/** The emitter alone, over the fixture schema's tables and models. */
function emitWidgets(document: WidgetsPlan, dialect: SchemaDialect): PlanScaffoldOutput {
  const plan = parsePlanDocument(approve(document))
  const { step } = findPlanStep(derivePlanTasks(plan), STEP)!
  const tables = ['posts', 'tags'].map((table) => ({ identifier: table, tableName: table, module: null, columns: ['id'] }))
  return emitPlanScaffold(plan, step, {
    dialect,
    tables: [...tables, { identifier: 'widgetTags', tableName: 'widget_tags', module: null, columns: ['widgetId', 'tagId'] }],
    models: ['Post', 'Tag'],
  })
}
