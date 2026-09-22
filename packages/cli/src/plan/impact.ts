/**
 * Impact (RFC 0030 §2): for each plan element that changes something the application
 * already has, the consumers the existing readers and the column-consumer scan find.
 * Pure: `impact-sources.ts` reads the application. Every list is a lower bound, and an
 * empty one means nothing was found, never that nothing is affected; a reader that
 * could not look says so beside it. The breaking rule stays `planBreakingChanges()`.
 */

import type { ColumnConsumerScan, ColumnRead, ResourceModelTie } from '../column-consumers'
import { inAppRoot, isTestFileNamedFor, moduleNameFromRelPath } from '../discovery'
import type { PlanAppActionDetail, PlanAppClassDetail } from './app-detail'
import type { PlanAppScope } from './app-state'
import type { PlanBreakingChange } from './page/payload'
import type { PlanChange, PlanDraft, PlanElementSection } from './schema'

export interface PlanImpactRoute {
  name?: string
  method: string
  path: string
  /** `ClassName.action`; absent for an inline or prototype handler. */
  action?: string
  /** Route parameter → bound model class, resolved from {@link PlanImpactRoute.module}. */
  bindings: Record<string, string>
  /** The module whose registrar declared the route, or `null`. */
  module: PlanAppScope
  /** The tool `deriveAgentTools()` derives from the route, when it publishes one. */
  toolName?: string
}

export interface PlanImpactModel {
  className: string
  module: PlanAppScope
  file: string
  relationships: Array<{ name: string; type: string; relatedModel?: string }>
}

/** The readers a finding rests on; each has its own sentence when it could not look. */
export type PlanImpactReader = 'models' | 'routes' | 'controllers' | 'resources' | 'policies' | 'pages' | 'tests'

export interface PlanImpactSources {
  routes: PlanImpactRoute[]
  models: PlanImpactModel[]
  actions: PlanAppActionDetail[]
  resources: ResourceModelTie[]
  policies: PlanAppClassDetail[]
  /** App-relative test files. */
  tests: string[]
  reads: ColumnConsumerScan
  /** A reader that could not look, and why: its empty list above is not a finding. */
  unreadable: Partial<Record<PlanImpactReader, string>>
  /** Model files that yielded no model class, so a column of theirs is scanned for nothing. */
  unparsedModels: string[]
  /** Page ids with no component file to scan. */
  missingPages: string[]
}

export type PlanImpactConsumerKind =
  | 'route'
  | 'apiRoute'
  | 'agentTool'
  | 'action'
  | 'model'
  | 'resource'
  | 'policy'
  | 'page'
  | 'test'
  | 'read'
  | 'write'
  | 'opaqueRead'
  | 'opaqueWrite'

export interface PlanImpactConsumer {
  kind: PlanImpactConsumerKind
  name: string
  file?: string
  line?: number
  /** The resource whose data type tied a page's read to the model. */
  via?: string
}

export interface PlanImpactNote {
  /** An `impact.*` key of the page's dictionaries. */
  key: string
  values: Record<string, string>
}

export interface PlanImpactEntry {
  elementId: string
  section: PlanElementSection
  consumers: PlanImpactConsumer[]
  notes: PlanImpactNote[]
}

const READER_KEYS: Record<PlanImpactReader, string> = {
  models: 'impact.unreadable.models',
  routes: 'impact.unreadable.routes',
  controllers: 'impact.unreadable.controllers',
  resources: 'impact.unreadable.resources',
  policies: 'impact.unreadable.policies',
  pages: 'impact.unreadable.pages',
  tests: 'impact.unreadable.tests',
}

function changes(change: PlanChange): boolean {
  return change.kind === 'alter' || change.kind === 'rename' || change.kind === 'drop'
}

const NO_SOURCES: PlanImpactSources = {
  routes: [],
  models: [],
  actions: [],
  resources: [],
  policies: [],
  tests: [],
  reads: { reads: [], opaque: [], resources: [], unreadable: [] },
  unreadable: {},
  unparsedModels: [],
  missingPages: [],
}

/**
 * Whether a plan changes anything the application has, which is the only case Impact
 * reads the app for. Asked of `planImpact()` itself, so the two cannot disagree on a kind.
 */
export function planChangesExisting(plan: PlanDraft): boolean {
  return planImpact(plan, NO_SOURCES).length > 0
}

/** The name the application knows the element by today: a rename's `from`. */
function currentName(name: string, change: PlanChange): string {
  return change.kind === 'rename' ? change.from : name
}

function routeLabel(route: PlanImpactRoute): string {
  return route.name ?? `${route.method} ${route.path}`
}

/** A class name as seen from an app root: that root's own model, else the project root's. */
function resolveModel(sources: PlanImpactSources, className: string, from: PlanAppScope): PlanImpactModel | undefined {
  return inAppRoot(sources.models.filter((model) => model.className === className), (model) => model.module, from)
}

class EntryBuilder {
  readonly consumers: PlanImpactConsumer[] = []
  readonly notes: PlanImpactNote[] = []
  private readonly seen = new Set<string>()

  constructor(private readonly sources: PlanImpactSources) {}

