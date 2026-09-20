/**
 * Task derivation (RFC 0030 §5): which tasks and steps a plan yields, as a pure
 * function of the plan. It scaffolds nothing and runs nothing; verify commands are names.
 * An element is owned by exactly one step, the one whose verification completes it.
 * Owner: the one task intent covering it, else the models it references, else what
 * uses it, else its name. No evidence is Foundation, with a note.
 * Derived ids contain `/`, which no plan id can, so the two never collide.
 * No recursion over the plan and no array spread into a call, as in `flow.ts`.
 */

import { collectionName, collectionSlug } from '../inflect'
import { listPlanElements, type PlanChange, type PlanDraft, type PlanModel } from './schema'

export type PlanStepKind = 'commands' | 'scaffold' | 'tests' | 'data' | 'http' | 'pages'

/** A verify command by name. `plan:verify` owns what each one spawns; a plan string never does (§8). */
export type PlanVerifyCommand = 'codegen' | 'typecheck' | 'db:migrate' | 'check' | 'tests' | 'tests:fail'

export const PLAN_STEP_VERIFY: Record<PlanStepKind, readonly PlanVerifyCommand[]> = {
  commands: ['codegen', 'typecheck'],
  scaffold: ['codegen', 'typecheck'],
  tests: ['tests:fail'],
  data: ['db:migrate', 'typecheck'],
  http: ['check', 'codegen', 'tests'],
  pages: ['typecheck', 'check'],
}

export const DEFAULT_SPLIT_THRESHOLD = 5

export const FOUNDATION_TASK_ID = 'task/foundation'

/** What a task is named after. The words are the page's, in its locale. */
export type PlanTaskTitle =
  | { kind: 'foundation' }
  | { kind: 'entity'; model: string; name: string }
  | { kind: 'story'; intent: string; name: string }
  | { kind: 'cross'; models: string[] }

export interface PlanDerivedStep {
  id: string
  kind: PlanStepKind
  /** The elements this step completes. Empty for `scaffold` and `tests`, which complete on their commands. */
  elementIds: string[]
  /** `scaffold` only: the added elements the generators write a first version of. */
  generates: string[]
  /** On `tests`, which writes their skeletons, and on the step that must see them pass. */
  acceptanceIds: string[]
  verify: PlanVerifyCommand[]
  /** Present when the step kind was split; `index` starts at 1. */
  part?: { index: number; of: number }
}

export interface PlanDerivedTask {
  id: string
  title: PlanTaskTitle
  /** The model's `tasks[]` entries this task answers. */
  intentIds: string[]
  dependsOn: string[]
  /** In order: a step depends on the ones before it. */
  steps: PlanDerivedStep[]
}

export type PlanTaskNoteKind =
  | 'intent-story'
  | 'intent-empty'
  | 'element-unassigned'
  | 'dependency-cycle'
  | 'hint-unreadable'
  | 'hint-contradiction'

export interface PlanTaskNote {
  kind: PlanTaskNoteKind
  message: string
  /** Plan ids, derived task ids, or for a hint its text. */
  ids: string[]
}

export interface PlanTaskDerivation {
  tasks: PlanDerivedTask[]
  notes: PlanTaskNote[]
}

export interface DerivePlanTasksOptions {
  /** `PlanAppState.apiOnly`: `make:feature` refuses such an app, so no slice is scaffolded. */
  apiOnly?: boolean
  /** Files a step may touch before it is split. */
  splitThreshold?: number
}

type ChangeKind = PlanChange['kind']

interface WorkElement {
  id: string
  step: Exclude<PlanStepKind, 'scaffold' | 'tests'>
  change: ChangeKind
  /** Elements sharing a file share a key: a column its model's, an action its controller's, routes one registrar. */
  file: string
  scaffoldable: boolean
  /** Pages only: the directory a split keeps together. */
  group?: string
}

interface TaskDraft {
  id: string
  title: PlanTaskTitle
  order: number
  intentIds: string[]
  elements: WorkElement[]
  acceptanceIds: string[]
  dependsOn: Set<string>
}

// Routes share one registrar per slice. The `/` keeps the key apart from every element id.
const ROUTES_FILE = '/routes'
const STEP_ORDER = ['commands', 'data', 'http', 'pages'] as const

const entityTaskId = (modelId: string): string => `task/entity/${modelId}`
const storyTaskId = (intentId: string): string => `task/story/${intentId}`
const crossTaskId = (modelIds: readonly string[]): string => `task/cross/${modelIds.join('+')}`

