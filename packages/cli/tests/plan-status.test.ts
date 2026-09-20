import { describe, expect, test } from 'bun:test'

import type { PlanAppDetail, PlanAppRouteDetail } from '../src/plan/app-detail'
import type { PlanAppState } from '../src/plan/app-state'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import { judgePlan, type PlanElementStatus, type PlanStatusState } from '../src/plan/status'
import type { SourcedSchemaTable } from '../src/schema-runtime'
import { loadCommentsPlan, planAppState } from './plan-fixture'

type Change = PlanDraft['routes'][number]['change']
const ADD: Change = { kind: 'add' }
const ALTER: Change = { kind: 'alter' }
const EXISTING: Change = { kind: 'existing' }
const DROP: Change = { kind: 'drop', reason: 'unused' }
const rename = (from: string): Change => ({ kind: 'rename', from })

function plan(sections: Record<string, unknown>): PlanDraft {
  return PlanDraftSchema.parse({
    planVersion: 1,
    title: 'Status fixture',
    summary: 'A plan for the status judge.',
    locale: 'en',
    scope: { goals: [], nonGoals: [] },
    ...sections,
  })
}

const POSTS_TABLE: SourcedSchemaTable = {
  identifier: 'posts',
  tableName: 'posts',
  module: null,
  dialect: 'pg',
  source: 'runtime',
  constraints: [{ kind: 'index', columns: ['authorId'] }],
  columns: [
    { name: 'id', columnName: 'id', type: 'serial', sqlType: 'serial', notNull: true, primaryKey: true, unique: false },
    { name: 'title', columnName: 'title', type: 'text', sqlType: 'text', notNull: true, primaryKey: false, unique: false },
    {
      name: 'authorId',
      columnName: 'author_id',
      type: 'integer',
      sqlType: 'integer',
      notNull: true,
      primaryKey: false,
      unique: false,
      references: { table: 'users', column: 'id' },
    },
  ],
}

const USERS_TABLE: SourcedSchemaTable = {
  identifier: 'users',
  tableName: 'users',
  module: null,
  dialect: 'pg',
  source: 'runtime',
  constraints: [],
  columns: [{ name: 'id', columnName: 'id', type: 'serial', sqlType: 'serial', notNull: true, primaryKey: true, unique: false }],
}

function detail(overrides: Partial<PlanAppDetail> = {}): PlanAppDetail {
  return {
    routes: [
      { name: 'posts.index', method: 'GET', path: '/posts', action: 'PostController.index', middleware: [], hasInlineMiddleware: false, bindings: {}, module: null, contractSchemas: [] },
      { name: 'posts.show', method: 'GET', path: '/posts/:id', action: 'PostController.show', middleware: ['auth'], hasInlineMiddleware: false, bindings: { id: 'Post' }, module: null, contractSchemas: [] },
    ],
    mounts: { entry: 'mounted', modules: {} },
    tables: [POSTS_TABLE, USERS_TABLE],
    models: [
      { className: 'Post', module: null, table: 'posts', relationships: [{ name: 'author', type: 'belongsTo', relatedModel: 'User' }], fillable: ['title'] },
      { className: 'User', module: null, table: 'users', relationships: [], fillable: null },
    ],
    unparsedModelFiles: [],
    actions: [
      { key: 'PostController.index', module: null, pages: ['posts/Index'], calls: ['inertia'], abilities: [], identifiers: ['Post', 'pages'], validates: [] },
      { key: 'PostController.show', module: null, pages: ['posts/Show'], calls: ['inertia', 'authorize'], abilities: ['view'], identifiers: ['Post', 'PostResource'], validates: [] },
    ],
    controllers: [{ className: 'PostController', module: null }],
    controllerCollisions: [],
    pages: [
      { id: 'posts/Index', props: { status: 'keys', keys: [{ name: 'posts', type: 'Post[]', optional: false }] } },
      { id: 'posts/Show', props: { status: 'undeclared' } },
    ],
    validators: [{ name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null }],
    resources: [{ className: 'PostResource', module: null }],
    policies: [{ className: 'PostPolicy', module: null }],
    routeFiles: [{ file: 'routes/web.ts', identifiers: ['PostController', 'PostPayloadSchema'] }],
    sideEffects: { job: [{ className: 'SendDigest', module: null }], event: [], listener: [] },
    ...overrides,
  } as PlanAppDetail
}

