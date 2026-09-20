import { describe, expect, test } from 'bun:test'
import { listPlanElements, PlanDraftSchema, type PlanDraft } from '../src/plan/schema'
import {
  derivePlanTasks,
  FOUNDATION_TASK_ID,
  parsePlanHint,
  PLAN_SECTION_STEP,
  type DerivePlanTasksOptions,
  type PlanDerivedStep,
  type PlanDerivedTask,
  type PlanStepKind,
  type PlanTaskDerivation,
} from '../src/plan/tasks'
import { loadCommentsPlanInput, type PlanInput } from './plan-fixture'

type ModelInput = NonNullable<PlanInput['models']>[number]
type ChangeInput = ModelInput['change']

const ADD: ChangeInput = { kind: 'add' }

function parsePlan(edit: (plan: PlanInput) => void = () => {}): PlanDraft {
  const plan = loadCommentsPlanInput()
  edit(plan)
  return PlanDraftSchema.parse(plan)
}

function derive(edit?: (plan: PlanInput) => void, options?: DerivePlanTasksOptions): PlanTaskDerivation {
  return derivePlanTasks(parsePlan(edit), options)
}

/** A plan holding nothing but what the test puts in it. */
function planFrom(sections: Partial<PlanInput>): PlanDraft {
  const { planVersion, title, summary, locale, scope } = loadCommentsPlanInput()
  return PlanDraftSchema.parse({ planVersion, title, summary, locale, scope, ...sections })
}

function deriveFrom(sections: Partial<PlanInput>, options?: DerivePlanTasksOptions): PlanTaskDerivation {
  return derivePlanTasks(planFrom(sections), options)
}

/** A model whose only columns are its key and one foreign key per `references` entry. */
function model(name: string, references: string[] = [], change: ChangeInput = ADD): ModelInput {
  const key = name.toLowerCase()
  return {
    id: `model.${key}`,
    change,
    name,
    table: `${key}s`,
    columns: [
      { id: `column.${key}.id`, name: 'id', change, type: 'integer', nullable: false, unique: false, index: false, primaryKey: true },
      ...references.map((target) => ({
        id: `column.${key}.${target}Id`,
        name: `${target}Id`,
        change,
        type: 'integer' as const,
        nullable: false,
        unique: false,
        index: true,
        references: { model: `model.${target}`, column: 'id' },
      })),
    ],
    relationships: [],
    fillable: [],
  }
}

function resource(name: string): NonNullable<PlanInput['resources']>[number] {
  const key = name.toLowerCase()
  return { id: `resource.${key}`, change: ADD, name: `${name}Resource`, model: `model.${key}`, fields: [] }
}

function view(page: string, resources: string[] = []): NonNullable<PlanInput['views']>[number] {
  return {
    id: `view.${page.replace('/', '.').toLowerCase()}`,
    change: ADD,
    page,
    purpose: 'A page.',
    props: resources.map((id) => ({ name: id, type: 'unknown', resource: id })),
    actions: [],
    states: {},
  }
}

const ids = (result: PlanTaskDerivation): string[] => result.tasks.map((task) => task.id)

function task(result: PlanTaskDerivation, id: string): PlanDerivedTask {
  const found = result.tasks.find((candidate) => candidate.id === id)
  expect(found, id).toBeDefined()
  return found as PlanDerivedTask
}

const stepIds = (derived: PlanDerivedTask): string[] => derived.steps.map((step) => step.id)

function stepsOfKind(result: PlanTaskDerivation, taskId: string, kind: PlanStepKind): PlanDerivedStep[] {
  return task(result, taskId).steps.filter((step) => step.kind === kind)
}

const COMMENT_SLICE = 'task/entity/model.comment'

const COMMENT_HTTP = [
  'validator.comment',
  'controller.comments',
  'action.comments.store',
  'action.comments.destroy',
  'route.comments.store',
  'route.comments.destroy',
  'resource.comment',
  'policy.comment',
]

/** A dashboard over posts and comments, plus a command and a validator two slices share. */
function busyPlan(plan: PlanInput): void {
  plan.models = [model('Post'), model('Comment', ['post'])]
  plan.resources = [resource('Post'), resource('Comment')]
  plan.policies = []
  plan.tasks = []
  plan.commands = [{ id: 'command.attachments', command: 'guren add attachments', reason: 'Posts carry a cover.' }]
  plan.validators = [{ id: 'validator.page', change: ADD, name: 'PageQuerySchema', fields: [] }]
  plan.views = [view('dashboard/Index', ['resource.post', 'resource.comment'])]
  const action = (id: string, response: object): object => ({
    id,
    change: ADD,
    name: 'index',
    query: 'validator.page',
    authorization: { middleware: [] },
    response,
    rules: [],
  })
  plan.controllers = [
    { id: 'controller.posts', change: ADD, className: 'PostController', actions: [action('action.posts.index', { kind: 'resource', resource: 'resource.post' })] },
    { id: 'controller.comments', change: ADD, className: 'CommentController', actions: [action('action.comments.index', { kind: 'resource', resource: 'resource.comment' })] },
    { id: 'controller.dashboard', change: ADD, className: 'DashboardController', actions: [action('action.dashboard.index', { kind: 'inertia', view: 'view.dashboard.index' })] },
  ] as PlanInput['controllers']
  plan.routes = [
    { id: 'route.dashboard', change: ADD, method: 'GET', path: '/dashboard', name: 'dashboard', action: 'action.dashboard.index', middleware: [], bind: [] },
  ]
}