function distinct(values: Iterable<string | undefined>): string[] {
  const seen = new Set<string>()
  for (const value of values) {
    if (value !== undefined) seen.add(value)
  }
  return [...seen]
}

/** The model a task intent's `entity` names: by class, then by id, then by table. */
function modelOfIntent(models: readonly PlanModel[], entity: string): PlanModel | undefined {
  return (
    models.find((model) => model.name === entity) ??
    models.find((model) => model.id === entity) ??
    models.find((model) => model.table === entity)
  )
}

/**
 * The model an element is named after: `CommentController` starts with `Comment`, the
 * route `comments.store` and the page `comments/Index` start with its collection. The
 * longest class name wins, so `PostCommentPolicy` is `PostComment`'s where both exist.
 */
function modelNamedBy(models: readonly PlanModel[], names: { className?: string; collection?: string }): string | undefined {
  let best: PlanModel | undefined
  const className = names.className
  if (className !== undefined) {
    for (const model of models) {
      if (!className.startsWith(model.name)) continue
      // `Postcard` is not `Post`'s: the class name must end where the next word starts.
      if (/^[a-z]/u.test(className.slice(model.name.length))) continue
      if (!best || model.name.length > best.name.length) best = model
    }
  }
  const collection = names.collection?.toLowerCase()
  if (!best && collection !== undefined) {
    best = models.find((model) =>
      [collectionSlug(model.name), collectionName(model.name), model.table].some(
        (spelling) => spelling.toLowerCase() === collection,
      ),
    )
  }
  return best?.id
}