function app(detailOverrides: Partial<PlanAppDetail> = {}, overrides: Partial<PlanAppState> = {}): PlanAppState {
  return planAppState({ detail: detail(detailOverrides), ...overrides })
}

function only(status: ReturnType<typeof judgePlan>, id: string): PlanElementStatus {
  const element = status.elements.find((candidate) => candidate.id === id)
  if (!element) throw new Error(`no element ${id}`)
  return element
}

const UNREADABLE = { unreadable: 'the directory would not open' }

function model(change: Change, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'm', change, name: 'Post', table: 'posts', columns: [], relationships: [], fillable: [], ...extra }
}

function column(change: Change, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'c', change, name: 'title', type: 'text', nullable: false, unique: false, index: false, ...extra }
}

function withColumn(columnChange: Change, extra: Record<string, unknown> = {}): PlanDraft {
  return plan({ models: [model(ALTER, { columns: [column(columnChange, extra)] })] })
}

function route(change: Change, extra: Record<string, unknown> = {}): PlanDraft {
  return plan({
    controllers: [controller(EXISTING, [action(EXISTING)])],
    routes: [{ id: 'r', change, method: 'GET', path: '/posts', name: 'posts.index', action: 'a', middleware: [], bind: [], ...extra }],
  })
}

function action(change: Change, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'a', change, name: 'index', authorization: { middleware: [] }, response: { kind: 'empty' }, rules: [], ...extra }
}

function controller(change: Change, actions: Array<Record<string, unknown>> = [], className = 'PostController', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'ctl', change, className, actions, ...extra }
}

function view(change: Change, extra: Record<string, unknown> = {}): PlanDraft {
  return plan({ views: [{ id: 'v', change, page: 'posts/Index', purpose: 'List posts.', props: [], actions: [], states: {}, ...extra }] })
}

function validator(change: Change, name = 'PostPayloadSchema', extra: Record<string, unknown> = {}): PlanDraft {
  return plan({ validators: [{ id: 'val', change, name, fields: [], ...extra }] })
}

/** A registered route whose contract schema is the object `PostPayloadSchema` is exported as. */
function contractRoute(module: string | null): PlanAppRouteDetail {
  return {
    name: 'posts.store',
    method: 'POST',
    path: '/posts',
    action: 'PostController.store',
    middleware: [],
    hasInlineMiddleware: false,
    bindings: {},
    module,
    contractSchemas: ['PostPayloadSchema'],
  }
}

interface Case {
  name: string
  plan: PlanDraft
  app: PlanAppState
  id: string
  state: PlanStatusState
}

