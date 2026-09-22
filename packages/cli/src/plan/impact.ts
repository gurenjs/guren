/**
 * Impact (RFC 0030 §2): for each plan element that changes something the application
 * already has, the consumers the existing readers and the column-consumer scan find.
 * Pure: `impact-sources.ts` reads the application. Every list is a lower bound, and an
 * empty one means nothing was found, never that nothing is affected. The breaking rule
 * stays `planBreakingChanges()`; this adds only a change to a tool the app publishes.
 */

import type { ColumnConsumerScan, ResourceModelTie } from '../column-consumers'
import type { PlanAppActionDetail, PlanAppClassDetail } from './app-detail'
import type { PlanAppScope, PlanAppUnreadable } from './app-state'
import type { PlanBreakingChange } from './page/payload'
import type { PlanChange, PlanDraft, PlanElementSection } from './schema'

export interface PlanImpactRoute {
  name?: string
  method: string
  path: string
  /** `ClassName.action`; absent for an inline or prototype handler. */
  action?: string
  /** Route parameter → bound model class. */
  bindings: Record<string, string>
  /** The tool the route publishes (`agent.toolName`, else its name), when it declares `.agent()`. */
  toolName?: string
}

export interface PlanImpactModel {
  className: string
  module: PlanAppScope
  file: string
  relationships: Array<{ name: string; type: string; relatedModel?: string }>
}

export interface PlanImpactSources {
  routes: PlanImpactRoute[] | PlanAppUnreadable
  models: PlanImpactModel[] | PlanAppUnreadable
  actions: PlanAppActionDetail[] | PlanAppUnreadable
  resources: ResourceModelTie[]
  policies: PlanAppClassDetail[]
  /** App-relative test files. */
  tests: string[]
  reads: ColumnConsumerScan
}

export const PLAN_IMPACT_CONSUMER_KINDS = [
  'route',
  'apiRoute',
  'agentTool',
  'action',
  'model',
  'resource',
  'policy',
  'page',
  'test',
  'read',
  'opaqueRead',
] as const

export type PlanImpactConsumerKind = (typeof PLAN_IMPACT_CONSUMER_KINDS)[number]

export interface PlanImpactConsumer {
  kind: PlanImpactConsumerKind
  name: string
  file?: string
  line?: number
  /** The resource whose data type tied a page's read to the model. */
  via?: string
}

/** A reader Impact could not use for this element: its absence of findings says nothing. */
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

type Unreadable = PlanAppUnreadable

function readable<T>(section: T[] | Unreadable): section is T[] {
  return Array.isArray(section)
}

function changes(change: PlanChange): boolean {
  return change.kind === 'alter' || change.kind === 'rename' || change.kind === 'drop'
}

/** The name the application knows the element by today: a rename's `from`. */
function currentName(name: string, change: PlanChange): string {
  return change.kind === 'rename' ? change.from : name
}

function routeLabel(route: PlanImpactRoute): string {
  return route.name ?? `${route.method} ${route.path}`
}

class EntryBuilder {
  readonly consumers: PlanImpactConsumer[] = []
  readonly notes: PlanImpactNote[] = []
  private readonly seen = new Set<string>()

  add(consumer: PlanImpactConsumer): void {
    const key = JSON.stringify([consumer.kind, consumer.name, consumer.file ?? ''])
    if (this.seen.has(key)) return
    this.seen.add(key)
    this.consumers.push(consumer)
  }

  unreadable(reader: string, section: readonly unknown[] | Unreadable): void {
    if (Array.isArray(section)) return
    const reason = (section as Unreadable).unreadable
    if (!this.notes.some((note) => note.values.reader === reader)) this.notes.push({ key: 'impact.unreadable', values: { reader, reason } })
  }
}

/** A route, and what hangs off it: its `ApiRoutes` entry and the agent tool it publishes. */
function addRoute(entry: EntryBuilder, route: PlanImpactRoute): void {
  entry.add({ kind: 'route', name: routeLabel(route) })
  if (route.name !== undefined) entry.add({ kind: 'apiRoute', name: route.name })
  if (route.toolName !== undefined) entry.add({ kind: 'agentTool', name: route.toolName })
}

function addActionRoutes(entry: EntryBuilder, sources: PlanImpactSources, matches: (action: string) => boolean): void {
  entry.unreadable('routes', sources.routes)
  if (!readable(sources.routes)) return
  for (const route of sources.routes) {
    if (route.action !== undefined && matches(route.action)) addRoute(entry, route)
  }
}

/** Actions whose body names `identifier` outside comments and strings: a mention, which is the scan's bound. */
function addMentioningActions(entry: EntryBuilder, sources: PlanImpactSources, identifier: string, withRoutes: boolean): void {
  entry.unreadable('actions', sources.actions)
  if (!readable(sources.actions)) return
  for (const action of sources.actions) {
    if (!action.identifiers.includes(identifier)) continue
    entry.add({ kind: 'action', name: action.key, file: action.file })
    if (withRoutes) addActionRoutes(entry, sources, (key) => key === action.key)
  }
}