export function derivePlanTasks(plan: PlanDraft, options: DerivePlanTasksOptions = {}): PlanTaskDerivation {
  const threshold = splitThreshold(options.splitThreshold)
  const notes: PlanTaskNote[] = []
  const drafts = new Map<string, TaskDraft>()
  const modelById = new Map(plan.models.map((model) => [model.id, model]))

  const draft = (id: string, title: PlanTaskTitle): TaskDraft => {
    let found = drafts.get(id)
    if (!found) {
      found = { id, title, order: drafts.size, intentIds: [], elements: [], acceptanceIds: [], dependsOn: new Set() }
      drafts.set(id, found)
    }
    return found
  }
  const entityDraft = (modelId: string): TaskDraft => {
    const model = modelById.get(modelId) as PlanModel
    return draft(entityTaskId(modelId), { kind: 'entity', model: modelId, name: model.name })
  }

  // Declared first, so document order among tasks is: Foundation, the models' slices, then the rest.
  draft(FOUNDATION_TASK_ID, { kind: 'foundation' })
  for (const model of plan.models) entityDraft(model.id)

  /** Element id → the tasks of the intents covering it. */
  const coveredBy = new Map<string, Set<string>>()
  const intentTask = new Map<string, TaskDraft>()
  for (const intent of plan.tasks) {
    const model = modelOfIntent(plan.models, intent.entity)
    const task = model
      ? entityDraft(model.id)
      : draft(storyTaskId(intent.id), { kind: 'story', intent: intent.id, name: intent.entity })
    intentTask.set(intent.id, task)
    for (const covered of intent.covers) {
      const bucket = coveredBy.get(covered)
      if (bucket) bucket.add(task.id)
      else coveredBy.set(covered, new Set([task.id]))
    }
  }

  /** Element id → its task, for every element including `existing` ones: a changed action follows an existing controller. */
  const owner = new Map<string, TaskDraft>()
  const hasWork = new Set<string>()

  const place = (task: TaskDraft, element: WorkElement): void => {
    owner.set(element.id, task)
    if (element.change === 'existing') return
    hasWork.add(element.id)
    task.elements.push(element)
  }

  const coveredOnce = (id: string): TaskDraft | undefined => {
    const tasks = coveredBy.get(id)
    return tasks?.size === 1 ? drafts.get(tasks.values().next().value as string) : undefined
  }

  const decide = (
    id: string,
    evidence: { models?: string[]; users?: Array<TaskDraft | undefined>; className?: string; collection?: string },
  ): TaskDraft => {
    const covered = coveredOnce(id)
    if (covered) return covered

    const models = distinct(evidence.models ?? []).filter((modelId) => modelById.has(modelId))
    if (models.length === 1) return entityDraft(models[0])
    if (models.length > 1) {
      const named = modelNamedBy(
        models.map((modelId) => modelById.get(modelId) as PlanModel),
        evidence,
      )
      if (named !== undefined) return entityDraft(named)
      const sorted = [...models].sort()
      return draft(crossTaskId(sorted), { kind: 'cross', models: sorted })
    }

    const users = distinct((evidence.users ?? []).map((task) => task?.id))
    if (users.length === 1) return drafts.get(users[0]) as TaskDraft
    if (users.length > 1) return drafts.get(FOUNDATION_TASK_ID) as TaskDraft

    const named = modelNamedBy(plan.models, evidence)
    if (named !== undefined) return entityDraft(named)

    notes.push({
      kind: 'element-unassigned',
      message: `"${id}" is covered by no single task, references no model and is named after none, so it is Foundation work. Cover it from one task to place it.`,
      ids: [id],
    })
    return drafts.get(FOUNDATION_TASK_ID) as TaskDraft
  }

  const resourceModel = new Map(plan.resources.map((resource) => [resource.id, resource.model]))
  const policyModel = new Map(plan.policies.map((policy) => [policy.id, policy.model]))
  const viewModels = new Map(
    plan.views.map((view) => [view.id, distinct(view.props.map((prop) => resourceModel.get(prop.resource ?? '')))]),
  )

  for (const command of plan.commands) {
    place(drafts.get(FOUNDATION_TASK_ID) as TaskDraft, {
      id: command.id,
      step: 'commands',
      change: 'add',
      file: command.id,
      scaffoldable: false,
    })
  }

  for (const model of plan.models) {
    // An altered table one other slice covers is that slice's edit (the `hasMany` a new child needs);
    // a table that is added, renamed or dropped anchors its own slice, since foreign-key order hangs on it.
    const covered = coveredOnce(model.id)
    const movable = model.change.kind === 'alter' || model.change.kind === 'existing'
    const task = movable && covered ? covered : entityDraft(model.id)
    place(task, { id: model.id, step: 'data', change: model.change.kind, file: model.id, scaffoldable: true })
    for (const column of model.columns) {
      place(task, { id: column.id, step: 'data', change: column.change.kind, file: model.id, scaffoldable: true })
    }
  }

  for (const resource of plan.resources) {
    const task = decide(resource.id, { models: [resource.model], className: resource.name })
    place(task, { id: resource.id, step: 'http', change: resource.change.kind, file: resource.id, scaffoldable: true })
  }
  for (const policy of plan.policies) {
    const task = decide(policy.id, { models: [policy.model], className: policy.name })
    place(task, { id: policy.id, step: 'http', change: policy.change.kind, file: policy.id, scaffoldable: true })
  }

  /** View id → the controllers rendering it, filled as controllers are placed. */
  const renderedBy = new Map<string, TaskDraft[]>()
  const validatorUsers = new Map<string, Array<TaskDraft | undefined>>()
  const uses = (validator: string | undefined, task: TaskDraft | undefined): void => {
    if (validator === undefined) return
    const bucket = validatorUsers.get(validator)
    if (bucket) bucket.push(task)
    else validatorUsers.set(validator, [task])
  }

  for (const controller of plan.controllers) {
    const models: Array<string | undefined> = []
    for (const action of controller.actions) {
      models.push(policyModel.get(action.authorization.policy?.id ?? ''))
      if (action.response.kind === 'resource') models.push(resourceModel.get(action.response.resource))
      if (action.response.kind === 'inertia') {
        for (const modelId of viewModels.get(action.response.view) ?? []) models.push(modelId)
      }
    }
    const task = decide(controller.id, { models: distinct(models), className: controller.className })
    place(task, { id: controller.id, step: 'http', change: controller.change.kind, file: controller.id, scaffoldable: true })
    for (const action of controller.actions) {
      place(task, { id: action.id, step: 'http', change: action.change.kind, file: controller.id, scaffoldable: true })
      uses(action.body, task)
      uses(action.params, task)
      uses(action.query, task)
      if (action.response.kind === 'inertia') {
        const bucket = renderedBy.get(action.response.view)
        if (bucket) bucket.push(task)
        else renderedBy.set(action.response.view, [task])
      }
    }
  }

  for (const route of plan.routes) {
    const dispatchesTo = owner.get(route.action)
    // A nested route binds its parent's model too, so binds speak only when the action is not in the plan.
    const task = decide(route.id, {
      models: dispatchesTo ? [] : route.bind.map((bind) => bind.model),
      users: [dispatchesTo],
      collection: route.name.split('.')[0],
    })
    place(task, { id: route.id, step: 'http', change: route.change.kind, file: ROUTES_FILE, scaffoldable: true })
  }

  for (const view of plan.views) {
    const group = view.page.split('/')[0]
    const task = decide(view.id, { models: viewModels.get(view.id), users: renderedBy.get(view.id), collection: group })
    place(task, { id: view.id, step: 'pages', change: view.change.kind, file: view.id, scaffoldable: true, group })
    uses(view.form?.validator, task)
  }

  for (const validator of plan.validators) {
    const task = decide(validator.id, { users: validatorUsers.get(validator.id), className: validator.name })
    place(task, { id: validator.id, step: 'http', change: validator.change.kind, file: validator.id, scaffoldable: true })
  }

  for (const effect of plan.sideEffects) {
    const task = decide(effect.id, { className: effect.name })
    place(task, { id: effect.id, step: 'http', change: effect.change.kind, file: effect.id, scaffoldable: false })
  }

  const routeIds = new Set(plan.routes.map((route) => route.id))
  for (const intent of plan.tasks) {
    const task = intentTask.get(intent.id) as TaskDraft
    task.intentIds.push(intent.id)
    for (const behaviour of intent.acceptance) task.acceptanceIds.push(behaviour.id)

  }

  const live = (task: TaskDraft | undefined): task is TaskDraft =>
    task !== undefined && (task.elements.length > 0 || task.acceptanceIds.length > 0)

  for (const intent of plan.tasks) {
    const task = intentTask.get(intent.id) as TaskDraft
    if (!live(task)) {
      notes.push({
        kind: 'intent-empty',
        message: `Task "${intent.id}" covers nothing the plan changes and states no behaviour, so no derived task answers it.`,
        ids: [intent.id],
      })
    } else if (task.title.kind === 'story') {
      notes.push({
        kind: 'intent-story',
        message: `Task "${intent.id}" names "${intent.entity}", which is no model of the plan. It is derived as a task of its own, after every task it reads.`,
        ids: [intent.id],
      })
    }
  }

  const depend = (task: TaskDraft | undefined, on: TaskDraft | undefined): void => {
    if (!live(task) || !live(on) || task === on || task.id === FOUNDATION_TASK_ID) return
    task.dependsOn.add(on.id)
  }
  /** `from` waits for the task doing `target`'s work; an `existing` target is already there. */
  const reads = (from: string, target: string | undefined): void => {
    if (target !== undefined && hasWork.has(target)) depend(owner.get(from), owner.get(target))
  }

  for (const model of plan.models) {
    for (const column of model.columns) {
      const target = column.references?.model
      if (target === undefined) continue
      // Tables are dropped child first, the reverse of how they are created.
      if (modelById.get(target)?.change.kind === 'drop') reads(target, column.id)
      else if (column.change.kind !== 'drop') reads(column.id, target)
    }
  }
  // A relationship is left out on purpose: `hasMany` mirrors the foreign key pointing back, and would close a cycle with it.
  for (const resource of plan.resources) reads(resource.id, resource.model)
  for (const policy of plan.policies) reads(policy.id, policy.model)
  for (const controller of plan.controllers) {
    for (const action of controller.actions) {
      reads(action.id, action.body)
      reads(action.id, action.params)
      reads(action.id, action.query)
      reads(action.id, action.authorization.policy?.id)
      if (action.response.kind === 'inertia') reads(action.id, action.response.view)
      if (action.response.kind === 'resource') reads(action.id, action.response.resource)
    }
  }
  for (const route of plan.routes) {
    reads(route.id, route.action)
    for (const bind of route.bind) reads(route.id, bind.model)
  }
  for (const view of plan.views) {
    for (const prop of view.props) reads(view.id, prop.resource)
    reads(view.id, view.form?.validator)
    reads(view.id, view.form?.submitsTo)
    for (const action of view.actions) reads(view.id, action.route)
  }
  for (const intent of plan.tasks) {
    const task = intentTask.get(intent.id)
    for (const behaviour of intent.acceptance) {
      if (routeIds.has(behaviour.route) && hasWork.has(behaviour.route)) depend(task, owner.get(behaviour.route))
    }
  }

  const tasks = [...drafts.values()].filter(live)
  const foundation = drafts.get(FOUNDATION_TASK_ID) as TaskDraft
  for (const task of tasks) {
    depend(task, foundation)
    // A cross-entity task waits for every slice it reads, whether or not the element it reads changes.
    if (task.title.kind === 'cross') {
      for (const modelId of task.title.models) depend(task, drafts.get(entityTaskId(modelId)))
    }
  }

  breakCycles(tasks, notes)
  const ordered = order(tasks, hintEdges(plan, tasks, drafts, intentTask, notes))
  const position = new Map(ordered.map((task, index) => [task.id, index]))
  const documentOrder = new Map(listPlanElements(plan).map((ref, index) => [ref.id, index]))
  for (const task of tasks) {
    task.elements.sort((a, b) => (documentOrder.get(a.id) as number) - (documentOrder.get(b.id) as number))
  }

  return {
    tasks: ordered.map((task) => ({
      id: task.id,
      title: task.title,
      intentIds: task.intentIds,
      dependsOn: [...task.dependsOn].sort((a, b) => (position.get(a) as number) - (position.get(b) as number)),
      steps: stepsOf(task, threshold, options.apiOnly === true, modelById),
    })),
    notes,
  }
}

function splitThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SPLIT_THRESHOLD
  return Math.max(1, Math.floor(value))
}

/**
 * Makes `dependsOn` acyclic, which `plan:next` needs to ever return a task inside a
 * cycle. From the first stuck task in document order, following first unmet
 * dependencies must revisit a task; that loop's first member in document order loses
 * its edge into the loop. Mutual foreign keys are the case: one of them is a later migration.
 */
function breakCycles(tasks: readonly TaskDraft[], notes: PlanTaskNote[]): void {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const done = new Set<string>()
  const unmet = (task: TaskDraft): TaskDraft | undefined => {
    let first: TaskDraft | undefined
    for (const id of task.dependsOn) {
      const dependency = byId.get(id) as TaskDraft
      if (!done.has(id) && (!first || dependency.order < first.order)) first = dependency
    }
    return first
  }

  while (done.size < tasks.length) {
    const ready = tasks.find((task) => !done.has(task.id) && !unmet(task))
    if (ready) {
      done.add(ready.id)
      continue
    }

    const path: TaskDraft[] = []
    let at = tasks.find((task) => !done.has(task.id)) as TaskDraft
    while (!path.includes(at)) {
      path.push(at)
      at = unmet(at) as TaskDraft
    }
    const loop = path.slice(path.indexOf(at))
    const first = loop.reduce((a, b) => (b.order < a.order ? b : a))
    const dropped = loop[(loop.indexOf(first) + 1) % loop.length]
    first.dependsOn.delete(dropped.id)
    notes.push({
      kind: 'dependency-cycle',
      message: `${loop.map((task) => `"${task.id}"`).join(', ')} depend on each other. "${first.id}" comes first in the plan, so it no longer waits for "${dropped.id}"; what it needs from there is left to the later task.`,
      ids: loop.map((task) => task.id),
    })
  }
}