  add(consumer: PlanImpactConsumer): void {
    const key = JSON.stringify([consumer.kind, consumer.name, consumer.file ?? ''])
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.consumers.push(consumer)
  }

  private note(key: string, values: Record<string, string>): void {
    if (!this.notes.some((note) => note.key === key)) this.notes.push({ key, values })
  }

  /** The readers this entry's lists rest on: each one that could not look gets its sentence. */
  rests(...readers: PlanImpactReader[]): void {
    for (const reader of readers) {
      const reason = this.sources.unreadable[reader]
      if (reason !== undefined) this.note(READER_KEYS[reader], { reason })
    }
  }

  /** What the column scan could not see: files that did not parse, models with no class, pages with no file. */
  scanGaps(): void {
    const { reads, unparsedModels, missingPages } = this.sources
    if (reads.unreadable.length > 0) this.note('impact.unreadableFiles', { files: reads.unreadable.join(', ') })
    if (unparsedModels.length > 0) this.note('impact.unparsedModels', { files: unparsedModels.join(', ') })
    if (missingPages.length > 0) this.note('impact.missingPages', { pages: missingPages.join(', ') })
  }
}

/** A route, and what hangs off it: its `ApiRoutes` entry and the agent tool it publishes. */
function addRoute(entry: EntryBuilder, route: PlanImpactRoute): void {
  entry.add({ kind: 'route', name: routeLabel(route) })
  if (route.name !== undefined) entry.add({ kind: 'apiRoute', name: route.name })
  if (route.toolName !== undefined) entry.add({ kind: 'agentTool', name: route.toolName })
}

function addActionRoutes(entry: EntryBuilder, sources: PlanImpactSources, matches: (action: string) => boolean): void {
  entry.rests('routes')
  for (const route of sources.routes) {
    if (route.action !== undefined && matches(route.action)) addRoute(entry, route)
  }
}

/** Actions whose body names `identifier` outside comments and strings: a mention, which is the scan's bound. */
function addMentioningActions(
  entry: EntryBuilder,
  sources: PlanImpactSources,
  identifier: string,
  options: { withRoutes: boolean; refersTo?: (action: PlanAppActionDetail) => boolean },
): void {
  entry.rests('controllers')
  for (const action of sources.actions) {
    if (!action.identifiers.includes(identifier) || (options.refersTo && !options.refersTo(action))) continue
    entry.add({ kind: 'action', name: action.key, file: action.file })
    if (options.withRoutes) addActionRoutes(entry, sources, (key) => key === action.key)
  }
}

function readConsumer(read: Pick<ColumnRead, 'where' | 'file' | 'line' | 'via' | 'write'>, opaque = false): PlanImpactConsumer {
  const kind: PlanImpactConsumerKind = opaque ? (read.write ? 'opaqueWrite' : 'opaqueRead') : read.write ? 'write' : 'read'
  return { kind, name: read.where || read.file, file: read.file, line: read.line, ...(read.via ? { via: read.via } : {}) }
}

function modelEntry(entry: EntryBuilder, sources: PlanImpactSources, target: PlanImpactModel | undefined, change: PlanChange): void {
  entry.rests('models', 'routes', 'resources', 'policies', 'controllers', 'tests')
  if (change.kind === 'drop' || change.kind === 'rename') entry.rests('pages')
  entry.scanGaps()
  if (!target) return
  const isTarget = (className: string | undefined, from: PlanAppScope): boolean =>
    className !== undefined && resolveModel(sources, className, from) === target

  for (const model of sources.models) {
    if (model === target) continue
    for (const relationship of model.relationships) {
      if (isTarget(relationship.relatedModel, model.module)) entry.add({ kind: 'model', name: `${model.className}.${relationship.name}`, file: model.file })
    }
  }
  for (const route of sources.routes) {
    if (Object.values(route.bindings).some((className) => isTarget(className, route.module))) addRoute(entry, route)
  }
  for (const resource of sources.resources) {
    if (resource.models.some((model) => model.file === target.file)) entry.add({ kind: 'resource', name: resource.className, file: resource.file })
  }
  for (const policy of sources.policies) {
    if (policy.className === `${target.className}Policy` && policy.module === target.module) entry.add({ kind: 'policy', name: policy.className, file: policy.file })
  }
  addMentioningActions(entry, sources, target.className, { withRoutes: false, refersTo: (action) => isTarget(target.className, action.module) })
  if (change.kind === 'drop' || change.kind === 'rename') {
    for (const read of sources.reads.reads) {
      if (read.model.file === target.file && read.kind === 'page') entry.add({ kind: 'page', name: read.where, file: read.file })
    }
  }
  for (const test of sources.tests) {
    if (isTestFileNamedFor(test, target.className) && isTarget(target.className, moduleNameFromRelPath(test))) entry.add({ kind: 'test', name: test, file: test })
  }
}