function addReadFileNotes(entry: EntryBuilder, sources: PlanImpactSources): void {
  if (sources.reads.unreadable.length === 0) return
  entry.notes.push({ key: 'impact.unreadableFiles', values: { files: sources.reads.unreadable.join(', ') } })
}

function readConsumer(read: { where: string; file: string; line: number; via?: string }): PlanImpactConsumer {
  return { kind: 'read', name: read.where || read.file, file: read.file, line: read.line, ...(read.via ? { via: read.via } : {}) }
}

function modelEntry(entry: EntryBuilder, sources: PlanImpactSources, className: string, module: PlanAppScope, change: PlanChange): void {
  entry.unreadable('models', sources.models)
  if (readable(sources.models)) {
    for (const model of sources.models) {
      if (model.className === className && model.module === module) continue
      for (const relationship of model.relationships) {
        if (relationship.relatedModel === className) entry.add({ kind: 'model', name: `${model.className}.${relationship.name}`, file: model.file })
      }
    }
  }
  entry.unreadable('routes', sources.routes)
  if (readable(sources.routes)) {
    for (const route of sources.routes) {
      if (Object.values(route.bindings).includes(className)) addRoute(entry, route)
    }
  }
  for (const resource of sources.resources) {
    if (resource.models.includes(className)) entry.add({ kind: 'resource', name: resource.className, file: resource.file })
  }
  for (const policy of sources.policies) {
    if (policy.className === `${className}Policy` && policy.module === module) entry.add({ kind: 'policy', name: policy.className, file: policy.file })
  }
  addMentioningActions(entry, sources, className, false)
  if (change.kind === 'drop' || change.kind === 'rename') {
    for (const read of sources.reads.reads) {
      if (read.model === className && read.kind === 'page') entry.add({ kind: 'page', name: read.where, file: read.file })
    }
    addReadFileNotes(entry, sources)
  }
  // `generateEntityContext()`'s rule: a test belongs to an entity when its file name carries it.
  for (const test of sources.tests) {
    if ((test.split('/').pop() ?? test).includes(className)) entry.add({ kind: 'test', name: test, file: test })
  }
}

/** An opaque read (`post[key]`, a rest pattern) may be any column, so it is listed under every changed one. */
function columnEntry(entry: EntryBuilder, sources: PlanImpactSources, className: string, property: string): void {
  for (const read of sources.reads.reads) {
    if (read.model === className && read.property === property) entry.add(readConsumer(read))
  }
  for (const opaque of sources.reads.opaque) {
    if (opaque.model === className) entry.add({ kind: 'opaqueRead', name: opaque.where || opaque.file, file: opaque.file, line: opaque.line })
  }
  addReadFileNotes(entry, sources)
}

/** Every element that changes something existing, with what Impact found hanging off it. */
export function planImpact(plan: PlanDraft, sources: PlanImpactSources): PlanImpactEntry[] {
  const entries: PlanImpactEntry[] = []
  const build = (elementId: string, section: PlanElementSection, fill: (entry: EntryBuilder) => void): void => {
    const entry = new EntryBuilder()
    fill(entry)
    entries.push({ elementId, section, consumers: entry.consumers, notes: entry.notes })
  }

  for (const model of plan.models) {
    const className = currentName(model.name, model.change)
    const module = model.module ?? null
    if (changes(model.change) || model.tableRenamedFrom !== undefined) {
      build(model.id, 'models', (entry) => modelEntry(entry, sources, className, module, model.change))
    }
    for (const column of model.columns) {
      if (!changes(column.change)) continue
      build(column.id, 'columns', (entry) => columnEntry(entry, sources, className, currentName(column.name, column.change)))
    }
  }

  for (const validator of plan.validators) {
    if (!changes(validator.change)) continue
    build(validator.id, 'validators', (entry) => addMentioningActions(entry, sources, currentName(validator.name, validator.change), true))
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
      entry.unreadable('routes', sources.routes)
      if (!readable(sources.routes)) return
      const found = sources.routes.find((candidate) => candidate.name === name)
        ?? sources.routes.find((candidate) => candidate.method === route.method && candidate.path === route.path)
      if (found) addRoute(entry, found)
    })
  }

  for (const view of plan.views) {
    if (!changes(view.change)) continue
    const page = currentName(view.page, view.change)
    build(view.id, 'views', (entry) => {
      entry.unreadable('actions', sources.actions)
      if (!readable(sources.actions)) return
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
      addMentioningActions(entry, sources, name, true)
      for (const read of sources.reads.reads) {
        if (read.kind === 'page' && read.via === name) entry.add({ kind: 'page', name: read.where, file: read.file })
      }
    })
  }

  for (const policy of plan.policies) {
    if (!changes(policy.change)) continue
    build(policy.id, 'policies', (entry) => addMentioningActions(entry, sources, currentName(policy.name, policy.change), true))
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