const HINT_PATTERN = /^\s*(\S+)\s+(before|after)\s+(\S+)\s*$/iu

/**
 * A hint is `<task> before <task>` or `<task> after <task>`, a task being a derived task
 * id, a `tasks[]` id, a model id, a model class or a table. Each accepted hint is an
 * ordering edge and never a dependency. One that a dependency, or an earlier hint,
 * already answers the other way is reported and dropped.
 */
function hintEdges(
  plan: PlanDraft,
  tasks: readonly TaskDraft[],
  drafts: ReadonlyMap<string, TaskDraft>,
  intentTask: ReadonlyMap<string, TaskDraft>,
  notes: PlanTaskNote[],
): Map<string, Set<string>> {
  const live = new Set(tasks.map((task) => task.id))
  const after = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]))

  const resolve = (name: string): string | undefined => {
    const model = modelOfIntent(plan.models, name)
    const id = drafts.get(name)?.id ?? intentTask.get(name)?.id ?? (model ? entityTaskId(model.id) : undefined)
    return id !== undefined && live.has(id) ? id : undefined
  }
  /** Whether `from` already has to come after `target`, by any chain of edges. */
  const waitsFor = (from: string, target: string): boolean => {
    const seen = new Set([from])
    const stack = [from]
    while (stack.length > 0) {
      const at = stack.pop() as string
      if (at === target) return true
      for (const next of after.get(at) as Set<string>) {
        if (!seen.has(next)) {
          seen.add(next)
          stack.push(next)
        }
      }
    }
    return false
  }

  for (const hint of plan.hints) {
    const match = HINT_PATTERN.exec(hint)
    const left = match ? resolve(match[1]) : undefined
    const right = match ? resolve(match[3]) : undefined
    if (!match || left === undefined || right === undefined || left === right) {
      notes.push({
        kind: 'hint-unreadable',
        message: `The hint "${hint}" is not "<task> before <task>" or "<task> after <task>" between two derived tasks, so it orders nothing.`,
        ids: [hint],
      })
      continue
    }
    const [first, second] = match[2].toLowerCase() === 'before' ? [left, right] : [right, left]
    if (waitsFor(first, second)) {
      notes.push({
        kind: 'hint-contradiction',
        message: `The hint "${hint}" puts "${first}" before "${second}", but "${first}" has to come after it. The hint is ignored.`,
        ids: [hint, first, second],
      })
      continue
    }
    ;(after.get(second) as Set<string>).add(first)
  }
  return after
}