/** An opaque access (`post[key]`, a spread, `create(data)`) may be any column, so it is listed under every changed one. */
function columnEntry(entry: EntryBuilder, sources: PlanImpactSources, target: PlanImpactModel | undefined, property: string): void {
  entry.rests('models', 'controllers', 'resources', 'pages')
  entry.scanGaps()
  if (!target) return
  for (const read of sources.reads.reads) {
    if (read.model.file === target.file && read.property === property) entry.add(readConsumer(read))
  }
  for (const opaque of sources.reads.opaque) {
    if (opaque.model.file === target.file) entry.add(readConsumer(opaque, true))
  }
}

/** Every element that changes something existing, with what Impact found hanging off it. */
export function planImpact(plan: PlanDraft, sources: PlanImpactSources): PlanImpactEntry[] {
  const entries: PlanImpactEntry[] = []
  const build = (elementId: string, section: PlanElementSection, fill: (entry: EntryBuilder) => void): void => {
    const entry = new EntryBuilder(sources)
    fill(entry)
    entries.push({ elementId, section, consumers: entry.consumers, notes: entry.notes })
  }

  for (const model of plan.models) {
    const module = model.module ?? null
    const target = sources.models.find((candidate) => candidate.className === currentName(model.name, model.change) && candidate.module === module)
    if (changes(model.change) || model.tableRenamedFrom !== undefined) {
      build(model.id, 'models', (entry) => modelEntry(entry, sources, target, model.change))
    }
    for (const column of model.columns) {
      if (!changes(column.change)) continue
      build(column.id, 'columns', (entry) => columnEntry(entry, sources, target, currentName(column.name, column.change)))
    }
  }

  for (const validator of plan.validators) {
    if (!changes(validator.change)) continue
    const name = currentName(validator.name, validator.change)
    build(validator.id, 'validators', (entry) => addMentioningActions(entry, sources, name, { withRoutes: true }))
  }

  for (const controller of plan.controllers) {
    const className = currentName(controller.className, controller.change)
    if (changes(controller.change)) {
      build(controller.id, 'controllers', (entry) => addActionRoutes(entry, sources, (key) => key.startsWith(`${className}.`)))
    }
    for (const action of controller.actions) {
      if (!changes(action.change)) continue
      const key = `${className}.${currentName(action.name, action.change)}`
      build(action.id, 'actions', (entry) => addActionRoutes(entry, sources, (candidate) => candidate === key))
    }
  }

  for (const route of plan.routes) {
    if (!changes(route.change)) continue
    const name = currentName(route.name, route.change)
    build(route.id, 'routes', (entry) => {
      entry.rests('routes')
      const found = sources.routes.find((candidate) => candidate.name === name)
        ?? sources.routes.find((candidate) => candidate.method === route.method && candidate.path === route.path)
      if (found) addRoute(entry, found)
    })
  }

  for (const view of plan.views) {
    if (!changes(view.change)) continue
    const page = currentName(view.page, view.change)
    build(view.id, 'views', (entry) => {
      entry.rests('controllers', 'routes')
      for (const action of sources.actions) {
        if (!action.pages.includes(page)) continue
        entry.add({ kind: 'action', name: action.key, file: action.file })
        addActionRoutes(entry, sources, (key) => key === action.key)
      }
    })
  }

  for (const resource of plan.resources) {
    if (!changes(resource.change)) continue
    const name = currentName(resource.name, resource.change)
    build(resource.id, 'resources', (entry) => {
      addMentioningActions(entry, sources, name, { withRoutes: true })
      entry.rests('pages')
      for (const read of sources.reads.reads) {
        if (read.kind === 'page' && read.via === name) entry.add({ kind: 'page', name: read.where, file: read.file })
      }
    })
  }

  for (const policy of plan.policies) {
    if (!changes(policy.change)) continue
    const name = currentName(policy.name, policy.change)
    build(policy.id, 'policies', (entry) => addMentioningActions(entry, sources, name, { withRoutes: true }))
  }

  return entries
}

/**
 * An altered route or action whose application route publishes an agent tool the plan
 * does not declare: still "altering a published agent tool", which RFC 0030 §2 flags
 * whatever else Impact found. A change `planBreakingChanges()` already flagged is left alone.
 */
export function impactBreakingChanges(plan: PlanDraft, impact: readonly PlanImpactEntry[], already: readonly PlanBreakingChange[]): PlanBreakingChange[] {
  const flagged = new Set(already.map((item) => item.elementId))
  const titles = new Map<string, string>()
  for (const route of plan.routes) titles.set(route.id, route.name)
  for (const controller of plan.controllers) {
    titles.set(controller.id, controller.className)
    for (const action of controller.actions) titles.set(action.id, `${controller.className}.${action.name}`)
  }

  const breaking: PlanBreakingChange[] = []
  for (const entry of impact) {
    if (flagged.has(entry.elementId)) continue
    if (entry.section !== 'routes' && entry.section !== 'actions' && entry.section !== 'controllers') continue
    for (const consumer of entry.consumers) {
      if (consumer.kind !== 'agentTool') continue
      breaking.push({
        elementId: entry.elementId,
        section: entry.section,
        title: titles.get(entry.elementId) ?? entry.elementId,
        reasonKey: 'breaking.agentToolChanges',
        reasonValues: { tool: consumer.name },
      })
    }
  }
  return breaking
}