function changeKinds(plan: PlanDraft): Map<string, string> {
  const kinds = new Map<string, string>()
  const record = (element: { id: string; change?: { kind: string } }): void => {
    kinds.set(element.id, element.change?.kind ?? 'add')
  }
  for (const entry of plan.models) {
    record(entry)
    entry.columns.forEach(record)
  }
  for (const entry of plan.controllers) {
    record(entry)
    entry.actions.forEach(record)
  }
  for (const section of [plan.validators, plan.routes, plan.views, plan.resources, plan.policies, plan.sideEffects, plan.commands]) {
    section.forEach(record)
  }
  return kinds
}

/** Every element the section table calls work is owned once, by a step of the kind its row names. */
function expectEveryElementOnce(plan: PlanDraft, result: PlanTaskDerivation): void {
  const kinds = changeKinds(plan)
  const expected = listPlanElements(plan)
    .filter((ref) => PLAN_SECTION_STEP[ref.section] !== null && kinds.get(ref.id) !== 'existing')
    .map((ref) => `${PLAN_SECTION_STEP[ref.section]?.step} ${ref.id}`)
    .sort()
  const owned = result.tasks
    .flatMap((derived) => derived.steps.flatMap((step) => step.elementIds.map((id) => `${step.kind} ${id}`)))
    .sort()
  expect(owned).toEqual(expected)
}

/** What each element needs, read from the plan independently of the module under test. */
function referencesOf(plan: PlanDraft): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const add = (from: string, ...targets: Array<string | undefined>): void => {
    out.set(from, [...(out.get(from) ?? []), ...targets.filter((target) => target !== undefined)])
  }
  for (const entry of plan.resources) add(entry.id, entry.model)
  for (const entry of plan.policies) add(entry.id, entry.model)
  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      const response = action.response
      add(controller.id, action.body, action.params, action.query, action.authorization.policy?.id)
      add(controller.id, response.kind === 'inertia' ? response.view : undefined, response.kind === 'resource' ? response.resource : undefined)
      add(action.id, ...(out.get(controller.id) ?? []))
    }
  }
  for (const route of plan.routes) add(route.id, route.action, ...route.bind.map((bind) => bind.model))
  for (const entry of plan.views) {
    add(entry.id, entry.form?.validator, entry.form?.submitsTo, ...entry.actions.map((action) => action.route), ...entry.props.map((prop) => prop.resource))
  }
  return out
}

/** Foundation waits for nothing, and owns nothing that needs another task's work, short of a reported exception. */
function expectFoundationStandsAlone(plan: PlanDraft, result: PlanTaskDerivation): void {
  const foundation = result.tasks.find((candidate) => candidate.id === FOUNDATION_TASK_ID)
  if (!foundation) return
  expect(foundation.dependsOn).toEqual([])
  expect(result.tasks[0].id).toBe(FOUNDATION_TASK_ID)

  const mine = new Set(foundation.steps.flatMap((step) => step.elementIds))
  const elsewhere = new Set(result.tasks.filter((other) => other !== foundation).flatMap((other) => other.steps.flatMap((step) => step.elementIds)))
  const reported = new Set(result.notes.filter((note) => note.kind === 'foundation-reference').map((note) => note.ids[0]))
  const references = referencesOf(plan)
  // An action shares its controller's fate, so the exception is reported on the controller.
  const controllerOf = new Map(plan.controllers.flatMap((controller) => controller.actions.map((action) => [action.id, controller.id] as const)))
  for (const id of mine) {
    if (reported.has(controllerOf.get(id) ?? id)) continue
    expect((references.get(id) ?? []).filter((target) => elsewhere.has(target)), id).toEqual([])
  }
}

/** Two controllers named after no model render one page, which submits to the Post slice. */
function sharedFormPlan(): PlanDraft {
  const renders = (id: string): object => ({
    id: `controller.${id}`,
    change: ADD,
    className: `${id}Controller`,
    actions: [{ id: `action.${id}.show`, change: ADD, name: 'show', authorization: { middleware: [] }, response: { kind: 'inertia', view: 'view.shared' }, rules: [] }],
  })
  return planFrom({
    models: [model('Post')],
    controllers: [
      renders('Landing'),
      renders('Welcome'),
      {
        id: 'controller.posts',
        change: ADD,
        className: 'PostController',
        actions: [{ id: 'action.posts.store', change: ADD, name: 'store', authorization: { middleware: [] }, response: { kind: 'empty' }, rules: [] }],
      },
    ] as PlanInput['controllers'],
    routes: [{ id: 'route.posts.store', change: ADD, method: 'POST', path: '/posts', name: 'posts.store', action: 'action.posts.store', middleware: [], bind: [] }],
    validators: [{ id: 'validator.post', change: ADD, name: 'PostPayloadSchema', fields: [] }],
    views: [{ ...view('shared/Form'), id: 'view.shared', form: { validator: 'validator.post', submitsTo: 'route.posts.store', fields: [] } }],
  })
}