/** Topological order over an acyclic `after`, the earliest task in document order first among the ready ones. */
function order(tasks: readonly TaskDraft[], after: ReadonlyMap<string, Set<string>>): TaskDraft[] {
  const out: TaskDraft[] = []
  const done = new Set<string>()
  while (out.length < tasks.length) {
    const next = tasks.find((task) => {
      if (done.has(task.id)) return false
      for (const id of after.get(task.id) as Set<string>) {
        if (!done.has(id)) return false
      }
      return true
    }) as TaskDraft
    done.add(next.id)
    out.push(next)
  }
  return out
}

function stepsOf(
  task: TaskDraft,
  threshold: number,
  apiOnly: boolean,
  modelById: ReadonlyMap<string, PlanModel>,
): PlanDerivedStep[] {
  const steps: PlanDerivedStep[] = []
  const step = (kind: PlanStepKind, fields: Partial<PlanDerivedStep> = {}): PlanDerivedStep => ({
    id: `${task.id}/${kind}`,
    kind,
    elementIds: [],
    generates: [],
    acceptanceIds: [],
    verify: [...PLAN_STEP_VERIFY[kind]],
    ...fields,
  })

  // `make:feature` writes a new entity and refuses an existing one, so only a slice that adds its own model is scaffolded.
  const model = task.title.kind === 'entity' ? modelById.get(task.title.model) : undefined
  const scaffolded = !apiOnly && model?.change.kind === 'add' && task.elements.some((element) => element.id === model.id)
  if (scaffolded) {
    const generates = task.elements.filter((element) => element.scaffoldable && element.change === 'add')
    steps.push(step('scaffold', { generates: generates.map((element) => element.id) }))
  }
  if (task.acceptanceIds.length > 0) steps.push(step('tests', { acceptanceIds: [...task.acceptanceIds] }))

  for (const kind of STEP_ORDER) {
    const parts = split(
      task.elements.filter((element) => element.step === kind),
      threshold,
    )
    parts.forEach((elements, index) => {
      const part = parts.length > 1 ? { index: index + 1, of: parts.length } : undefined
      steps.push(
        step(kind, {
          id: part ? `${task.id}/${kind}/${part.index}` : `${task.id}/${kind}`,
          elementIds: elements.map((element) => element.id),
          ...(part ? { part } : {}),
        }),
      )
    })
  }

  // The behaviours are judged where the routes are finished: the last `http` step, or the task's last step without one.
  let verifies: PlanDerivedStep | undefined
  for (const candidate of steps) {
    if (candidate.kind === 'http' || verifies?.kind !== 'http') verifies = candidate
  }
  if (verifies && verifies.kind !== 'tests') verifies.acceptanceIds = [...task.acceptanceIds]
  return steps
}

/**
 * Packs elements into parts of at most `threshold` files, in document order. Elements
 * of one file never part, and a screen group moves to the next part whole rather than
 * straddle two, unless it is wider than a part by itself.
 */
function split(elements: readonly WorkElement[], threshold: number): WorkElement[][] {
  const groups: Array<{ key: string; files: Map<string, WorkElement[]> }> = []
  for (const element of elements) {
    const key = element.group ?? ''
    let group = groups.find((candidate) => candidate.key === key)
    if (!group) {
      group = { key, files: new Map() }
      groups.push(group)
    }
    const file = group.files.get(element.file)
    if (file) file.push(element)
    else group.files.set(element.file, [element])
  }

  const parts: WorkElement[][] = []
  let current: WorkElement[] = []
  let used = 0
  const close = (): void => {
    if (current.length > 0) parts.push(current)
    current = []
    used = 0
  }

  for (const group of groups) {
    if (used > 0 && used + group.files.size > threshold) close()
    for (const file of group.files.values()) {
      if (used === threshold) close()
      for (const element of file) current.push(element)
      used += 1
    }
  }
  close()
  return parts
}