const CASES: Case[] = [
  // models
  { name: 'an added model with no class', plan: plan({ models: [model(ADD, { name: 'Comment', table: 'comments' })] }), app: app(), id: 'm', state: 'planned' },
  { name: 'an added model whose class binds the planned table', plan: plan({ models: [model(ADD, { fillable: ['title'] })] }), app: app(), id: 'm', state: 'present' },
  { name: 'an added model whose fillable lacks a planned entry', plan: plan({ models: [model(ADD, { fillable: ['title', 'body'] })] }), app: app(), id: 'm', state: 'drifted' },
  { name: 'an altered model none of whose planned properties is in the code', plan: plan({ models: [model(ALTER, { fillable: ['body'] })] }), app: app(), id: 'm', state: 'planned' },
  { name: 'an altered model that plans nothing a reader reads', plan: plan({ models: [model(ALTER)] }), app: app(), id: 'm', state: 'unjudged' },
  { name: 'a model when the models directory would not open', plan: plan({ models: [model(ADD)] }), app: app({}, { models: UNREADABLE }), id: 'm', state: 'blocked' },
  { name: 'a renamed model whose old class is gone', plan: plan({ models: [model(rename('Article'))] }), app: app(), id: 'm', state: 'present' },
  { name: 'a renamed model whose old class is still there', plan: plan({ models: [model(rename('User'))] }), app: app(), id: 'm', state: 'drifted' },
  { name: 'a renamed model still under its old name', plan: plan({ models: [model(rename('Post'), { name: 'Article' })] }), app: app(), id: 'm', state: 'planned' },
  { name: 'a dropped model that is still there', plan: plan({ models: [model(DROP)] }), app: app(), id: 'm', state: 'planned' },
  { name: 'a dropped model that is gone', plan: plan({ models: [model(DROP, { name: 'Legacy', table: 'legacy' })] }), app: app(), id: 'm', state: 'present' },
  {
    name: 'a dropped model whose file exists and yielded no class',
    plan: plan({ models: [model(DROP, { name: 'Legacy', table: 'legacy' })] }),
    app: app({ unparsedModelFiles: ['app/Models/Legacy.ts'] }),
    id: 'm',
    state: 'blocked',
  },

  // columns
  { name: 'an added column the table lacks', plan: withColumn(ADD, { name: 'body' }), app: app(), id: 'c', state: 'planned' },
  { name: 'an added column that matches', plan: withColumn(ADD), app: app(), id: 'c', state: 'present' },
  { name: 'an added column of another type', plan: withColumn(ADD, { type: 'integer' }), app: app(), id: 'c', state: 'drifted' },
  { name: 'a dropped column that is gone from a table read at runtime', plan: withColumn(DROP, { name: 'subtitle' }), app: app(), id: 'c', state: 'present' },
  {
    name: 'a dropped column absent from a table whose columns hold a spread',
    plan: withColumn(DROP, { name: 'subtitle' }),
    app: app({ tables: [{ ...POSTS_TABLE, source: 'static', opaqueColumns: true, runtimeUnreadable: 'it threw' }, USERS_TABLE] }),
    id: 'c',
    state: 'blocked',
  },
  { name: 'a column when the schema could not be read', plan: withColumn(ADD), app: app({ tables: UNREADABLE }), id: 'c', state: 'blocked' },

  // validators
  { name: 'an added validator nothing exports', plan: validator(ADD, 'CommentSchema'), app: app(), id: 'val', state: 'planned' },
  {
    name: 'a validator a mounted route registered as its contract schema',
    plan: validator(ADD),
    app: app({ routes: [contractRoute(null)] }),
    id: 'val',
    state: 'wired',
  },
  {
    name: 'a validator only a route of an unmounted module registered as its contract schema',
    plan: validator(ADD),
    app: app({
      routes: [contractRoute('billing')],
      mounts: { entry: 'mounted', modules: { billing: { unconfirmed: 'createApp() in src/app.ts lists no modules' } } },
    }),
    id: 'val',
    state: 'present',
  },
  {
    name: 'a validator no registered route contract holds, named in the entry routes file only',
    plan: validator(ADD),
    app: app({ routeFiles: [{ file: 'routes/web.ts', identifiers: ['PostPayloadSchema'] }] }),
    id: 'val',
    state: 'present',
  },
  {
    name: 'a validator whose file would not import, so no contract could be matched to it',
    plan: validator(ADD),
    app: app({
      validators: [{ name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null, unimported: 'it threw' }],
    }),
    id: 'val',
    state: 'present',
  },
  {
    name: 'a validator a wired action validates with',
    plan: validator(ADD),
    app: app({
      routeFiles: [],
      actions: [{ key: 'PostController.index', module: null, pages: [], calls: [], abilities: [], identifiers: ['PostPayloadSchema'], validates: ['PostPayloadSchema'] }],
    }),
    id: 'val',
    state: 'wired',
  },
  {
    name: 'a validator a wired action mentions without validating with it',
    plan: validator(ADD),
    app: app({
      routeFiles: [],
      actions: [{ key: 'PostController.index', module: null, pages: [], calls: [], abilities: [], identifiers: ['PostPayloadSchema'], validates: [] }],
    }),
    id: 'val',
    state: 'present',
  },
  { name: 'a validator when a validator file did not parse', plan: validator(ADD), app: app({ validators: UNREADABLE }), id: 'val', state: 'blocked' },
  {
    name: 'a validator the plan puts in a module and only the project root exports',
    plan: validator(ADD, 'PostPayloadSchema', { module: 'billing' }),
    app: app(),
    id: 'val',
    state: 'planned',
  },
  {
    name: 'a validator the plan puts at the project root and only a module exports',
    plan: validator(ADD),
    app: app({ validators: [{ name: 'PostPayloadSchema', file: 'modules/billing/app/Http/Validators/PostValidator.ts', module: 'billing' }] }),
    id: 'val',
    state: 'planned',
  },

  // controllers and actions
  { name: 'an added controller with no class', plan: plan({ controllers: [controller(ADD, [], 'CommentController')] }), app: app(), id: 'ctl', state: 'planned' },
  { name: 'an added controller', plan: plan({ controllers: [controller(ADD)] }), app: app(), id: 'ctl', state: 'present' },
  {
    name: 'a controller class two files declare',
    plan: plan({ controllers: [controller(ADD)] }),
    app: app({ controllerCollisions: ['PostController'] }),
    id: 'ctl',
    state: 'blocked',
  },
  { name: 'an added action the class lacks', plan: plan({ controllers: [controller(EXISTING, [action(ADD, { name: 'store' })])] }), app: app(), id: 'a', state: 'planned' },
  { name: 'an added action a mounted route dispatches to', plan: plan({ controllers: [controller(EXISTING, [action(ADD)])] }), app: app(), id: 'a', state: 'wired' },
  {
    name: 'an added action no route dispatches to',
    plan: plan({ controllers: [controller(EXISTING, [action(ADD)])] }),
    app: app({ routes: [] }),
    id: 'a',
    state: 'present',
  },
  {
    name: 'an added action that returns another page',
    plan: plan({
      controllers: [controller(EXISTING, [action(ADD, { response: { kind: 'inertia', view: 'v' } })])],
      views: [{ id: 'v', change: EXISTING, page: 'posts/Archive', purpose: 'x', props: [], actions: [], states: {} }],
    }),
    app: app(),
    id: 'a',
    state: 'drifted',
  },
  { name: 'an altered action that changes business rules only', plan: plan({ controllers: [controller(EXISTING, [action(ALTER, { rules: ['Drafts are hidden.'] })])] }), app: app(), id: 'a', state: 'unjudged' },
  {
    name: 'an altered action whose only planned property is a validator its body mentions without validating with it',
    plan: plan({
      controllers: [controller(EXISTING, [action(ALTER, { body: 'val' })])],
      validators: [{ id: 'val', change: EXISTING, name: 'PostPayloadSchema', fields: [] }],
    }),
    app: app({
      actions: [{ key: 'PostController.index', module: null, pages: [], calls: [], abilities: [], identifiers: ['PostPayloadSchema'], validates: [] }],
    }),
    id: 'a',
    state: 'unjudged',
  },
  {
    name: 'an altered action whose planned validator its body validates with',
    plan: plan({
      controllers: [controller(EXISTING, [action(ALTER, { body: 'val' })])],
      validators: [{ id: 'val', change: EXISTING, name: 'PostPayloadSchema', fields: [] }],
    }),
    app: app({
      actions: [{ key: 'PostController.index', module: null, pages: [], calls: [], abilities: [], identifiers: [], validates: ['PostPayloadSchema'] }],
    }),
    id: 'a',
    state: 'wired',
  },
  {
    name: 'an action of a class two files declare',
    plan: plan({ controllers: [controller(EXISTING, [action(ADD)])] }),
    app: app({ controllerCollisions: ['PostController'] }),
    id: 'a',
    state: 'blocked',
  },

  // routes
  { name: 'an added route nothing registers', plan: route(ADD, { name: 'posts.archive', path: '/archive' }), app: app(), id: 'r', state: 'planned' },
  { name: 'an added route the entry registrar declares and createApp() mounts', plan: route(ADD), app: app(), id: 'r', state: 'wired' },
  {
    name: 'an added route whose registrar createApp() is not seen to take',
    plan: route(ADD),
    app: app({ mounts: { entry: { unconfirmed: 'createApp() passes no routes' }, modules: {} } }),
    id: 'r',
    state: 'present',
  },
  { name: 'an added route registered under another method', plan: route(ADD, { method: 'POST' }), app: app(), id: 'r', state: 'drifted' },
  { name: 'a route when the routes file threw', plan: route(ADD), app: app({ routes: UNREADABLE }), id: 'r', state: 'blocked' },
  {
    name: 'a dropped route that is absent while a module failed to load',
    plan: route(DROP, { name: 'posts.legacy' }),
    app: app({ routesIncomplete: 'modules/billing did not import' }),
    id: 'r',
    state: 'blocked',
  },
  { name: 'a dropped route that is absent', plan: route(DROP, { name: 'posts.legacy' }), app: app(), id: 'r', state: 'present' },

  // views
  { name: 'an added page with no component', plan: view(ADD, { page: 'posts/Archive' }), app: app(), id: 'v', state: 'planned' },
  { name: 'an added page a wired action returns', plan: view(ADD, { props: [{ name: 'posts', type: 'Post[]' }] }), app: app(), id: 'v', state: 'wired' },
  { name: 'an added page no action returns', plan: view(ADD), app: app({ actions: [] }), id: 'v', state: 'present' },
  { name: 'an added page missing a planned prop', plan: view(ADD, { props: [{ name: 'filters', type: 'Filters' }] }), app: app(), id: 'v', state: 'drifted' },
  { name: 'an altered page that changes only what it renders', plan: view(ALTER, { states: { empty: 'No posts.' } }), app: app(), id: 'v', state: 'unjudged' },
  { name: 'a page when the pages directory would not open', plan: view(ADD), app: app({}, { pages: UNREADABLE }), id: 'v', state: 'blocked' },
  { name: 'a page the plan puts in a module whose name the page id does not carry', plan: view(ADD, { module: 'billing' }), app: app(), id: 'v', state: 'blocked' },
  {
    name: "a page the plan puts in a module and names under that module's own prefix",
    plan: view(ADD, { page: 'billing/posts/Index', module: 'billing' }),
    app: app({}, { pages: ['billing/posts/Index'] }),
    id: 'v',
    state: 'present',
  },

  // resources, policies, side effects, commands
  { name: 'an added resource with no file', plan: plan({ resources: [{ id: 'res', change: ADD, name: 'CommentResource', model: 'm', fields: [] }] }), app: app(), id: 'res', state: 'planned' },
  { name: 'an added resource', plan: plan({ resources: [{ id: 'res', change: ADD, name: 'PostResource', model: 'm', fields: [] }] }), app: app(), id: 'res', state: 'present' },
  { name: 'an added policy', plan: plan({ policies: [{ id: 'pol', change: ADD, name: 'PostPolicy', model: 'm', abilities: [] }] }), app: app(), id: 'pol', state: 'present' },
  { name: 'a policy when the directory would not open', plan: plan({ policies: [{ id: 'pol', change: ADD, name: 'PostPolicy', model: 'm', abilities: [] }] }), app: app({}, { policies: UNREADABLE }), id: 'pol', state: 'blocked' },
  { name: 'an added job', plan: plan({ sideEffects: [{ id: 'job', change: ADD, kind: 'job', name: 'SendDigest', trigger: 't', description: 'd' }] }), app: app(), id: 'job', state: 'present' },
  { name: 'an added job with no file', plan: plan({ sideEffects: [{ id: 'job', change: ADD, kind: 'job', name: 'Reindex', trigger: 't', description: 'd' }] }), app: app(), id: 'job', state: 'planned' },
  { name: 'a mail class, which nothing discovers', plan: plan({ sideEffects: [{ id: 'mail', change: ADD, kind: 'mail', name: 'Welcome', trigger: 't', description: 'd' }] }), app: app(), id: 'mail', state: 'unjudged' },
  { name: 'a command', plan: plan({ commands: [{ id: 'cmd', command: 'guren add attachments', reason: 'covers' }] }), app: app(), id: 'cmd', state: 'unjudged' },

  // the app root each element sits in, both ways round
  { name: 'a model the plan puts in a module and only the project root declares', plan: plan({ models: [model(ADD, { module: 'billing' })] }), app: app(), id: 'm', state: 'planned' },
  {
    name: 'a model the plan puts at the project root and only a module declares',
    plan: plan({ models: [model(ADD)] }),
    app: app({ models: [{ className: 'Post', module: 'billing', table: 'posts', relationships: [], fillable: ['title'] }] }),
    id: 'm',
    state: 'planned',
  },
  { name: 'a controller the plan puts in a module and only the project root declares', plan: plan({ controllers: [controller(ADD, [], 'PostController', { module: 'billing' })] }), app: app(), id: 'ctl', state: 'planned' },
  {
    name: 'a controller the plan puts at the project root and only a module declares',
    plan: plan({ controllers: [controller(ADD)] }),
    app: app({ controllers: [{ className: 'PostController', module: 'billing' }] }),
    id: 'ctl',
    state: 'planned',
  },
  {
    name: "an action whose controller the plan puts in a module the class is not in",
    plan: plan({ controllers: [controller(EXISTING, [action(ADD)], 'PostController', { module: 'billing' })] }),
    id: 'a',
    app: app(),
    state: 'planned',
  },
  { name: 'a resource the plan puts in a module and only the project root declares', plan: plan({ resources: [{ id: 'res', change: ADD, name: 'PostResource', model: 'm', fields: [], module: 'billing' }] }), app: app(), id: 'res', state: 'planned' },
  {
    name: 'a policy the plan puts at the project root and only a module declares',
    plan: plan({ policies: [{ id: 'pol', change: ADD, name: 'PostPolicy', model: 'm', abilities: [] }] }),
    app: app({ policies: [{ className: 'PostPolicy', module: 'billing' }] }),
    id: 'pol',
    state: 'planned',
  },
  { name: 'a job the plan puts in a module and only the project root declares', plan: plan({ sideEffects: [{ id: 'job', change: ADD, kind: 'job', name: 'SendDigest', trigger: 't', description: 'd', module: 'billing' }] }), app: app(), id: 'job', state: 'planned' },
  {
    name: 'a job the plan puts at the project root and only a module declares',
    plan: plan({ sideEffects: [{ id: 'job', change: ADD, kind: 'job', name: 'SendDigest', trigger: 't', description: 'd' }] }),
    app: app({ sideEffects: { job: [{ className: 'SendDigest', module: 'billing' }], event: [], listener: [] } }),
    id: 'job',
    state: 'planned',
  },
  { name: 'a model when nothing says which app root each class came from', plan: plan({ models: [model(ADD)] }), app: planAppState(), id: 'm', state: 'blocked' },
]

