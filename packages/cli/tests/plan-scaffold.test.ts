import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { chmod, mkdir, readFile, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { runCommand, type CommandDef } from 'citty'

import type { CheckResult } from '../src/check-result'
import { runCheck } from '../src/check'
import { builtinSubCommands } from '../src/commands'
import { runGate, type GateStageResult } from '../src/gate'
import type { Introspection } from '../src/introspect'
import { buildJobSource } from '../src/make-job'
import { buildListenerSource } from '../src/make-listener'
import { formatPlanScaffold, formatPlanScaffoldMount, planScaffoldFile, planScaffoldMountFile, type PlanScaffoldMountReport, type PlanScaffoldStepReport } from '../src/plan-scaffold'
import { parsePlanDocument } from '../src/plan-render'
import { loadPlanAppState } from '../src/plan/app-state'
import { emitPlanScaffold, planScaffoldMounts, type PlanScaffoldApp, type PlanScaffoldOutput } from '../src/plan/scaffold'
import { PLAN_VERSION } from '../src/plan/schema'
import { planDigest } from '../src/plan/identity'
import { writePlanActiveStep, writePlanStepRecord, type PlanStepRecord } from '../src/plan/state'
import { judgePlan, type PlanStatus } from '../src/plan/status'
import { derivePlanTasks, findPlanStep } from '../src/plan/tasks'
import { affectsRouteWiring } from '../src/routes-check'
import { readSchemaTables } from '../src/schema-runtime'
import type { SchemaDialect } from '../src/schema-parser'
import { checkTypes, createTempRoot, linkWorkspaceCore, renderedAppCompilerOptions, snapshotTree, TSC_TIMEOUT, writeWorkspaceFiles } from './helpers'
import { approvedAgainst, approvePlanFile, loadParsedCommentsPlan, refusal, type PlanInput } from './plan-fixture'

// A temp app resolves `drizzle-orm` from Bun's global cache or not at all, so each one links
// the copy `@guren/orm` pins, and the barrel the emitted schema imports, as schema-runtime.test.ts does.
const WORKSPACE_DRIZZLE = resolve(import.meta.dir, '../../orm/node_modules/drizzle-orm')
const WORKSPACE_ORM = resolve(import.meta.dir, '../../orm')
// plan:status imports the validator file, which imports zod.
const WORKSPACE_ZOD = resolve(import.meta.dir, '../node_modules/zod')

const STEP = 'task/entity/model.widget/scaffold'
const PLAN_FILE = 'widgets.plan.json'

let ROOT: string

type ModelInput = NonNullable<PlanInput['models']>[number]
type ColumnInput = ModelInput['columns'][number]
type ValidatorInput = NonNullable<PlanInput['validators']>[number]
type ResourceInput = NonNullable<PlanInput['resources']>[number]
type PolicyInput = NonNullable<PlanInput['policies']>[number]
type WidgetsPlan = PlanInput & { models: ModelInput[]; validators: ValidatorInput[]; resources: ResourceInput[]; policies: PolicyInput[] }

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
    validators: [
      {
        id: 'validator.widget',
        change: { kind: 'add' },
        name: 'WidgetPayloadSchema',
        fields: [
          { name: 'title', type: 'string', required: true, rules: ['min 1', 'max 120'] },
          { name: 'body', type: 'text', required: false, rules: ['max 2000'] },
          { name: 'count', type: 'integer', required: true, rules: ['min 0', 'max 100'] },
          { name: 'ratio', type: 'number', required: false, rules: ['min 0.5'] },
          { name: 'price', type: 'decimal', required: true, rules: ['min 0'] },
          { name: 'active', type: 'boolean', required: true, rules: [] },
          { name: 'releasedOn', type: 'date', required: false, rules: [] },
          { name: 'publishedAt', type: 'datetime', required: true, rules: [] },
          { name: 'meta', type: 'json', required: false, rules: [] },
          { name: 'token', type: 'uuid', required: true, rules: ['uuid'] },
          { name: 'contact', type: 'string', required: true, rules: ['email', 'max 255'] },
          { name: 'site', type: 'string', required: false, rules: ['url'] },
          { name: 'ref', type: 'string', required: true, rules: ['uuid'] },
        ],
      },
      {
        id: 'validator.widgetQuery',
        change: { kind: 'add' },
        name: 'WidgetListQuerySchema',
        fields: [
          { name: 'page', type: 'integer', required: false, rules: ['min 1'] },
          { name: 'perPage', type: 'integer', required: true, rules: ['max 50'] },
          { name: 'archived', type: 'boolean', required: false, rules: [] },
        ],
      },
    ],
    controllers: [
      {
        id: 'controller.widget',
        change: { kind: 'add' },
        className: 'WidgetController',
        actions: [
          {
            id: 'action.widget.index',
            change: { kind: 'add' },
            name: 'index',
            query: 'validator.widgetQuery',
            authorization: { middleware: [] },
            response: { kind: 'resource', resource: 'resource.widget' },
            rules: [],
          },
          {
            id: 'action.widget.store',
            change: { kind: 'add' },
            name: 'store',
            body: 'validator.widget',
            authorization: { middleware: ['auth'] },
            response: { kind: 'redirect', to: '/posts/:postId' },
            rules: ['The widget belongs to the post\nin the path.'],
          },
          {
            id: 'action.widget.destroy',
            change: { kind: 'add' },
            name: 'destroy',
            authorization: { middleware: ['auth'], policy: { id: 'policy.widget', ability: 'delete' } },
            response: { kind: 'empty' },
            rules: [],
          },
        ],
      },
    ],
    routes: [
      {
        id: 'route.widgets.index',
        change: { kind: 'add' },
        method: 'GET',
        path: '/widgets',
        name: 'widgets.index',
        action: 'action.widget.index',
        middleware: [],
        bind: [],
        agent: { toolName: 'widgets_index', readOnly: true },
      },
      {
        id: 'route.widgets.store',
        change: { kind: 'add' },
        method: 'POST',
        path: '/posts/:postId/widgets',
        name: 'widgets.store',
        action: 'action.widget.store',
        middleware: ['auth'],
        bind: [{ param: 'postId', model: 'model.post', key: 'id' }],
      },
      {
        id: 'route.widgets.destroy',
        change: { kind: 'add' },
        method: 'DELETE',
        path: '/widgets/:id',
        name: 'widgets.destroy',
        action: 'action.widget.destroy',
        middleware: ['auth'],
        bind: [{ param: 'id', model: 'model.widget' }],
      },
    ],
    sideEffects: [
      { id: 'job.widgetDigest', change: { kind: 'add' }, kind: 'job', name: 'WidgetDigest', trigger: 'Every night.', description: 'Mails each owner a digest of their widgets.' },
      { id: 'event.widgetPublished', change: { kind: 'add' }, kind: 'event', name: 'WidgetPublished', trigger: 'A widget is stored.', description: 'Announces a new widget.' },
      { id: 'listener.widgetAudit', change: { kind: 'add' }, kind: 'listener', name: 'WidgetAudit', trigger: 'WidgetPublished.', description: 'Writes an audit row.' },
      { id: 'mail.widgetShared', change: { kind: 'add' }, kind: 'mail', name: 'WidgetShared', trigger: 'A widget is shared.', description: 'Tells the recipient.' },
      { id: 'notification.widgetFlagged', change: { kind: 'add' }, kind: 'notification', name: 'WidgetFlagged', trigger: 'A widget is flagged.', description: 'Tells the owner.' },
    ],
    resources: [
      {
        id: 'resource.widget',
        change: { kind: 'add' },
        name: 'WidgetResource',
        model: 'model.widget',
        fields: [
          { name: 'id', type: 'number' },
          { name: 'title', type: 'string' },
          { name: 'body', type: 'string | null' },
          { name: 'count', type: 'number | null' },
          { name: 'meta', type: 'Record<string, unknown> | null' },
          { name: 'price', type: 'string' },
          { name: 'active', type: 'boolean' },
          { name: 'releasedOn', type: 'string | null' },
          { name: 'publishedAt', type: 'string' },
          { name: 'token', type: 'string' },
          { name: 'tags', type: 'string[]' },
        ],
      },
    ],
    policies: [
      {
        id: 'policy.widget',
        change: { kind: 'add' },
        name: 'WidgetPolicy',
        model: 'model.widget',
        abilities: [
          { name: 'update', rule: 'The signed-in user owns the widget.' },
          { name: 'delete', rule: 'Only an admin,\nor the owner.' },
        ],
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

const APP_ENTRY = `import { createApp } from '@guren/core'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [],
})

export default app
`

const WEB_ROUTES = `import type { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/', (c) => c.text('ok')).name('home')
}
`

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

/**
 * Where the validator and policy readers stop, in every dialect. The judge calls no validated
 * value a `decimal` (a string or a number may hold one); `json` is a record, a node outside the
 * field reader's zod allowlist; an ability's rule is prose, which nothing compares.
 */
const HTTP_READER_LIMITS = [
  // A query value arrives as text, so it is coerced, and a coerced number takes `null` as 0.
  'validator.widgetQuery field perPage required',
  'validator.widget field price type',
  'validator.widget field meta type',
  'validator.widget field meta required',
  'policy.widget ability update rule',
  'policy.widget ability delete rule',
]

const HTTP_ELEMENTS = ['validator.widget', 'validator.widgetQuery', 'resource.widget', 'policy.widget']

/**
 * Where the action reader stops: a stub writes no response, since the reader credits the one it
 * names (a resource by mention, a page, a redirect) and none has been written. An empty response
 * has no property. A binding's lookup column is not read.
 */
const ACTION_READER_LIMITS = ['action.widget.index response resource', 'action.widget.store response']
const MOUNTED_READER_LIMITS = [...ACTION_READER_LIMITS, 'route.widgets.store bind postId key']

const ROUTES = ['route.widgets.index', 'route.widgets.store', 'route.widgets.destroy']
const ACTIONS = ['action.widget.index', 'action.widget.store', 'action.widget.destroy']
const SIDE_EFFECTS = ['job.widgetDigest', 'event.widgetPublished', 'listener.widgetAudit', 'mail.widgetShared', 'notification.widgetFlagged']
/** The http part holding the routes, which mounts them: side effects push the step past five files. */
const MOUNT_STEP = 'task/entity/model.widget/http/1'

const CREATED = [
  'app/Models/Widget.ts',
  'app/Http/Validators/WidgetValidator.ts',
  'app/Http/Resources/WidgetResource.ts',
  'app/Policies/WidgetPolicy.ts',
  'app/Providers/WidgetPolicyProvider.ts',
  'app/Http/Controllers/WidgetController.ts',
  'routes/widgets.ts',
  'app/Jobs/WidgetDigest.ts',
  'app/Events/WidgetPublished.ts',
  'app/Listeners/WidgetAudit.ts',
  'app/Mail/WidgetShared.ts',
  'app/Notifications/WidgetFlagged.ts',
]

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
  /** `routes/web.ts`; `null` writes none. */
  webRoutes?: null
  /** `src/app.ts`; `null` writes none. */
  entry?: string | null
}

async function createApp(name: string, options: AppOptions = {}): Promise<{ dir: string; plan: string }> {
  const dir = join(ROOT, name)
  const dialect = options.dialect ?? 'pg'
  const document = options.document ?? approve(widgetsPlan())
  await writeWorkspaceFiles(dir, {
    'package.json': JSON.stringify(options.packageJson ?? { name, type: 'module', dependencies: { '@guren/inertia-client': '*' } }),
    'bunfig.toml': '[install]\nauto = "disable"\n',
    ...(options.entry === null ? {} : { 'src/app.ts': options.entry ?? APP_ENTRY }),
    ...(options.webRoutes === null ? {} : { 'routes/web.ts': WEB_ROUTES }),
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
    await symlink(WORKSPACE_ZOD, join(dir, 'node_modules', 'zod'), 'dir')
  }
  const plan = join(dir, PLAN_FILE)
  if (options.approve !== false && 'baseline' in document) await approvePlanFile(plan)
  const marked = options.mark === undefined ? STEP : options.mark
  if (marked !== null) await mark(dir, marked)
  return { dir, plan }
}

/** `plan:status`'s own reading of the app, the one `plan:verify` judges a step by. */
/** A verified run of a step, as `plan:verify` records it, against the plan `digest` names. */
function verifiedRecord(digest: string): PlanStepRecord {
  return {
    outcome: 'verified',
    planDigest: digest,
    ranAt: '2026-09-25T00:00:00.000Z',
    durationMs: 1,
    commands: [],
    acceptance: [],
    incomplete: [],
    waived: [],
    fingerprint: { files: {}, environment: { runtime: 'bun', platform: 'darwin', arch: 'arm64', hostname: 'test' } },
  }
}

/** A scaffold step's report, which carries the tables, providers and routes file a tests step's does not. */
async function scaffoldStep(plan: string, dir: string): Promise<PlanScaffoldStepReport> {
  const report = await planScaffoldFile(plan, { appRoot: dir, step: STEP })
  if (report.kind !== 'scaffold') throw new Error(`${STEP} was written as a ${report.kind} step`)
  return report
}

/** What `plan:next` writes when it hands a step out. */
function mark(dir: string, step: string): Promise<string> {
  return writePlanActiveStep(dir, 'widgets', { plan: PLAN_FILE, step, startedAt: '2026-09-25T00:00:00.000Z', continuations: 0 })
}

async function statusOf(dir: string, plan: string): Promise<PlanStatus> {
  return judgePlan(parsePlanDocument(JSON.parse(await readFile(plan, 'utf8'))), await loadPlanAppState(dir, { detail: true }))
}

/** Every planned property of the elements that does not read `match`, as `<id> <property>`. */
function unmatched(status: PlanStatus, ids: readonly string[]): string[] {
  return status.elements
    .filter((element) => ids.includes(element.id))
    .flatMap((element) => element.properties.filter((property) => property.verdict !== 'match').map((property) => `${element.id} ${property.property}`))
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
    const runs = new Map<SchemaDialect, { dir: string; plan: string; report: PlanScaffoldStepReport }>()
    // Bun caches a routes file by path for the process, so a mounted app is one whose routes nothing read before the mount.
    const mounted = new Map<SchemaDialect, { dir: string; plan: string; report: PlanScaffoldMountReport }>()

    beforeAll(async () => {
      for (const dialect of DIALECTS) {
        const { dir, plan } = await createApp(`round-${dialect}`, { dialect, link: true })
        runs.set(dialect, { dir, plan, report: await scaffoldStep(plan, dir) })
        const app = await createApp(`mounted-${dialect}`, { dialect, link: true })
        await planScaffoldFile(app.plan, { appRoot: app.dir, step: STEP })
        await mark(app.dir, MOUNT_STEP)
        mounted.set(dialect, { ...app, report: await planScaffoldMountFile(app.plan, { appRoot: app.dir, step: MOUNT_STEP }) })
      }
    })

    for (const dialect of DIALECTS) {
      test(`should write a ${dialect} table, model, controller and side effects every planned property reads back from, bar the readers' own limits`, async () => {
        const { dir, plan, report } = runs.get(dialect)!

        expect(report.created).toEqual(CREATED)
        expect(report.appended).toEqual({ file: 'db/schema.ts', tables: ['widgets'] })
        expect(report.registered).toEqual({ file: 'src/app.ts', providers: ['WidgetPolicyProvider'] })
        expect(report.unmounted).toEqual({ file: 'routes/widgets.ts', registrar: 'registerWidgetRoutes', step: MOUNT_STEP })
        expect(report.omitted).toEqual([])
        expect(report.left).toEqual([])
        const widgets = (await readSchemaTables(dir)).tables.find((table) => table.identifier === 'widgets')
        // A static reading would pass for the wrong reason: the runtime one is what plan:verify judges by.
        expect(widgets?.source).toBe('runtime')
        const status = await statusOf(dir, plan)
        const written = status.elements.filter((element) => report.emitted.includes(element.id))
        // The route reader reads registered routes, and an unmounted file registers none.
        expect(written.map((element) => [element.id, element.state])).toEqual(report.emitted.map((id) => [id, ROUTES.includes(id) ? 'planned' : 'present']))
        expect(report.emitted).toEqual(expect.arrayContaining([...HTTP_ELEMENTS, 'controller.widget', ...ACTIONS, ...ROUTES, ...SIDE_EFFECTS]))
        expect(unmatched(status, report.emitted).sort()).toEqual([...READER_LIMITS[dialect], ...HTTP_READER_LIMITS, ...ACTION_READER_LIMITS].sort())
      })

      test(`should read the ${dialect} routes, actions and validators wired once --mount calls the routes file, bar the readers' own limits`, async () => {
        const { dir, plan, report } = mounted.get(dialect)!

        expect(report.mounted).toEqual({ file: 'routes/widgets.ts', registrar: 'registerWidgetRoutes', entry: 'routes/web.ts' })
        const status = await statusOf(dir, plan)
        const wired = [...HTTP_ELEMENTS.slice(0, 2), ...ACTIONS, ...ROUTES]
        expect(status.elements.filter((element) => wired.includes(element.id)).map((element) => [element.id, element.state])).toEqual(wired.map((id) => [id, 'wired']))
        expect(unmatched(status, [...ACTIONS, ...ROUTES]).sort()).toEqual(MOUNTED_READER_LIMITS.sort())
        // A side effect is wired by a dispatch, which is the http step's to write.
        expect(status.elements.filter((element) => SIDE_EFFECTS.includes(element.id)).map((element) => element.state)).toEqual(SIDE_EFFECTS.map(() => 'present'))
      })
    }

    test('should leave a scaffolded validator present until its route is mounted, which the http step does', async () => {
      const { dir, plan } = runs.get('pg')!
      const validator = (await statusOf(dir, plan)).elements.find((element) => element.id === 'validator.widget')!

      expect(validator.completesAt).toBe('wired')
      expect(validator.state).toBe('present')
      expect(validator.notes.join(' ')).toContain('WidgetController.store validates with it, and no registered route dispatches to WidgetController.store')
    })

    // The provider's registration is not read: status gives a policy no mount, so it completes at
    // `present`, and reading one would move every approved plan's policies to `wired`.
    test('should complete a scaffolded policy at present, on its abilities, whether or not a provider registers it', async () => {
      const { dir, plan } = runs.get('pg')!
      const read = async (): Promise<PlanStatus['elements'][number]> => (await statusOf(dir, plan)).elements.find((element) => element.id === 'policy.widget')!
      const policy = await read()

      expect(policy.completesAt).toBe('present')
      expect(policy.state).toBe('present')
      expect(policy.properties.map((property) => [property.property, property.verdict, property.existence === true])).toEqual([
        ['ability update', 'match', true],
        ['ability update rule', 'unknown', false],
        ['ability delete', 'match', true],
        ['ability delete rule', 'unknown', false],
      ])

      const entry = join(dir, 'src/app.ts')
      const registered = await readFile(entry, 'utf8')
      try {
        await Bun.write(entry, APP_ENTRY)
        expect(await read()).toEqual(policy)
      } finally {
        await Bun.write(entry, registered)
      }
    })

    // An unmounted routes file compiles because the actions validate with validateBody(), not validated('<route name>').
    test('should write output that typechecks, in every dialect, unmounted and mounted', () => {
      const dirs = DIALECTS.flatMap((dialect) => [runs.get(dialect)!.dir, mounted.get(dialect)!.dir])
      const rootNames = dirs.flatMap((dir) => ['db/schema.ts', 'app/Models/Post.ts', 'app/Models/Tag.ts', 'src/app.ts', 'routes/web.ts', ...CREATED].map((file) => join(dir, file)))
      expect(checkTypes(rootNames, renderedAppCompilerOptions(dirs[0]!))).toEqual([])
    }, TSC_TIMEOUT)

    test('should write the pg controller, routes file and mount byte for byte', async () => {
      const read = (dir: string, file: string): Promise<string> => readFile(join(dir, file), 'utf8')
      const { dir } = runs.get('pg')!
      expect(await read(dir, 'app/Http/Controllers/WidgetController.ts')).toMatchInlineSnapshot(`
        "import { Controller, HttpException } from '@guren/core'
        import { WidgetListQuerySchema, WidgetPayloadSchema } from '../Validators/WidgetValidator.js'
        import { Widget } from '../../Models/Widget.js'

        /**
         * Written by plan:scaffold: each action validates and authorizes as planned, then answers 501 until the http step writes it.
         */
        export default class WidgetController extends Controller {
          // Planned response: the resource WidgetResource
          async index(): Promise<Response> {
            this.validateQuery(WidgetListQuerySchema)
            throw HttpException.notImplemented('WidgetController.index is planned and not written yet')
          }

          // Planned response: a redirect to /posts/:postId
          // Rule: The widget belongs to the post in the path.
          async store(): Promise<Response> {
            await this.validateBody(WidgetPayloadSchema)
            throw HttpException.notImplemented('WidgetController.store is planned and not written yet')
          }

          // Planned response: no content
          async destroy(): Promise<Response> {
            await this.authorize('delete', Widget)
            throw HttpException.notImplemented('WidgetController.destroy is planned and not written yet')
          }
        }
        "
      `)
      expect(await read(dir, 'routes/widgets.ts')).toMatchInlineSnapshot(`
        "import { Router, requireAuthenticated } from '@guren/core'
        import WidgetController from '../app/Http/Controllers/WidgetController.js'
        import { WidgetListQuerySchema, WidgetPayloadSchema } from '../app/Http/Validators/WidgetValidator.js'
        import { Post } from '../app/Models/Post.js'
        import { Widget } from '../app/Models/Widget.js'

        /**
         * Written by plan:scaffold and not mounted: the http step mounts it with \`plan:scaffold --mount\`,
         * which calls it first in the entry registrar, so an auth alias the entry sets replaces the one here.
         */
        export function registerWidgetRoutes(router: Router): void {
          const authRouter = router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
          router.get('/widgets', { name: 'widgets.index', query: WidgetListQuerySchema, agent: { toolName: 'widgets_index', readOnlyHint: true } }, [WidgetController, 'index'])
          authRouter.post('/posts/:postId/widgets', { name: 'widgets.store', body: WidgetPayloadSchema, bind: { postId: [Post, 'id'] } }, [WidgetController, 'store']).middleware('auth')
          authRouter.delete('/widgets/:id', { name: 'widgets.destroy', bind: { id: Widget } }, [WidgetController, 'destroy']).middleware('auth')
        }
        "
      `)
      expect(await read(dir, 'routes/web.ts')).toBe(WEB_ROUTES)
      expect(await read(mounted.get('pg')!.dir, 'routes/web.ts')).toMatchInlineSnapshot(`
        "import type { Router } from '@guren/core'
        import { registerWidgetRoutes } from './widgets.js'

        export function registerWebRoutes(router: Router): void {
          registerWidgetRoutes(router)

          router.get('/', (c) => c.text('ok')).name('home')
        }
        "
      `)
      expect(await read(dir, 'app/Jobs/WidgetDigest.ts')).toBe(buildJobSource('WidgetDigest'))
      expect(await read(dir, 'app/Listeners/WidgetAudit.ts')).toBe(buildListenerSource('WidgetAudit'))
    })

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

    test('should write the pg validator, resource, policy, provider and registration byte for byte', async () => {
      const { dir } = runs.get('pg')!
      const read = (file: string): Promise<string> => readFile(join(dir, file), 'utf8')
      expect(await read('app/Http/Validators/WidgetValidator.ts')).toMatchInlineSnapshot(`
        "import { z } from 'zod'

        export const WidgetPayloadSchema = z.object({
          title: z.string().min(1).max(120),
          body: z.string().max(2000).nullable().optional(),
          count: z.number().int().min(0).max(100),
          ratio: z.number().min(0.5).nullable().optional(),
          price: z.number().min(0),
          active: z.boolean(),
          releasedOn: z.iso.date().nullable().optional(),
          publishedAt: z.iso.datetime(),
          meta: z.record(z.string(), z.any()).nullable().optional(),
          token: z.uuid(),
          contact: z.email().max(255),
          site: z.url().nullable().optional(),
          ref: z.uuid(),
        })

        export const WidgetListQuerySchema = z.object({
          page: z.coerce.number().int().min(1).nullable().optional(),
          perPage: z.coerce.number().int().max(50),
          archived: z.stringbool().nullable().optional(),
        })
        "
      `)
      expect(await read('app/Http/Resources/WidgetResource.ts')).toMatchInlineSnapshot(`
        "import { Resource } from '@guren/core'
        import type { WidgetRecord } from '../../Models/Widget.js'

        // plan:scaffold found no column to copy these fields from as they are planned: map each, then remove this.
        function unmapped(field: string): never {
          throw new Error(\`WidgetResource.toArray() does not map \${field} yet\`)
        }

        export interface WidgetResourceData extends Record<string, unknown> {
          id: number
          title: string
          body: string | null
          count: number | null
          meta: Record<string, unknown> | null
          price: string
          active: boolean
          releasedOn: string | null
          publishedAt: string
          token: string
          tags: string[]
        }

        export class WidgetResource extends Resource<WidgetRecord, WidgetResourceData> {
          toArray(): WidgetResourceData {
            return {
              id: this.resource.id,
              title: this.resource.title,
              body: this.resource.body,
              count: this.resource.count,
              meta: this.resource.meta as Record<string, unknown> | null,
              price: this.resource.price,
              active: this.resource.active,
              releasedOn: this.resource.releasedOn,
              publishedAt: this.resource.publishedAt.toISOString(),
              token: this.resource.token,
              tags: unmapped('tags'),
            }
          }
        }
        "
      `)
      expect(await read('app/Policies/WidgetPolicy.ts')).toMatchInlineSnapshot(`
        "import { Policy, type AuthUser } from '@guren/core'

        export class WidgetPolicy extends Policy {
          // Denied until written. Planned: The signed-in user owns the widget.
          update(_user: AuthUser | null): boolean {
            return false
          }

          // Denied until written. Planned: Only an admin, or the owner.
          delete(_user: AuthUser | null): boolean {
            return false
          }
        }
        "
      `)
      expect(await read('app/Providers/WidgetPolicyProvider.ts')).toMatchInlineSnapshot(`
        "import { ServiceProvider } from '@guren/core'
        import { Widget } from '../Models/Widget.js'
        import { WidgetPolicy } from '../Policies/WidgetPolicy.js'

        /** Registers WidgetPolicy with the gate for Widget records. */
        export default class WidgetPolicyProvider extends ServiceProvider {
          register(): void {}

          // The framework's own provider binds the gate during registration, so this
          // runs in boot(): make('gate') throws before that.
          boot(): void {
            this.container.make('gate').policy(Widget, WidgetPolicy)
          }
        }
        "
      `)
      expect(await read('src/app.ts')).toMatchInlineSnapshot(`
        "import { createApp } from '@guren/core'
        import { registerWebRoutes } from '../routes/web.js'
        import WidgetPolicyProvider from '../app/Providers/WidgetPolicyProvider.js'

        const app = createApp({
          routes: registerWebRoutes,
          providers: [WidgetPolicyProvider],
        })

        export default app
        "
      `)
    })

    test('should write the mysql resource’s date field through its Date column', async () => {
      expect(await readFile(join(runs.get('mysql')!.dir, 'app/Http/Resources/WidgetResource.ts'), 'utf8')).toContain('releasedOn: this.resource.releasedOn?.toISOString() ?? null,')
      expect(await readFile(join(runs.get('sqlite')!.dir, 'app/Http/Resources/WidgetResource.ts'), 'utf8')).toContain('releasedOn: this.resource.releasedOn,')
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

  describe('--mount from the http step', () => {
    /** An app whose scaffold step ran, marked at `step` for the mount. */
    async function scaffolded(name: string, options: AppOptions = {}, step = MOUNT_STEP): Promise<{ dir: string; plan: string }> {
      const app = await createApp(name, options)
      await planScaffoldFile(app.plan, { appRoot: app.dir, step: STEP })
      await mark(app.dir, step)
      return app
    }

    async function mountRefused(app: { dir: string; plan: string }, step = MOUNT_STEP): Promise<string> {
      const before = await snapshotTree(app.dir)
      const message = await refusal(() => planScaffoldMountFile(app.plan, { appRoot: app.dir, step }))
      expect(await snapshotTree(app.dir)).toEqual(before)
      expect(message).toEndWith('Nothing was mounted.')
      return message
    }

    test('should call the registrar first in the entry, print what is left, and run through the registered command', async () => {
      const app = await scaffolded('mount-command')
      const log = spyOn(console, 'log').mockImplementation(() => {})
      try {
        await runCommand(builtinSubCommands['plan:scaffold'] as CommandDef, { rawArgs: [app.plan, '--step', MOUNT_STEP, '--mount', '--app', app.dir, '--json'] })
        const report = JSON.parse(String(log.mock.calls[0]![0])) as PlanScaffoldMountReport
        expect(report).toMatchObject({ step: MOUNT_STEP, mounted: { file: 'routes/widgets.ts', registrar: 'registerWidgetRoutes', entry: 'routes/web.ts' } })
        expect(formatPlanScaffoldMount(report, PLAN_FILE)).toContain(`The controller actions still answer 501: write their bodies and responses, then run\n  bunx guren plan:verify ${PLAN_FILE} --step ${MOUNT_STEP}`)
      } finally {
        log.mockRestore()
      }
      const entry = await readFile(join(app.dir, 'routes/web.ts'), 'utf8')
      expect(entry.indexOf('registerWidgetRoutes(router)')).toBeLessThan(entry.indexOf("router.get('/'"))
    })

    test('should refuse a second mount, reading mounted as guren check reads it', async () => {
      const app = await scaffolded('mount-twice')
      await planScaffoldMountFile(app.plan, { appRoot: app.dir, step: MOUNT_STEP })
      expect(await mountRefused(app)).toContain('routes/widgets.ts is already mounted: routes/web.ts reaches registerWidgetRoutes.')
    })

    test('should refuse a file another routes file already mounts', async () => {
      const app = await scaffolded('mount-indirect')
      await Bun.write(join(app.dir, 'routes/web.ts'), WEB_ROUTES.replace('router.get(', 'registerAllRoutes(router)\n  router.get(').replace("import type { Router } from '@guren/core'", "import type { Router } from '@guren/core'\nimport { registerAllRoutes } from './all.js'"))
      await Bun.write(join(app.dir, 'routes/all.ts'), "import type { Router } from '@guren/core'\nimport { registerWidgetRoutes } from './widgets.js'\n\nexport function registerAllRoutes(router: Router): void {\n  registerWidgetRoutes(router)\n}\n")
      expect(await mountRefused(app)).toContain('routes/widgets.ts is already mounted')
    })

    test('should refuse a step that holds no scaffolded routes, and name the one that does', async () => {
      const app = await scaffolded('mount-wrong-step', {}, STEP)
      expect(await mountRefused(app, STEP)).toContain(`${STEP} is a scaffold step that mounts no routes file: --mount runs from the http step holding a scaffolded routes file: ${MOUNT_STEP} (routes/widgets.ts).`)
      await mark(app.dir, 'task/entity/model.widget/http/2')
      expect(await mountRefused(app, 'task/entity/model.widget/http/2')).toContain('task/entity/model.widget/http/2 is a http step that mounts no routes file')
    })

    test('should refuse a step plan:next has not marked, and a draft', async () => {
      expect(await mountRefused(await scaffolded('mount-unmarked', {}, STEP))).toContain(`${MOUNT_STEP} is not the step plan:next marked (it marked ${STEP}).`)
      const draft = await createApp('mount-draft', { document: widgetsPlan(), mark: MOUNT_STEP })
      expect(await mountRefused(draft)).toContain('widgets.plan.json is a draft: plan:scaffold writes code from an approved plan only.')
    })

    test('should refuse when there is nothing to mount, or the file no longer exports its registrar', async () => {
      expect(await mountRefused(await createApp('mount-nothing', { mark: MOUNT_STEP }))).toContain(`Nothing to mount: routes/widgets.ts does not exist. plan:scaffold ${join(ROOT, 'mount-nothing', PLAN_FILE)} --step ${STEP} writes it.`)
      const edited = await scaffolded('mount-edited')
      await Bun.write(join(edited.dir, 'routes/widgets.ts'), "export function registerRoutes(): void {}\n")
      expect(await mountRefused(edited)).toContain('routes/widgets.ts no longer exports registerWidgetRoutes, which --mount calls.')
    })

    test('should refuse an app with no routes entry, and an entry already binding the registrar’s name', async () => {
      expect(await mountRefused(await scaffolded('mount-no-entry', { webRoutes: null }))).toContain('This application has no routes entry (routes/web.ts) to call registerWidgetRoutes from.')
      const bound = await scaffolded('mount-bound')
      await Bun.write(join(bound.dir, 'routes/web.ts'), `import { registerWidgetRoutes } from './legacy.js'\n${WEB_ROUTES}`)
      expect(await mountRefused(bound)).toContain('routes/web.ts already declares or imports registerWidgetRoutes')
    })

    // An import of the same name would redeclare it, which does not compile, and the call would reach the local one.
    test('should refuse an entry declaring a function or const of the registrar’s name', async () => {
      for (const [name, declaration] of [['mount-local-function', 'function registerWidgetRoutes(): void {}'], ['mount-local-const', 'export const registerWidgetRoutes = (): void => {}']] as const) {
        const app = await scaffolded(name)
        await Bun.write(join(app.dir, 'routes/web.ts'), `${WEB_ROUTES}\n${declaration}\n`)
        expect(await mountRefused(app)).toContain('routes/web.ts already declares or imports registerWidgetRoutes')
      }
    })

    test('should refuse an entry whose default export is a function or class of the registrar’s name', async () => {
      for (const [name, declaration] of [['mount-default-function', 'export default function registerWidgetRoutes(): void {}'], ['mount-default-class', 'export default class registerWidgetRoutes {}']] as const) {
        const app = await scaffolded(name)
        await Bun.write(join(app.dir, 'routes/web.ts'), `${WEB_ROUTES}\n${declaration}\n`)
        expect(await mountRefused(app)).toContain('routes/web.ts already declares or imports registerWidgetRoutes')
      }
    })

    test('should refuse an entry binding the registrar’s name by destructuring', async () => {
      for (const [name, declaration] of [
        ['mount-destructured-object', 'const { registerWidgetRoutes } = { registerWidgetRoutes: (): void => {} }'],
        ['mount-destructured-array', 'const [registerWidgetRoutes] = [(): void => {}]'],
        ['mount-destructured-nested', 'const { routes: [{ fn: registerWidgetRoutes = (): void => {} }] } = { routes: [{ fn: undefined }] }'],
      ] as const) {
        const app = await scaffolded(name)
        await Bun.write(join(app.dir, 'routes/web.ts'), `${WEB_ROUTES}\n${declaration}\n`)
        expect(await mountRefused(app)).toContain('routes/web.ts already declares or imports registerWidgetRoutes')
      }
    })
  })

  describe('guren check on the routes file the scaffold wrote', () => {
    const KEY = 'route-registrar:routes/widgets.ts'

    async function wiring(dir: string, key = KEY): Promise<CheckResult | undefined> {
      return (await runCheck({ cwd: dir, introspect: false })).checks.find((result) => result.key === key)
    }

    /** What the gate's check stage feeds back: gating findings, and never an advisory one. */
    async function gateCheck(dir: string): Promise<GateStageResult> {
      const report = await runGate({ cwd: dir, exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }), introspect: async (): Promise<Introspection> => ({ status: 'failed', reason: 'no-entry', message: 'not introspected in this test' }) })
      return report.stages.find((stage) => stage.name === 'check')!
    }

    test('should count an unmounted scaffolded file as advisory while the http step is open, in check and in the gate', async () => {
      const { dir } = await createApp('check-open')
      await planScaffoldFile(join(dir, PLAN_FILE), { appRoot: dir, step: STEP })

      const result = await wiring(dir)
      expect(result).toMatchObject({ status: 'warn', advisory: true })
      expect(result!.message).toContain(`plan:scaffold wrote it for ${PLAN_FILE}, whose http step ${MOUNT_STEP} mounts it and is not verified yet`)
      expect(result!.suggestion).toBe(`The http step mounts it with bunx guren plan:scaffold ${PLAN_FILE} --step ${MOUNT_STEP} --mount.`)
      expect((await gateCheck(dir)).findings.join('\n')).not.toContain('routes/widgets.ts')
    })

    test('should count it again once the http step verifies, or the plan closes', async () => {
      const verified = await createApp('check-verified')
      await planScaffoldFile(verified.plan, { appRoot: verified.dir, step: STEP })
      const digest = planDigest(parsePlanDocument(JSON.parse(await readFile(verified.plan, 'utf8'))))
      await writePlanStepRecord(verified.dir, 'widgets', MOUNT_STEP, verifiedRecord(digest))
      expect(await wiring(verified.dir)).toMatchObject({ status: 'warn' })
      expect((await wiring(verified.dir))!.advisory).toBeUndefined()
      expect((await gateCheck(verified.dir)).findings.join('\n')).toContain('routes/widgets.ts wiring')

      // A record of another digest is a plan revised since: the step is open again.
      await writePlanStepRecord(verified.dir, 'widgets', MOUNT_STEP, verifiedRecord('another'))
      expect((await wiring(verified.dir))!.advisory).toBe(true)

      const closed = await createApp('check-closed')
      await planScaffoldFile(closed.plan, { appRoot: closed.dir, step: STEP })
      const hash = planDigest(parsePlanDocument(JSON.parse(await readFile(closed.plan, 'utf8'))))
      await Bun.write(join(closed.dir, 'docs/plans/widgets.md'), `---\ntype: plan\nclosed: true\nplan_hash: ${hash}\n---\n\n# Widgets\n`)
      expect((await wiring(closed.dir))!.advisory).toBeUndefined()
      expect((await gateCheck(closed.dir)).findings.join('\n')).toContain('routes/widgets.ts wiring')
    })

    test('should keep the warning for an unmounted file no open plan’s scaffold writes, and for an unapproved plan', async () => {
      const { dir } = await createApp('check-unrelated')
      await planScaffoldFile(join(dir, PLAN_FILE), { appRoot: dir, step: STEP })
      await Bun.write(join(dir, 'routes/admin.ts'), "import type { Router } from '@guren/core'\n\nexport function registerAdminRoutes(router: Router): void {\n  router.get('/admin', (c) => c.text('admin'))\n}\n")
      expect(await wiring(dir, 'route-registrar:routes/admin.ts')).toMatchObject({ status: 'warn' })
      expect((await wiring(dir, 'route-registrar:routes/admin.ts'))!.advisory).toBeUndefined()

      // The same file, with no approval naming the plan's hash: nobody approved the scaffold that would write it.
      await rm(join(dir, 'widgets.approvals.json'))
      expect((await wiring(dir))!.advisory).toBeUndefined()
    })

    const HAND_WRITTEN = "import type { Router } from '@guren/core'\n\nexport function registerHandRoutes(router: Router): void {\n  router.get('/hand', (c) => c.text('hand'))\n}\n"

    test('should keep the warning for a hand-written file at the scaffold’s path that exports another registrar', async () => {
      const { dir } = await createApp('check-hand-written', { files: { 'routes/widgets.ts': HAND_WRITTEN } })

      expect(await wiring(dir)).toMatchObject({ status: 'warn' })
      expect((await wiring(dir))!.advisory).toBeUndefined()
    })

    test('should keep the warning for a root file at the path of a module entity, which the scaffold refuses', async () => {
      const document = widgetsPlan()
      document.models[3]!.module = 'billing'
      const { dir } = await createApp('check-module-entity', { document: approve(document), files: { 'routes/widgets.ts': HAND_WRITTEN.replaceAll('registerHandRoutes', 'registerWidgetRoutes') } })

      expect(await wiring(dir)).toMatchObject({ status: 'warn' })
      expect((await wiring(dir))!.advisory).toBeUndefined()
    })

    test('should wake under --changed on a plan input, since closing or approving one moves the verdict', () => {
      expect(affectsRouteWiring('docs/plans/widgets.md')).toBe(true)
      expect(affectsRouteWiring('widgets.approvals.json')).toBe(true)
      expect(affectsRouteWiring('app/Models/Widget.ts')).toBe(false)
    })

    test('should read no schema or validator file to decide it, as plain check never does', async () => {
      // Linked, so an import of either file would resolve and run its first line.
      const { dir } = await createApp('check-cheap', { link: true })
      await planScaffoldFile(join(dir, PLAN_FILE), { appRoot: dir, step: STEP })
      const marker = (name: string): string => `await Bun.write(${JSON.stringify(join(dir, `imported-${name}`))}, '1')\n`
      for (const file of ['db/schema.ts', 'app/Http/Validators/WidgetValidator.ts']) {
        await Bun.write(join(dir, file), `${marker(file.replaceAll('/', '-'))}${await readFile(join(dir, file), 'utf8')}`)
      }

      expect((await wiring(dir))!.advisory).toBe(true)
      expect(await Array.fromAsync(new Bun.Glob('imported-*').scan(dir))).toEqual([])
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
      expect(message).toContain('task/entity/model.widget/data is a data step, and plan:scaffold writes a scaffold or tests step only. The scaffold step of task/entity/model.widget is task/entity/model.widget/scaffold.')
    })

    test('should refuse a step the plan does not derive and list its scaffold steps', async () => {
      const message = await refusedWithNothingWritten('no-step', { mark: 'task/entity/model.gadget/scaffold' }, 'task/entity/model.gadget/scaffold')
      expect(message).toContain(`task/entity/model.gadget/scaffold is no step of the plan, and plan:scaffold writes a scaffold or tests step only. Its scaffold steps: ${STEP}.`)
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
      const message = await refusedWithNothingWritten('api-only', { packageJson: { name: 'api', type: 'module', dependencies: { '@guren/core': '*' } }, webRoutes: null })
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
      widget.columns.push(
        column('widget', 'summary', 'text', { unique: true }),
        column('widget', 'extra', 'json', { index: true }),
        column('widget', 'code', 'text', { primaryKey: true }),
        column('widget', 'postRef', 'text', { references: { model: 'model.post', column: 'id' } }),
      )
      widget.indexes = [{ columns: ['title', 'summary'], unique: false }]
      const message = await refusedWithNothingWritten('mysql-text-key', { dialect: 'mysql', document: approve(document) })
      expect(message).toContain('column.widget.summary is a text column planned unique.')
      expect(message).toContain('column.widget.extra is a json column planned index.')
      expect(message).toContain('column.widget.code is a text column planned primary key.')
      expect(message).toContain('column.widget.postRef is a text column planned foreign key.')
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

    test('should refuse a validator name another validator file exports, and the file make:validator writes for the model', async () => {
      const message = await refusedWithNothingWritten('validator-taken', {
        files: {
          'app/Http/Validators/SharedValidator.ts': "import { z } from 'zod'\n\nexport const WidgetPayloadSchema = z.object({})\n",
          'app/Http/Validators/WidgetValidator.ts': "import { z } from 'zod'\n\nexport const WidgetIdParamSchema = z.object({})\n",
        },
      })
      expect(message).toContain('validator.widget: a validator file already exports WidgetPayloadSchema.')
      expect(message).toContain('app/Http/Validators/WidgetValidator.ts already exists.')
    })

    test('should refuse a validator file whose exports cannot all be read', async () => {
      const message = await refusedWithNothingWritten('validator-unreadable', {
        files: { 'app/Http/Validators/Barrelish.ts': "export * from './Elsewhere'\nexport const x = 1\n" },
      })
      expect(message).toContain('plan:scaffold cannot tell which schemas the validator files already export: app/Http/Validators/Barrelish.ts could not be read for its exports.')
    })

    test('should refuse a resource guren codegen would not discover, and a resource or policy class already declared', async () => {
      const document = widgetsPlan()
      document.resources[0]!.name = 'WidgetPayload'
      const renamed = await refusedWithNothingWritten('resource-name', { document: approve(document) })
      expect(renamed).toContain('resource.widget is named "WidgetPayload": guren codegen discovers a resource class by a PascalCase name ending in Resource')

      const taken = await refusedWithNothingWritten('classes-taken', {
        files: {
          'app/Http/Resources/nested/WidgetResource.ts': 'export class WidgetResource {}\n',
          'app/Policies/WidgetPolicy.ts': 'export class WidgetPolicy {}\n',
        },
      })
      expect(taken).toContain('resource.widget: the application already declares a WidgetResource resource.')
      expect(taken).toContain('policy.widget: the application already declares a WidgetPolicy policy.')
      expect(taken).toContain('app/Policies/WidgetPolicy.ts already exists.')
    })

    test('should refuse an ability that would replace one of Policy’s own members, or that no method can be named', async () => {
      const document = widgetsPlan()
      document.policies[0]!.abilities.push({ name: 'before', rule: 'Admins pass.' }, { name: 'view any', rule: 'Anyone.' }, { name: 'update', rule: 'Again.' })
      const message = await refusedWithNothingWritten('ability-names', { document: approve(document) })
      expect(message).toContain('policy.widget\'s ability "before" would replace Policy\'s own before(). Rename the ability (plan:revise).')
      expect(message).toContain('policy.widget\'s ability "view any" is not a name a method can take')
      expect(message).toContain('policy.widget plans the ability "update" twice.')
    })

    test('should refuse a validator, resource or policy in a module, as it refuses a model', async () => {
      const document = widgetsPlan()
      document.validators[0]!.module = 'billing'
      document.resources[0]!.module = 'billing'
      document.policies[0]!.module = 'billing'
      const message = await refusedWithNothingWritten('http-module', { document: approve(document) })
      for (const id of ['validator.widget', 'resource.widget', 'policy.widget']) {
        expect(message).toContain(`${id} sits in module "billing": plan:scaffold writes to the project root only.`)
      }
    })

    test('should refuse a policy provider it cannot register in createApp()', async () => {
      expect(await refusedWithNothingWritten('no-entry', { entry: null })).toContain(
        'WidgetPolicyProvider would be registered in createApp(), and this application has neither src/app.ts nor app.ts.',
      )
      expect(await refusedWithNothingWritten('no-create-app', { entry: 'export default {}\n' })).toContain('WidgetPolicyProvider cannot be registered in src/app.ts:')
      const registered = "import { createApp } from '@guren/core'\nimport WidgetPolicyProvider from '../app/Providers/WidgetPolicyProvider.js'\n\nexport default createApp({ providers: [WidgetPolicyProvider] })\n"
      expect(await refusedWithNothingWritten('already-registered', { entry: registered })).toContain('src/app.ts already registers WidgetPolicyProvider.')
    })

    test('should refuse a controller, side effect or routes file already there, by file and by class', async () => {
      const message = await refusedWithNothingWritten('http-in-the-way', {
        files: {
          'app/Http/Controllers/WidgetController.ts': 'export default class WidgetController {}\n',
          'app/Jobs/WidgetDigest.ts': 'export class WidgetDigest {}\n',
          'routes/widgets.ts': 'export function registerWidgetRoutes(): void {}\n',
        },
      })
      expect(message).toContain('controller.widget: the application already declares a WidgetController controller.')
      expect(message).toContain('job.widgetDigest: the application already declares a job WidgetDigest.')
      expect(message).toContain('app/Http/Controllers/WidgetController.ts already exists.')
      expect(message).toContain('routes/widgets.ts already exists.')
    })

    test('should refuse a controller or side effect in a module', async () => {
      const document = widgetsPlan()
      document.controllers![0]!.module = 'billing'
      document.sideEffects![0]!.module = 'billing'
      const message = await refusedWithNothingWritten('http-module', { document: approve(document) })
      expect(message).toContain('controller.widget sits in module "billing": plan:scaffold writes to the project root only.')
      expect(message).toContain('job.widgetDigest sits in module "billing": plan:scaffold writes to the project root only.')
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
      expect(message).toContain('Already written: db/schema.ts. app/Models/Widget.ts failed and may exist, part written. The step is half scaffolded')
      expect(message).not.toContain('Nothing was scaffolded.')
      expect(await readFile(join(dir, 'db/schema.ts'), 'utf8')).toContain("export const widgets = pgTable('widgets'")
    } finally {
      await chmod(join(dir, 'app/Models'), 0o755)
    }
  })

  // writeFileAtomic writes a temp file beside the entry, which a read-only src/ refuses.
  test.skipIf(process.getuid?.() === 0)('should name every file already written, and the entry left unchanged, when the registration fails last', async () => {
    const { dir, plan } = await createApp('partial-entry')
    await chmod(join(dir, 'src'), 0o555)
    try {
      const message = await refusal(() => planScaffoldFile(plan, { appRoot: dir, step: STEP }))
      expect(message).toContain(`Already written: db/schema.ts, ${CREATED.join(', ')}. src/app.ts was left unchanged, so WidgetPolicyProvider is not registered.`)
      expect(message).toContain('running plan:scaffold again refuses on these files.')
      expect(message).not.toContain('part written')
      expect(await readFile(join(dir, 'src/app.ts'), 'utf8')).toBe(APP_ENTRY)
    } finally {
      await chmod(join(dir, 'src'), 0o755)
    }
  })

  test('should add a providers array to a createApp() call that has none', async () => {
    const { dir, plan } = await createApp('no-providers-key', { entry: "import { createApp } from '@guren/core'\n\nexport default createApp({})\n" })

    await planScaffoldFile(plan, { appRoot: dir, step: STEP })

    const entry = await readFile(join(dir, 'src/app.ts'), 'utf8')
    expect(entry).toContain("import WidgetPolicyProvider from '../app/Providers/WidgetPolicyProvider.js'")
    expect(entry).toContain('providers: [WidgetPolicyProvider]')
  })

  test('should list each validator rule and resource field it writes as a stub or not at all', async () => {
    const document = widgetsPlan()
    document.validators[0]!.fields.push(
      { name: 'slug', type: 'string', required: true, rules: ['lowercase letters and dashes'] },
      { name: 'flag', type: 'boolean', required: true, rules: ['max 1'] },
      { name: 'rank', type: 'integer', required: true, rules: ['email'] },
      { name: 'link', type: 'string', required: true, rules: ['email', 'url'] },
    )
    const { dir, plan } = await createApp('unwritten', { document: approve(document) })

    const report = await planScaffoldFile(plan, { appRoot: dir, step: STEP })

    expect(report.unwritten).toEqual([
      { element: 'validator.widget', detail: 'field slug rule lowercase letters and dashes', reason: 'plan:status compares only min, max, email, url and uuid, so the rule is prose to implement' },
      { element: 'validator.widget', detail: 'field flag rule max 1', reason: "plan:status reads a bound on a string's length or a number's value, not on a boolean" },
      { element: 'validator.widget', detail: 'field rank rule email', reason: 'the email format applies to a string, and the field is planned integer' },
      { element: 'validator.widget', detail: 'field link rule url', reason: 'the field already takes the email format, and a value has one' },
      { element: 'resource.widget', detail: 'field tags', reason: 'Widget has no column tags this step writes, so toArray() throws on it until it is mapped' },
      { element: 'action.widget.index', detail: 'response', reason: 'the stub answers 501 until the http step writes the resource WidgetResource' },
      { element: 'action.widget.store', detail: 'response', reason: 'the stub answers 501 until the http step writes a redirect to /posts/:postId' },
      { element: 'action.widget.destroy', detail: 'response', reason: 'the stub answers 501 until the http step writes no content' },
    ])
    const text = formatPlanScaffold(report, PLAN_FILE)
    expect(text).toContain(`routes/widgets.ts is not mounted, so its routes answer nothing until the http step ${MOUNT_STEP} runs bunx guren plan:scaffold ${PLAN_FILE} --step ${MOUNT_STEP} --mount.`)
    expect(text).toContain('Registered in src/app.ts: WidgetPolicyProvider')
    expect(text).toContain('Written as a stub or not at all, to finish in the http step:')
    expect(text).toContain('  resource.widget field tags: Widget has no column tags this step writes')
  })

  test('should refuse validators in a step that adds two models, since their file is named after one', () => {
    const document = widgetsPlan()
    document.models.push({ id: 'model.gadget', change: { kind: 'add' }, name: 'Gadget', table: 'gadgets', columns: [column('gadget', 'id', 'integer', { primaryKey: true })], relationships: [], fillable: [] })
    const plan = parsePlanDocument(approve(document))
    const { step } = findPlanStep(derivePlanTasks(plan), STEP)!
    // Derivation gives each added model its own task; a step naming two is built here to reach the refusal.
    const twoModels = { ...step, generates: [...step.generates, 'model.gadget', 'column.gadget.id'] }
    const output = emitPlanScaffold(plan, twoModels, { ...NO_CLASSES, dialect: 'pg', tables: [], models: ['Post', 'Tag'] })

    expect(output.refusals).toContain(
      'validator.widget, validator.widgetQuery: the step adds model.widget and model.gadget, and the validator file is named after one model. Write the validators by hand in the http step, or split the models across tasks (plan:revise).',
    )
  })

  test('should write a stubbed field whose name holds a line break or a line separator as a valid literal', () => {
    const document = widgetsPlan()
    document.resources[0]!.fields.push({ name: 'odd\nname here', type: 'string' })
    const output = emitWidgets(document, 'pg')
    const resource = output.files.find((file) => file.path === 'app/Http/Resources/WidgetResource.ts')!.contents

    expect(resource).toContain("'odd\\nname\\u2028here': unmapped('odd\\nname\\u2028here'),")
    expect(() => new Bun.Transpiler({ loader: 'ts' }).transformSync(resource)).not.toThrow()
  })

  test('should stub a nullable JSON column whose planned type admits no null, rather than cast it', () => {
    const document = widgetsPlan()
    document.resources[0]!.fields.find((field) => field.name === 'meta')!.type = 'Record<string, unknown>'
    const output = emitWidgets(document, 'pg')
    const resource = output.files.find((file) => file.path === 'app/Http/Resources/WidgetResource.ts')!.contents

    expect(resource).toContain("meta: unmapped('meta'),")
    expect(output.unwritten).toContainEqual({ element: 'resource.widget', detail: 'field meta', reason: 'the column meta reads back as unknown | null, so toArray() throws on it until it is mapped' })
  })

  test('should leave a resource whose field type holds a comment, which would swallow the code after it', () => {
    const document = widgetsPlan()
    document.resources[0]!.fields.find((field) => field.name === 'meta')!.type = 'Record<string, unknown> | null // settings'
    const output = emitWidgets(document, 'pg')

    expect(output.left.filter((element) => element.section === 'resources')).toEqual([
      { id: 'resource.widget', section: 'resources', reason: 'its field type `Record<string, unknown> | null // settings` holds a comment, which would swallow the code written after the type' },
    ])
    expect(output.files.map((file) => file.path)).not.toContain('app/Http/Resources/WidgetResource.ts')
  })

  test('should leave a resource whose field type names something the file would have to import', () => {
    const document = widgetsPlan()
    document.resources.push({ id: 'resource.summary', change: { kind: 'add' }, name: 'WidgetSummaryResource', model: 'model.widget', fields: [{ name: 'author', type: 'UserResourceData | null' }] })
    const output = emitWidgets(document, 'pg')

    expect(output.refusals).toEqual([])
    expect(output.left.filter((element) => element.section === 'resources')).toEqual([
      { id: 'resource.summary', section: 'resources', reason: 'its field type `UserResourceData | null` names UserResourceData, which the resource file would have to import' },
    ])
    expect(output.files.map((file) => file.path)).not.toContain('app/Http/Resources/WidgetSummaryResource.ts')
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

    const report = await scaffoldStep(plan, dir)

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
    const output = emitPlanScaffold(plan, step, { ...NO_CLASSES, dialect: 'pg', tables: [{ identifier: 'posts', tableName: 'posts', module: null, columns: ['id'] }], models: ['Post'] })

    expect(output.refusals).toEqual([])
    expect(output.emitted).toEqual([
      'model.comment',
      'column.comment.id',
      'column.comment.body',
      'column.comment.postId',
      'column.comment.createdAt',
      'validator.comment',
      'controller.comments',
      'action.comments.store',
      'action.comments.destroy',
      'route.comments.store',
      'route.comments.destroy',
      'resource.comment',
      'policy.comment',
    ])
    expect(output.left).toEqual([])
    expect(output.files.map((file) => file.path)).not.toContainEqual(expect.stringContaining('resources/js/pages'))
  })

  test('should leave an action whose controller exists, and a route to it, to the http step', () => {
    const document = widgetsPlan()
    document.controllers!.push({
      id: 'controller.post',
      change: { kind: 'existing' },
      className: 'PostController',
      actions: [{ id: 'action.post.widgets', change: { kind: 'add' }, name: 'widgets', authorization: { middleware: [] }, response: { kind: 'json', description: 'The post’s widgets.' }, rules: [] }],
    })
    document.routes!.push({ id: 'route.posts.widgets', change: { kind: 'add' }, method: 'GET', path: '/posts/:id/widgets', name: 'posts.widgets', action: 'action.post.widgets', middleware: [], bind: [] })

    const output = emitWidgets(document, 'pg', { generates: (ids) => [...ids, 'action.post.widgets', 'route.posts.widgets'] })

    expect(output.refusals).toEqual([])
    expect(output.left).toEqual([
      { id: 'action.post.widgets', section: 'actions', reason: 'its controller PostController is not one this step adds, and plan:scaffold writes no action into an existing file' },
      { id: 'route.posts.widgets', section: 'routes', reason: 'its action action.post.widgets is not one this step writes' },
    ])
  })

  test('should refuse an action that would replace a Controller member, and two side effects writing one file', () => {
    const document = widgetsPlan()
    document.controllers![0]!.actions[1]!.name = 'redirect'
    document.sideEffects!.push({ id: 'job.widgetDigest2', change: { kind: 'add' }, kind: 'job', name: 'WidgetDigest', trigger: 'Hourly.', description: 'Again.' })

    const output = emitWidgets(document, 'pg')

    expect(output.refusals).toEqual([
      'action.widget.store is named "redirect", which would replace Controller\'s own redirect(). Rename the action (plan:revise).',
      'job.widgetDigest and job.widgetDigest2 would each write app/Jobs/WidgetDigest.ts.',
    ])
  })

  test('should validate params first and the body only after the policy is asked, so a denied caller gets 403 whatever it sent', () => {
    const document = widgetsPlan()
    const store = document.controllers![0]!.actions[1]!
    store.params = 'validator.widgetQuery'
    store.authorization.policy = { id: 'policy.widget', ability: 'update' }

    const controller = emitWidgets(document, 'pg').files.find((file) => file.path === 'app/Http/Controllers/WidgetController.ts')!.contents
    const body = controller.slice(controller.indexOf('async store()'))

    expect(body.slice(0, body.indexOf('throw'))).toBe(`async store(): Promise<Response> {
    this.validateParams(WidgetListQuerySchema)
    await this.authorize('update', Widget)
    await this.validateBody(WidgetPayloadSchema)
    `)
  })

  test('should mount no root routes file for a module entity, which the scaffold refuses', () => {
    const document = widgetsPlan()
    document.models[3]!.module = 'billing'
    const plan = parsePlanDocument(approve(document))

    expect(planScaffoldMounts(plan, derivePlanTasks(plan))).toEqual([])
    expect(planScaffoldMounts(parsePlanDocument(approve(widgetsPlan())), derivePlanTasks(parsePlanDocument(approve(widgetsPlan()))))).toHaveLength(1)
  })

  test('should tag the controller and routes file with the entity document only where it exists, since a tag to none fails guren check', () => {
    const tagged = (output: PlanScaffoldOutput): string[] => output.files.filter((file) => file.contents.includes('@docs')).map((file) => file.path)
    expect(tagged(emitWidgets(widgetsPlan(), 'pg'))).toEqual([])

    const output = emitWidgets(widgetsPlan(), 'pg', { app: { docs: ['docs/entities/Widget.md'] } })
    expect(tagged(output)).toEqual(['app/Http/Controllers/WidgetController.ts', 'routes/widgets.ts'])
    expect(output.files.find((file) => file.path === 'routes/widgets.ts')!.contents).toContain(' *\n * @docs docs/entities/Widget.md\n */\nexport function registerWidgetRoutes')
  })

  test('should list middleware other than auth, a schema the file cannot import, and every response as unwritten', () => {
    const document = widgetsPlan()
    document.routes![2]!.middleware.push('verified')
    document.validators.push({ id: 'validator.widgetFilter', change: { kind: 'add' }, name: 'WidgetFilterSchema', fields: [] })
    document.controllers![0]!.actions[0]!.params = 'validator.widgetFilter'
    // An action's authorization middleware applies on its route, though the route lists none.
    document.controllers![0]!.actions[0]!.authorization.middleware.push('auth')

    // Left out of the step, as if another task wrote it, and no root file exports it.
    const output = emitWidgets(document, 'pg', { generates: (ids) => ids.filter((id) => id !== 'validator.widgetFilter') })
    const routes = output.files.find((file) => file.path === 'routes/widgets.ts')!.contents

    expect(output.refusals).toEqual([])
    expect(output.unwritten.filter((entry) => entry.element.startsWith('action.') || entry.element.startsWith('route.'))).toEqual([
      { element: 'action.widget.index', detail: 'params validator', reason: 'no root validator file exports WidgetFilterSchema after this step, so the file cannot import it' },
      { element: 'action.widget.index', detail: 'response', reason: 'the stub answers 501 until the http step writes the resource WidgetResource' },
      { element: 'action.widget.store', detail: 'response', reason: 'the stub answers 501 until the http step writes a redirect to /posts/:postId' },
      { element: 'action.widget.destroy', detail: 'response', reason: 'the stub answers 501 until the http step writes no content' },
      { element: 'route.widgets.index', detail: 'params contract', reason: 'no root validator file exports WidgetFilterSchema after this step, so the file cannot import it' },
      { element: 'route.widgets.destroy', detail: 'middleware verified', reason: 'plan:scaffold registers only the auth alias; the http step applies verified with the handler the application aliases it to' },
    ])
    expect(routes).toContain(".middleware('auth')\n}")
    expect(routes).toContain("authRouter.get('/widgets', { name: 'widgets.index', query: WidgetListQuerySchema, agent: { toolName: 'widgets_index', readOnlyHint: true } }, [WidgetController, 'index']).middleware('auth')")
    expect(routes).not.toContain('verified')
  })

  test('should print the report as JSON through the registered command', async () => {
    const { dir, plan } = await createApp('json')
    const log = spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runCommand(builtinSubCommands['plan:scaffold'] as CommandDef, { rawArgs: [plan, '--step', STEP, '--app', dir, '--json'] })
      const report = JSON.parse(String(log.mock.calls[0]![0])) as PlanScaffoldStepReport
      expect(Object.keys(report).sort()).toEqual(['appended', 'created', 'emitted', 'kind', 'left', 'omitted', 'plan', 'registered', 'reportVersion', 'step', 'unmounted', 'unwritten'])
      expect(report).toMatchObject({ reportVersion: 1, step: STEP, kind: 'scaffold', plan: { file: PLAN_FILE, title: 'Widgets' }, created: CREATED })
      expect(report.plan.hash).toMatch(/^[0-9a-f]{64}$/)
    } finally {
      log.mockRestore()
    }
  })
})

/** An application whose root declares no class, schema or entity document. */
const NO_CLASSES = { validators: [], resources: [], policies: [], controllers: [], sideEffects: {}, modelFiles: {}, validatorFiles: {}, docs: [] } as const

/**
 * The emitter alone, over the fixture schema's tables and models. `generates` edits the derived
 * step: a test reaches a step shape derivation does not give by building it.
 */
function emitWidgets(document: WidgetsPlan, dialect: SchemaDialect, options: { generates?: (ids: string[]) => string[]; app?: Partial<PlanScaffoldApp> } = {}): PlanScaffoldOutput {
  const plan = parsePlanDocument(approve(document))
  const { step } = findPlanStep(derivePlanTasks(plan), STEP)!
  const tables = ['posts', 'tags'].map((table) => ({ identifier: table, tableName: table, module: null, columns: ['id'] }))
  return emitPlanScaffold(plan, { ...step, generates: options.generates?.(step.generates) ?? step.generates }, {
    ...NO_CLASSES,
    dialect,
    tables: [...tables, { identifier: 'widgetTags', tableName: 'widget_tags', module: null, columns: ['widgetId', 'tagId'] }],
    models: ['Post', 'Tag'],
    modelFiles: { Post: 'app/Models/Post.ts', Tag: 'app/Models/Tag.ts' },
    ...options.app,
  })
}