describe('derivePlanTasks', () => {
  describe('the comments fixture', () => {
    test('should derive one slice with the five fixed steps', () => {
      const slice = COMMENT_SLICE
      const http = COMMENT_HTTP
      const behaviours = ['AC-comments-1', 'AC-comments-2', 'AC-comments-3', 'AC-comments-4']
      const columns = ['column.comment.id', 'column.comment.body', 'column.comment.postId', 'column.comment.createdAt']
      expect(derive()).toEqual({
        notes: [],
        tasks: [
          {
            id: slice,
            title: { kind: 'entity', model: 'model.comment', name: 'Comment' },
            intentIds: ['task.comments'],
            dependsOn: [],
            steps: [
              { id: `${slice}/scaffold`, kind: 'scaffold', elementIds: [], generates: ['model.comment', ...columns, ...http], acceptanceIds: [], verify: ['codegen', 'typecheck'] },
              { id: `${slice}/tests`, kind: 'tests', elementIds: [], generates: [], acceptanceIds: behaviours, verify: ['tests:fail'] },
              { id: `${slice}/data`, kind: 'data', elementIds: ['model.post', 'model.comment', ...columns], generates: [], acceptanceIds: [], verify: ['db:migrate', 'typecheck'] },
              { id: `${slice}/http`, kind: 'http', elementIds: http, generates: [], acceptanceIds: behaviours, verify: ['check', 'codegen', 'tests'] },
              { id: `${slice}/pages`, kind: 'pages', elementIds: ['view.posts.show'], generates: [], acceptanceIds: [], verify: ['typecheck', 'check'] },
            ],
          },
        ],
      })
    })

    test('should own every changed element in exactly one step', () => {
      const plan = parsePlan()
      expectEveryElementOnce(plan, derivePlanTasks(plan))
      expectFoundationStandsAlone(plan, derivePlanTasks(plan))
    })

    test('should derive ids no plan element can carry', () => {
      const plan = loadCommentsPlanInput()
      busyPlan(plan)
      const result = derivePlanTasks(PlanDraftSchema.parse(plan), { splitThreshold: 1 })
      const derived = result.tasks.flatMap((entry) => [entry.id, ...stepIds(entry)])

      expect(derived.length).toBeGreaterThan(8)
      expect(new Set(derived).size).toBe(derived.length)
      for (const id of derived) {
        const asElementId = structuredClone(plan)
        asElementId.commands = [{ id, command: 'guren add session', reason: 'x' }]
        expect(PlanDraftSchema.safeParse(asElementId).success, id).toBe(false)
      }
    })
  })

  describe('assigning elements', () => {
    test('should place elements by reference, use and name when no task covers them', () => {
      const result = derive((plan) => {
        for (const intent of plan.tasks ?? []) intent.covers = []
      })

      // Uncovered, the altered Post is its own slice, and the comment's foreign key waits for it.
      expect(ids(result)).toEqual(['task/entity/model.post', 'task/entity/model.comment'])
      expect(task(result, 'task/entity/model.post').steps.map((step) => step.elementIds)).toEqual([['model.post']])
      const comment = task(result, 'task/entity/model.comment')
      expect(comment.dependsOn).toEqual(['task/entity/model.post'])
      expect(stepsOfKind(result, COMMENT_SLICE, 'http').map((step) => step.elementIds)).toEqual([COMMENT_HTTP])
      expect(comment.steps.find((step) => step.kind === 'pages')?.elementIds).toEqual(['view.posts.show'])
      expect(result.notes).toEqual([])
    })

    test('should keep a nested route with its action rather than with the parent it binds', () => {
      const result = derive((plan) => {
        for (const intent of plan.tasks ?? []) intent.covers = []
        const controller = plan.controllers?.[0]
        if (controller) controller.actions = controller.actions.filter((action) => action.id !== 'action.comments.destroy')
        plan.routes = plan.routes?.filter((route) => route.id === 'route.comments.store')
        plan.policies = []
        if (plan.views?.[0]) plan.views[0].actions = []
        if (plan.tasks?.[0]) plan.tasks[0].acceptance = []
        if (plan.questions?.[0]) plan.questions[0].affects = []
      })

      const http = task(result, 'task/entity/model.comment').steps.find((step) => step.kind === 'http')
      expect(http?.elementIds).toContain('route.comments.store')
    })

    test('should put commands and what several slices use in Foundation, which every task waits for', () => {
      const result = derive(busyPlan)
      const foundation = task(result, FOUNDATION_TASK_ID)

      expect(ids(result)[0]).toBe(FOUNDATION_TASK_ID)
      expect(foundation.title).toEqual({ kind: 'foundation' })
      expect(foundation.dependsOn).toEqual([])
      expect(foundation.steps.map((step) => [step.kind, step.elementIds, step.verify])).toEqual([
        ['commands', ['command.attachments'], ['codegen', 'typecheck']],
        ['http', ['validator.page'], ['check', 'codegen', 'tests']],
      ])
      for (const other of result.tasks.slice(1)) expect(other.dependsOn, other.id).toContain(FOUNDATION_TASK_ID)
      expect(result.notes).toEqual([])
    })

    test('should derive a cross-entity task that waits for every slice it reads', () => {
      const result = derive(busyPlan)
      const cross = task(result, 'task/cross/model.comment+model.post')

      expect(cross.title).toEqual({ kind: 'cross', models: ['model.comment', 'model.post'] })
      expect(cross.dependsOn).toEqual([FOUNDATION_TASK_ID, 'task/entity/model.post', 'task/entity/model.comment'])
      expect(ids(result).at(-1)).toBe(cross.id)
      expect(cross.steps.map((step) => [step.kind, step.elementIds])).toEqual([
        ['http', ['controller.dashboard', 'action.dashboard.index', 'route.dashboard']],
        ['pages', ['view.dashboard.index']],
      ])
    })

    test('should make a slice wait for Foundation even when it reads nothing from it', () => {
      const result = deriveFrom({
        models: [model('Tag')],
        commands: [{ id: 'command.session', command: 'guren add session', reason: 'Sessions move to the database.' }],
      })

      expect(ids(result)).toEqual([FOUNDATION_TASK_ID, 'task/entity/model.tag'])
      expect(task(result, 'task/entity/model.tag').dependsOn).toEqual([FOUNDATION_TASK_ID])
    })

    test('should make a cross-entity task wait for a slice whose elements it reads unchanged', () => {
      const result = derive((plan) => {
        busyPlan(plan)
        plan.commands = []
        for (const entry of plan.resources ?? []) entry.change = { kind: 'existing' }
      })

      expect(task(result, 'task/cross/model.comment+model.post').dependsOn).toEqual([
        FOUNDATION_TASK_ID,
        'task/entity/model.post',
        'task/entity/model.comment',
      ])
    })

    test('should own every changed element once across Foundation, slices and a cross-entity task', () => {
      const plan = parsePlan(busyPlan)
      for (const options of [{}, { splitThreshold: 1, apiOnly: true }]) {
        expectEveryElementOnce(plan, derivePlanTasks(plan, options))
        expectFoundationStandsAlone(plan, derivePlanTasks(plan, options))
      }
    })

    test('should move Foundation work that needs a slice into that slice, and what needed it after it', () => {
      const plan = sharedFormPlan()
      const result = derivePlanTasks(plan)

      // The page needs the Post route, the two controllers need the page, and the validator needs nothing.
      expect(ids(result)).toEqual([FOUNDATION_TASK_ID, 'task/entity/model.post'])
      expect(task(result, FOUNDATION_TASK_ID).steps.map((step) => step.elementIds)).toEqual([['validator.post']])
      expect(stepsOfKind(result, 'task/entity/model.post', 'pages').map((step) => step.elementIds)).toEqual([['view.shared']])
      expect(stepsOfKind(result, 'task/entity/model.post', 'http')[0].elementIds).toEqual([
        'controller.Landing',
        'action.Landing.show',
        'controller.Welcome',
        'action.Welcome.show',
        'controller.posts',
        'action.posts.store',
        'route.posts.store',
      ])
      expect(result.notes).toEqual([])
      expectEveryElementOnce(plan, result)
      expectFoundationStandsAlone(plan, result)
    })

    test('should move Foundation work that needs several slices into their cross-entity task', () => {
      const plan = parsePlan((input) => {
        busyPlan(input)
        // Named after no model and showing no resource, so it starts out in Foundation; it links into two slices.
        const hub = { ...view('hub/Index'), actions: [{ label: 'Posts', route: 'route.posts.index' }, { label: 'Comments', route: 'route.comments.index' }] }
        input.views?.push(hub)
        input.controllers?.push({
          id: 'controller.landing',
          change: ADD,
          className: 'LandingController',
          actions: [{ id: 'action.landing.show', change: ADD, name: 'show', authorization: { middleware: [] }, response: { kind: 'inertia', view: hub.id }, rules: [] }],
        })
        for (const name of ['posts', 'comments']) {
          input.routes?.push({ id: `route.${name}.index`, change: ADD, method: 'GET', path: `/${name}`, name: `${name}.index`, action: `action.${name}.index`, middleware: [], bind: [] })
        }
      })
      const result = derivePlanTasks(plan)

      expect(stepsOfKind(result, 'task/cross/model.comment+model.post', 'pages')[0].elementIds).toContain('view.hub.index')
      expect(stepsOfKind(result, 'task/cross/model.comment+model.post', 'http')[0].elementIds).toContain('action.landing.show')
      expect(result.notes).toEqual([])
      expectEveryElementOnce(plan, result)
      expectFoundationStandsAlone(plan, result)
    })

    test('should report Foundation work that needs a story task, which no slice can take', () => {
      const plan = planFrom({
        validators: [{ id: 'validator.report', change: ADD, name: 'ReportPayloadSchema', fields: [] }],
        views: [
          { ...view('landing/Index'), form: { validator: 'validator.report', submitsTo: 'route.none', fields: [] } },
          { ...view('welcome/Index'), form: { validator: 'validator.report', submitsTo: 'route.none', fields: [] } },
          view('reports/Index'),
        ],
        tasks: [
          { id: 'task.reports', entity: 'Reporting', summary: 'Report a page.', covers: ['view.reports.index'], acceptance: [] },
          { id: 'task.landing', entity: 'Landing', summary: 'Land.', covers: ['view.landing.index'], acceptance: [] },
          { id: 'task.welcome', entity: 'Welcome', summary: 'Welcome.', covers: ['view.welcome.index'], acceptance: [] },
        ],
        sideEffects: [],
        controllers: [
          {
            id: 'controller.home',
            change: ADD,
            className: 'HomeController',
            actions: [{ id: 'action.home.index', change: ADD, name: 'index', body: 'validator.report', authorization: { middleware: [] }, response: { kind: 'inertia', view: 'view.reports.index' }, rules: [] }],
          },
        ],
      })
      const result = derivePlanTasks(plan)

      expect(task(result, FOUNDATION_TASK_ID).dependsOn).toEqual([])
      expect(result.notes.filter((note) => note.kind !== 'intent-story').map((note) => [note.kind, note.ids])).toEqual([
        ['foundation-reference', ['controller.home', 'view.reports.index']],
        ['element-unassigned', ['controller.home']],
      ])
      expectEveryElementOnce(plan, result)
      expectFoundationStandsAlone(plan, result)
    })

    test('should not read a digit after a model name as the start of the next word', () => {
      const result = deriveFrom({
        models: [model('Post')],
        controllers: [{ id: 'controller.post2', change: ADD, className: 'Post2Controller', actions: [] }],
      })

      expect(stepsOfKind(result, FOUNDATION_TASK_ID, 'http').map((step) => step.elementIds)).toEqual([['controller.post2']])
      expect(result.notes.map((note) => [note.kind, note.ids])).toEqual([['element-unassigned', ['controller.post2']]])
    })

    test('should report an element with no evidence and keep it in Foundation', () => {
      const result = deriveFrom({
        sideEffects: [{ id: 'effect.digest', change: ADD, kind: 'job', name: 'WeeklyDigest', trigger: 'cron', description: 'Mails a digest.' }],
      })

      expect(task(result, FOUNDATION_TASK_ID).steps.map((step) => step.elementIds)).toEqual([['effect.digest']])
      expect(result.notes.map((note) => [note.kind, note.ids])).toEqual([['element-unassigned', ['effect.digest']]])
    })

    test('should not report an existing element, which is nobody\'s work', () => {
      const result = deriveFrom({
        sideEffects: [{ id: 'effect.digest', change: { kind: 'existing' }, kind: 'job', name: 'WeeklyDigest', trigger: 'cron', description: 'Mails a digest.' }],
      })

      expect(result).toEqual({ tasks: [], notes: [] })
    })

    test('should produce no work for a plan whose elements are all existing', () => {
      const result = deriveFrom({ models: [model('Post', [], { kind: 'existing' })] })

      expect(result).toEqual({ tasks: [], notes: [] })
    })
  })

  describe('task intents', () => {
    test('should derive a task of its own for an intent naming no model, and report it', () => {
      const result = derive((plan) => {
        plan.tasks?.push({
          id: 'task.moderation',
          entity: 'Moderation queue',
          summary: 'Moderators see reported comments.',
          covers: [],
          acceptance: [
            { id: 'AC-moderation-1', description: 'A guest is sent away.', kind: 'unauthenticated', actor: 'guest', route: 'route.comments.destroy', given: [], expect: { redirect: '/login' } },
          ],
        })
      })
      const story = task(result, 'task/story/task.moderation')

      expect(story.title).toEqual({ kind: 'story', intent: 'task.moderation', name: 'Moderation queue' })
      expect(story.dependsOn).toEqual(['task/entity/model.comment'])
      // Nothing is implemented after these tests, so they must pass rather than fail first.
      expect(story.steps.map((step) => [step.kind, step.acceptanceIds, step.verify])).toEqual([
        ['tests', ['AC-moderation-1'], ['tests']],
      ])
      expect(stepsOfKind(result, COMMENT_SLICE, 'tests')[0].verify).toEqual(['tests:fail'])
      expect(result.notes.map((note) => [note.kind, note.ids])).toEqual([['intent-story', ['task.moderation']]])
    })

    test('should report an intent that no derived task answers', () => {
      const result = derive((plan) => {
        plan.tasks?.push({ id: 'task.nothing', entity: 'Nothing', summary: 'Nothing.', covers: [], acceptance: [] })
      })

      expect(ids(result)).toEqual(['task/entity/model.comment'])
      expect(result.notes.map((note) => [note.kind, note.ids])).toEqual([['intent-empty', ['task.nothing']]])
    })

    test('should resolve an intent to its model by class, id or table', () => {
      for (const entity of ['Comment', 'model.comment', 'comments']) {
        const result = derive((plan) => {
          if (plan.tasks?.[0]) plan.tasks[0].entity = entity
        })
        expect(task(result, 'task/entity/model.comment').intentIds, entity).toEqual(['task.comments'])
      }
    })
  })

  describe('behaviours without an http step', () => {
    const behaviour = (id: string): NonNullable<PlanInput['tasks']>[number]['acceptance'][number] => ({
      id,
      description: 'It holds.',
      kind: 'state',
      actor: 'user',
      route: 'route.elsewhere',
      given: [],
      expect: { status: 200 },
    })

    test('should run the tests from the data step of a slice that has no http step', () => {
      const result = deriveFrom({
        models: [model('Tag')],
        tasks: [{ id: 'task.tags', entity: 'Tag', summary: 'Tags.', covers: [], acceptance: [behaviour('AC-tags-1')] }],
      })

      expect(task(result, 'task/entity/model.tag').steps.map((step) => [step.kind, step.acceptanceIds, step.verify])).toEqual([
        ['scaffold', [], ['codegen', 'typecheck']],
        ['tests', ['AC-tags-1'], ['tests:fail']],
        ['data', ['AC-tags-1'], ['db:migrate', 'typecheck', 'tests']],
      ])
    })

    test('should run the tests from the pages step of a slice that is pages only', () => {
      const result = deriveFrom({
        models: [model('Tag', [], { kind: 'existing' })],
        views: [{ ...view('tags/Index'), change: { kind: 'alter' } }],
        tasks: [{ id: 'task.tags', entity: 'Tag', summary: 'Tags.', covers: ['view.tags.index'], acceptance: [behaviour('AC-tags-1')] }],
      })

      expect(task(result, 'task/entity/model.tag').steps.map((step) => [step.kind, step.acceptanceIds, step.verify])).toEqual([
        ['tests', ['AC-tags-1'], ['tests:fail']],
        ['pages', ['AC-tags-1'], ['typecheck', 'check', 'tests']],
      ])
    })

    test('should put a step that runs the tests on every task that has behaviours and work', () => {
      for (const result of [derive(), derive(busyPlan), derive(undefined, { splitThreshold: 1 })]) {
        for (const derived of result.tasks) {
          const judged = derived.steps.filter((step) => step.kind !== 'tests' && step.acceptanceIds.length > 0)
          const expected = derived.steps.some((step) => step.kind === 'tests') && derived.steps.some((step) => step.elementIds.length > 0) ? 1 : 0
          expect(judged.length, derived.id).toBe(expected)
          for (const step of judged) expect(step.verify, step.id).toContain('tests')
        }
      }
    })

    test('should not add the tests to a step that carries no behaviour', () => {
      const result = deriveFrom({ models: [model('Tag')] })

      expect(stepsOfKind(result, 'task/entity/model.tag', 'data')[0].verify).toEqual(['db:migrate', 'typecheck'])
    })
  })

  describe('parsePlanHint', () => {
    test('should read both relations, whatever their case and spacing', () => {
      expect(parsePlanHint('  Category   BEFORE Tag ')).toEqual({ left: 'Category', relation: 'before', right: 'Tag' })
      expect(parsePlanHint('model.tag after task/entity/model.category')).toEqual({ left: 'model.tag', relation: 'after', right: 'task/entity/model.category' })
    })

    test('should read nothing else as a hint', () => {
      for (const hint of ['do the hard part first', 'Tag before', 'before Tag', 'Tag before Category please', '']) {
        expect(parsePlanHint(hint), hint).toBeUndefined()
      }
    })
  })

  describe('ordering', () => {
    test('should order three slices by their foreign keys, whatever order the plan lists them in', () => {
      const result = deriveFrom({ models: [model('Like', ['comment']), model('Comment', ['post']), model('Post')] })

      expect(ids(result)).toEqual(['task/entity/model.post', 'task/entity/model.comment', 'task/entity/model.like'])
      expect(task(result, 'task/entity/model.like').dependsOn).toEqual(['task/entity/model.comment'])
      expect(task(result, 'task/entity/model.comment').dependsOn).toEqual(['task/entity/model.post'])
      expect(result.notes).toEqual([])
    })

    test('should keep document order between slices nothing orders', () => {
      const result = deriveFrom({ models: [model('Tag'), model('Category')] })

      expect(ids(result)).toEqual(['task/entity/model.tag', 'task/entity/model.category'])
    })

    test('should drop tables child first', () => {
      const drop: ChangeInput = { kind: 'drop', reason: 'Replaced.' }
      const result = deriveFrom({ models: [model('Post', [], drop), model('Comment', ['post'], drop)] })

      expect(ids(result)).toEqual(['task/entity/model.comment', 'task/entity/model.post'])
      expect(task(result, 'task/entity/model.post').dependsOn).toEqual(['task/entity/model.comment'])
    })

    test('should let a hint reorder unordered slices without making it a dependency', () => {
      for (const hint of ['Category before Tag', 'model.tag after model.category', 'task/entity/model.category BEFORE tags']) {
        const result = deriveFrom({ models: [model('Tag'), model('Category')], hints: [hint] })

        expect(ids(result), hint).toEqual(['task/entity/model.category', 'task/entity/model.tag'])
        expect(task(result, 'task/entity/model.tag').dependsOn).toEqual([])
        expect(result.notes).toEqual([])
      }
    })

    test('should ignore and report a hint that contradicts a dependency', () => {
      const result = deriveFrom({ models: [model('Post'), model('Comment', ['post'])], hints: ['Comment before Post'] })

      expect(ids(result)).toEqual(['task/entity/model.post', 'task/entity/model.comment'])
      expect(result.notes.map((note) => [note.kind, note.ids])).toEqual([
        ['hint-contradiction', ['Comment before Post', 'task/entity/model.comment', 'task/entity/model.post']],
      ])
    })

    test('should ignore and report a hint that contradicts a dependency through another task', () => {
      const result = deriveFrom({
        models: [model('Post'), model('Comment', ['post']), model('Like', ['comment'])],
        hints: ['Like before Post'],
      })

      expect(ids(result)).toEqual(['task/entity/model.post', 'task/entity/model.comment', 'task/entity/model.like'])
      expect(result.notes.map((note) => note.kind)).toEqual(['hint-contradiction'])
    })

    test('should report the later of two hints that disagree', () => {
      const result = deriveFrom({ models: [model('Tag'), model('Category')], hints: ['Category before Tag', 'Tag before Category'] })

      expect(ids(result)).toEqual(['task/entity/model.category', 'task/entity/model.tag'])
      expect(result.notes.map((note) => [note.kind, note.ids[0]])).toEqual([['hint-contradiction', 'Tag before Category']])
    })

    test('should report a hint it cannot read, or one naming no derived task', () => {
      const hints = ['do the hard part first', 'Tag before Nothing', 'Tag before Tag']
      const result = deriveFrom({ models: [model('Tag'), model('Category')], hints })

      expect(ids(result)).toEqual(['task/entity/model.tag', 'task/entity/model.category'])
      expect(result.notes.map((note) => [note.kind, note.ids])).toEqual(hints.map((hint) => ['hint-unreadable', [hint]]))
    })
  })

  describe('cycles', () => {
    test('should order mutual foreign keys by the plan and report the dependency it dropped', () => {
      const result = deriveFrom({ models: [model('Post', ['comment']), model('Comment', ['post']), model('Like', ['comment'])] })

      expect(ids(result)).toEqual(['task/entity/model.post', 'task/entity/model.comment', 'task/entity/model.like'])
      expect(task(result, 'task/entity/model.post').dependsOn).toEqual([])
      expect(task(result, 'task/entity/model.comment').dependsOn).toEqual(['task/entity/model.post'])
      expect(result.notes.map((note) => [note.kind, note.ids])).toEqual([
        ['dependency-cycle', ['task/entity/model.post', 'task/entity/model.comment']],
      ])
    })

    test('should cut a cycle inside it, not at the task that merely waits for it', () => {
      const result = deriveFrom({ models: [model('Like', ['comment']), model('Post', ['comment']), model('Comment', ['post'])] })

      expect(ids(result)).toEqual(['task/entity/model.post', 'task/entity/model.comment', 'task/entity/model.like'])
      expect(task(result, 'task/entity/model.like').dependsOn).toEqual(['task/entity/model.comment'])
      expect(result.notes).toHaveLength(1)
    })

    test('should resolve a ring of three', () => {
      const result = deriveFrom({ models: [model('A', ['c']), model('B', ['a']), model('C', ['b'])] })

      expect(ids(result)).toEqual(['task/entity/model.a', 'task/entity/model.b', 'task/entity/model.c'])
      expect(result.notes.map((note) => note.kind)).toEqual(['dependency-cycle'])
    })

    test('should not make a slice wait for itself over a self-reference', () => {
      const result = deriveFrom({ models: [model('Comment', ['comment'])] })

      expect(task(result, 'task/entity/model.comment').dependsOn).toEqual([])
      expect(result.notes).toEqual([])
    })
  })

  describe('scaffolding', () => {
    test('should not scaffold a slice whose model is altered, renamed or dropped', () => {
      const changes: ChangeInput[] = [{ kind: 'alter' }, { kind: 'rename', from: 'Remark' }, { kind: 'drop', reason: 'Unused.' }]
      for (const change of changes) {
        const result = derive((plan) => {
          const comment = plan.models?.find((entry) => entry.id === 'model.comment')
          if (comment) comment.change = change
        })
        const kinds = task(result, 'task/entity/model.comment').steps.map((step) => step.kind)
        expect(kinds, change.kind).toEqual(['tests', 'data', 'http', 'pages'])
      }
    })

    test('should generate only what the plan adds', () => {
      const result = derive((plan) => {
        const policy = plan.policies?.[0]
        if (policy) policy.change = { kind: 'alter' }
      })
      const scaffold = task(result, 'task/entity/model.comment').steps[0]

      expect(scaffold.kind).toBe('scaffold')
      expect(scaffold.generates).not.toContain('policy.comment')
      expect(scaffold.generates).not.toContain('model.post')
      expect(scaffold.generates).not.toContain('view.posts.show')
      expect(scaffold.generates).toContain('resource.comment')
    })

    test('should not scaffold an API-only application', () => {
      const kinds = task(derive(undefined, { apiOnly: true }), 'task/entity/model.comment').steps.map((step) => step.kind)

      expect(kinds).toEqual(['tests', 'data', 'http', 'pages'])
    })
  })

  describe('splitting', () => {
    test('should leave a step at the threshold whole and split one past it', () => {
      const whole = task(derive(), 'task/entity/model.comment')
      expect(stepIds(whole)).toContain('task/entity/model.comment/http')

      const split = task(derive(undefined, { splitThreshold: 4 }), 'task/entity/model.comment')
      const http = split.steps.filter((step) => step.kind === 'http')
      expect(http.map((step) => [step.id, step.part, step.elementIds])).toEqual([
        [
          'task/entity/model.comment/http/1',
          { index: 1, of: 2 },
          ['validator.comment', 'controller.comments', 'action.comments.store', 'action.comments.destroy', 'route.comments.store', 'route.comments.destroy', 'resource.comment'],
        ],
        ['task/entity/model.comment/http/2', { index: 2, of: 2 }, ['policy.comment']],
      ])
      // The behaviours are judged once every route is finished.
      expect(http.map((step) => step.acceptanceIds.length)).toEqual([0, 4])
    })

    test('should split pages by screen group before it splits a group', () => {
      const pages = ['posts/Index', 'posts/Show', 'posts/Edit', 'comments/Index', 'comments/Show', 'tags/Index']
      const result = deriveFrom({ models: [model('Post')], resources: [resource('Post')], views: pages.map((page) => view(page, ['resource.post'])) }, { splitThreshold: 3 })
      const parts = task(result, 'task/entity/model.post').steps.filter((step) => step.kind === 'pages')

      expect(parts.map((step) => step.elementIds)).toEqual([
        ['view.posts.index', 'view.posts.show', 'view.posts.edit'],
        ['view.comments.index', 'view.comments.show', 'view.tags.index'],
      ])
    })

    test('should move a group to the next part whole rather than straddle two', () => {
      const pages = ['posts/Index', 'posts/Show', 'comments/Index', 'comments/Show', 'comments/Edit']
      const result = deriveFrom({ models: [model('Post')], resources: [resource('Post')], views: pages.map((page) => view(page, ['resource.post'])) }, { splitThreshold: 4 })
      const parts = task(result, 'task/entity/model.post').steps.filter((step) => step.kind === 'pages')

      expect(parts.map((step) => step.elementIds.length)).toEqual([2, 3])
    })

    test('should fall back to the default for a threshold that is no count', () => {
      for (const splitThreshold of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
        expect(derive(undefined, { splitThreshold })).toEqual(derive())
      }
      const parts = task(derive(undefined, { splitThreshold: 0 }), 'task/entity/model.comment').steps.filter((step) => step.kind === 'http')
      expect(parts).toHaveLength(5)
    })
  })

  describe('determinism', () => {
    function reversedKeys(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(reversedKeys)
      if (value === null || typeof value !== 'object') return value
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, entry]) => [key, reversedKeys(entry)]),
      )
    }

    test('should derive the same tasks from the same plan spelled with another key order', () => {
      const input = loadCommentsPlanInput()
      busyPlan(input)
      input.hints = ['Comment before Post', 'dashboard last']
      const shuffled = JSON.parse(JSON.stringify(reversedKeys(input))) as unknown

      expect(Object.keys(shuffled as object)).not.toEqual(Object.keys(input))
      const first = JSON.stringify(derivePlanTasks(PlanDraftSchema.parse(input)))
      expect(JSON.stringify(derivePlanTasks(PlanDraftSchema.parse(shuffled)))).toBe(first)
      expect(JSON.stringify(derivePlanTasks(PlanDraftSchema.parse(input)))).toBe(first)
    })

    test('should keep a slice id when an unrelated entity joins the plan', () => {
      const before = task(derive(), 'task/entity/model.comment')
      const after = task(
        derive((plan) => {
          plan.models?.unshift(model('Tag'))
        }),
        'task/entity/model.comment',
      )

      expect(after).toEqual(before)
    })
  })
})