describe('judgePlan', () => {
  test.each(CASES)('should judge $name as $state', ({ plan: document, app: state, id, state: expected }) => {
    expect(only(judgePlan(document, state), id).state).toBe(expected)
  })

  describe('unknown properties', () => {
    const HIDDEN_TABLE: SourcedSchemaTable = {
      ...POSTS_TABLE,
      source: 'static',
      opaqueConstraints: true,
      constraints: [],
      columns: [{ name: 'title', notNull: false, primaryKey: false, unique: false, opaqueBuilder: true }],
    }

    test('should not read a property no reader can see as a match or a difference', () => {
      const status = judgePlan(withColumn(ADD, { unique: true, index: true, default: "'x'" }), app({ tables: [HIDDEN_TABLE, USERS_TABLE] }))

      const verdicts = Object.fromEntries(only(status, 'c').properties.map((property) => [property.property, property.verdict]))
      expect(verdicts).toEqual({ type: 'unknown', nullable: 'unknown', unique: 'unknown', index: 'unknown', default: 'unknown' })
    })

    test('should list them per element as planned, not checkable', () => {
      const status = judgePlan(withColumn(ADD, { unique: true, index: true }), app({ tables: [HIDDEN_TABLE, USERS_TABLE] }))

      expect(status.summary.notCheckable).toEqual([{ id: 'c', properties: ['type', 'nullable', 'unique', 'index'] }])
      expect(status.summary.properties).toEqual({ match: 0, differ: 0, unknown: 4 })
    })

    test('should leave an altered element whose every planned property is unknown unjudged, never present', () => {
      const status = judgePlan(withColumn(ALTER, { unique: true }), app({ tables: [HIDDEN_TABLE, USERS_TABLE] }))

      expect(only(status, 'c')).toMatchObject({ state: 'unjudged', reason: expect.stringContaining('reader') })
    })

    test('should keep an unknown beside a difference from hiding the difference', () => {
      const table = { ...HIDDEN_TABLE, columns: [{ ...HIDDEN_TABLE.columns[0]!, type: 'integer', opaqueBuilder: undefined }] }

      expect(only(judgePlan(withColumn(ADD), app({ tables: [table, USERS_TABLE] })), 'c').state).toBe('drifted')
    })

    test('should call an ambiguous builder unknown rather than a match', () => {
      const table: SourcedSchemaTable = { ...POSTS_TABLE, dialect: 'sqlite', columns: [{ ...POSTS_TABLE.columns[1]!, name: 'published', type: 'integer', sqlType: 'integer' }] }
      const status = judgePlan(withColumn(ADD, { name: 'published', type: 'boolean' }), app({ tables: [table, USERS_TABLE] }))

      expect(only(status, 'c').properties.find((property) => property.property === 'type')).toMatchObject({ verdict: 'unknown' })
    })

    test('should report every comparison as unknown when the state was loaded without detail', () => {
      const status = judgePlan(route(ADD), planAppState())

      expect(only(status, 'r')).toMatchObject({ state: 'blocked', reason: expect.stringContaining('without detail') })
    })
  })

  describe('the app root a lookup is scoped to', () => {
    test('should look for the table a model was renamed from in the model’s own app root', () => {
      const billing = { ...POSTS_TABLE, identifier: 'legacyPosts', tableName: 'legacy_posts', module: 'billing' }
      const document = plan({ models: [model(ALTER, { tableRenamedFrom: 'legacy_posts' })] })

      const element = only(judgePlan(document, app({ tables: [POSTS_TABLE, USERS_TABLE, billing] })), 'm')

      expect(element.properties.find((property) => property.property === 'previous table removed')).toMatchObject({ verdict: 'match', actual: 'absent' })
    })

    test('should name a policy in the singular it is written with, never one derived from "policies"', () => {
      const document = plan({ policies: [{ id: 'pol', change: ADD, name: 'PostPolicy', model: 'm', abilities: [{ name: 'view', rule: 'anyone' }] }] })

      const reasons = only(judgePlan(document, app()), 'pol').properties.map((property) => property.reason)
      const scoped = only(judgePlan(document, planAppState({ policies: ['PostPolicy'] })), 'pol').reason

      expect(reasons).toEqual(["nothing reads a policy's abilities"])
      expect(scoped).toBe('nothing reads which app root each policy sits in')
    })
  })

  describe('a validator’s evidence of mounting', () => {
    test('should say a file would not import rather than that no contract holds the symbol', () => {
      const unimported = app({ validators: [{ name: 'PostPayloadSchema', file: 'app/Http/Validators/PostValidator.ts', module: null, unimported: 'it threw' }] })

      expect(only(judgePlan(validator(ADD), unimported), 'val').notes).toEqual([
        'Not confirmed as wired: app/Http/Validators/PostValidator.ts would not import, so no route contract could be matched to it (it threw).',
      ])
    })

    test('should name the route whose contract holds it when that route is not mounted', () => {
      const unmounted = app({
        routes: [contractRoute('billing')],
        mounts: { entry: 'mounted', modules: { billing: { unconfirmed: 'createApp() in src/app.ts lists no modules' } } },
      })

      expect(only(judgePlan(validator(ADD), unmounted), 'val').notes).toEqual([
        'Not confirmed as wired: the contract of posts.store holds it, and createApp() in src/app.ts lists no modules.',
      ])
    })
  })

  describe('column properties', () => {
    test('should compare a foreign key by the table the planned model names', () => {
      const document = plan({
        models: [
          model(ALTER, { columns: [column(ADD, { name: 'authorId', columnName: 'author_id', type: 'integer', index: true, references: { model: 'u', column: 'id', onDelete: 'cascade' } })] }),
          { id: 'u', change: EXISTING, name: 'User', table: 'users', columns: [], relationships: [], fillable: [] },
        ],
      })

      const element = only(judgePlan(document, app()), 'c')

      expect(element.state).toBe('present')
      expect(element.properties.find((property) => property.property === 'references')).toMatchObject({ verdict: 'match', actual: 'users.id' })
      expect(element.properties.find((property) => property.property === 'references.onDelete')).toMatchObject({ verdict: 'unknown' })
    })

    test('should read a primary key as not nullable, which the static reader never states', () => {
      const element = only(judgePlan(withColumn(ADD, { name: 'id', type: 'integer', primaryKey: true }), app()), 'c')

      expect(element.state).toBe('present')
    })

    test.each([
      ['now()', { kind: 'now' }, 'match'],
      ["'draft'", { kind: 'value', text: '"draft"' }, 'match'],
      ["'draft'", { kind: 'value', text: "'live'" }, 'differ'],
      ['CURRENT_TIMESTAMP', { kind: 'sql', text: 'now()' }, 'match'],
      ['gen_random_uuid()', { kind: 'sql', text: 'uuid_generate_v4()' }, 'unknown'],
    ] as const)('should compare the planned default %s with %j as %s', (planned, actual, verdict) => {
      const table = { ...POSTS_TABLE, columns: [{ ...POSTS_TABLE.columns[1]!, default: actual }] } as SourcedSchemaTable

      const element = only(judgePlan(withColumn(ADD, { default: planned }), app({ tables: [table, USERS_TABLE] })), 'c')

      expect(element.properties.find((property) => property.property === 'default')?.verdict).toBe(verdict)
    })
  })

  describe('routes', () => {
    test('should require the module that declared a route to be one createApp() lists', () => {
      const routes = [{ name: 'invoices.index', method: 'GET', path: '/billing/invoices', action: 'InvoiceController.index', middleware: [], hasInlineMiddleware: false, bindings: {}, module: 'billing', contractSchemas: [] }]
      const document = plan({
        controllers: [controller(EXISTING, [action(EXISTING)], 'InvoiceController')],
        routes: [{ id: 'r', change: ADD, method: 'GET', path: '/billing/invoices', name: 'invoices.index', action: 'a', middleware: [], bind: [] }],
      })
      const mounted = app({ routes, mounts: { entry: 'mounted', modules: { billing: 'mounted' } } })
      const unlisted = app({ routes, mounts: { entry: 'mounted', modules: { billing: { unconfirmed: 'createApp({ modules }) does not list modules/billing' } } } })

      expect(only(judgePlan(document, mounted), 'r').state).toBe('wired')
      expect(only(judgePlan(document, unlisted), 'r')).toMatchObject({ state: 'present', notes: [expect.stringContaining('modules/billing')] })
    })

    test('should call a planned middleware unknown when the route carries an inline one', () => {
      const routes = [{ name: 'posts.index', method: 'GET', path: '/posts', action: 'PostController.index', middleware: [], hasInlineMiddleware: true, bindings: {}, module: null, contractSchemas: [] }]

      const element = only(judgePlan(route(ADD, { middleware: ['auth'] }), app({ routes })), 'r')

      expect(element.properties.find((property) => property.property === 'middleware auth')).toMatchObject({ verdict: 'unknown' })
    })

    test('should block on two registered routes sharing the planned name', () => {
      const duplicate = { name: 'posts.index', method: 'GET', path: '/p', action: 'PostController.index', middleware: [], hasInlineMiddleware: false, bindings: {}, module: null, contractSchemas: [] }

      expect(only(judgePlan(route(ADD), app({ routes: [duplicate, duplicate] })), 'r').state).toBe('blocked')
    })

    test('should report a route still on its prototype fixture as differing from its planned action', () => {
      const routes = [{ name: 'posts.index', method: 'GET', path: '/posts', middleware: [], hasInlineMiddleware: false, bindings: {}, module: null, contractSchemas: [], prototype: true as const }]

      expect(only(judgePlan(route(ADD), app({ routes })), 'r').state).toBe('drifted')
    })
  })

  describe('summary', () => {
    test('should count existing elements apart and name the missing ones', () => {
      const document = plan({
        models: [model(EXISTING), { ...model(EXISTING, { name: 'Ghost', table: 'ghosts' }), id: 'ghost' }, { ...model(ADD, { name: 'Comment', table: 'comments' }), id: 'new' }],
      })

      const { summary } = judgePlan(document, app())

      expect(summary.existing).toEqual({ found: 1, missing: ['ghost'], unread: [] })
      expect(summary.states).toEqual({ planned: 1, present: 0, wired: 0, drifted: 0, unjudged: 0, blocked: 0 })
    })

    test('should keep an existing element nobody could read out of both the found and the changed counts', () => {
      const { summary } = judgePlan(plan({ models: [model(EXISTING)] }), app({}, { models: UNREADABLE }))

      expect(summary.existing).toEqual({ found: 0, missing: [], unread: ['m'] })
      expect(summary.states.blocked).toBe(0)
    })

    test('should judge the comments fixture without calling anything it adds present', () => {
      const status = judgePlan(PlanDraftSchema.parse(loadCommentsPlan()), app())

      const added = status.elements.filter((element) => element.change === 'add')
      expect(added.length).toBeGreaterThan(0)
      expect(added.every((element) => element.state === 'planned')).toBe(true)
    })
  })
})
