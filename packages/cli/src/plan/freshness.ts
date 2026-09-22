/**
 * Freshness (RFC 0030 §4): `baseline.contextHash`, one hash per element the §2 checks
 * judge by name, of what the scanners read for that name, and the comparison of it with
 * the application today. Pure: the app state and the status come in as values. A section
 * that cannot be read is never hashed as if it were empty, so it is never `fresh`.
 * The stamp is inside `baseline`, and so inside `planHash()`: changing what is hashed
 * here renames every approved plan and orphans its approvals and waivers.
 */

import { createHash } from 'node:crypto'

import { isUnreadable, type PlanAppName, type PlanAppState, type PlanAppTable, type PlanAppUnreadable } from './app-state'
import { listPlanAppTargets, type PlanAppTarget } from './app-targets'
import { canonicalJson } from './identity'
import { listPlanReferences } from './references'
import type { PlanChange, PlanDraft, PlanElementSection } from './schema'
import type { PlanElementState } from './status'

/** Hashed into every entry, so a change to what is hashed marks everything stale rather than colliding. */
const CONTEXT_FACTS_VERSION = 1

export interface PlanContextStamp {
  contextHash: Record<string, string>
  /** Elements the checks judge whose sections could not be read, which get no entry. */
  unstamped: Array<{ id: string; reason: string }>
}

export type PlanFreshnessVerdict = 'fresh' | 'stale' | 'unstamped' | 'unjudged'

export const PLAN_FRESHNESS_VERDICTS = ['fresh', 'stale', 'unstamped', 'unjudged'] as const satisfies readonly PlanFreshnessVerdict[]

export interface PlanElementFreshness {
  id: string
  section: PlanElementSection
  change: PlanChange['kind']
  verdict: PlanFreshnessVerdict
  /** Why, on every verdict but a plain `fresh`. */
  reason?: string
  /** On `stale`: the elements naming this one (`listPlanReferences()`), whose steps depend on it. */
  affects?: string[]
}

export interface PlanFreshness {
  elements: PlanElementFreshness[]
  summary: Record<PlanFreshnessVerdict, number>
}

/** Always carries `section`, which is what tells it from a {@link PlanAppUnreadable}. */
type Facts = { section: string } & Record<string, unknown>

interface ElementContext {
  id: string
  section: PlanElementSection
  change: PlanChange['kind']
  /** The element's hash, or why one of the sections it is judged in could not be read. */
  hash: string | PlanAppUnreadable
}

/** Code-unit order with the project root first, so two machines write the same bytes. */
function sortedRoots(modules: Iterable<string | null>): Array<string | null> {
  return [...new Set(modules)].sort((a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1))
}

function sortedStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function namesOf(target: PlanAppTarget): string[] {
  return sortedStrings([target.current, ...(target.previous === undefined ? [] : [target.previous])])
}

/**
 * The name an action is found under once its controller's rename is done. Both are read,
 * or implementing the rename would move the hash of every `existing` action under it.
 */
function aliasOf(target: PlanAppTarget, name: string): string | undefined {
  const renamed = target.renamedClass
  return renamed && name.startsWith(`${renamed.from}.`) ? `${renamed.to}${name.slice(renamed.from.length)}` : undefined
}

function namedFacts(target: PlanAppTarget, entries: ReadonlyArray<PlanAppName>): Facts {
  const roots: Record<string, Array<string | null>> = {}
  for (const name of namesOf(target)) {
    const alias = aliasOf(target, name)
    roots[name] = sortedRoots(entries.filter((entry) => entry.name === name || entry.name === alias).map((entry) => entry.module))
  }
  return { section: target.appSection, roots }
}

function targetFacts(target: PlanAppTarget, app: PlanAppState): Facts | PlanAppUnreadable {
  if (target.appSection === 'routes') {
    if (isUnreadable(app.routes)) return app.routes
    const routes = app.routes
    const endpoints: Record<string, string[]> = {}
    for (const name of namesOf(target)) {
      endpoints[name] = sortedStrings(routes.filter((route) => route.name === name).map((route) => `${route.method.toUpperCase()} ${route.path}`))
    }
    const endpoint = target.endpoint && `${target.endpoint.method} ${target.endpoint.path}`
    return {
      section: 'routes',
      endpoints,
      ...(endpoint ? { registered: routes.some((route) => `${route.method.toUpperCase()} ${route.path}` === endpoint) } : {}),
    }
  }

  if (target.appSection === 'tables') {
    if (isUnreadable(app.tables)) return app.tables
    const tables = app.tables
    const declaring = (name: string, module?: string | null): PlanAppTable[] =>
      tables.filter((table) => (module === undefined || table.module === module) && (table.identifier === name || table.tableName === name))
    if (target.table) {
      // Found under its name today or the name the plan gives it, and hashed without saying
      // which, so implementing a table rename does not move its `existing` columns.
      const module = target.table.module ?? null
      const table = declaring(target.table.lookup, module)[0] ?? declaring(target.table.current, module)[0]
      if (!table) return { section: 'columns', table: false }
      const columns: Record<string, boolean> = {}
      for (const name of namesOf(target)) columns[name] = table.columns.includes(name)
      return { section: 'columns', table: true, columns }
    }
    // Every root's: an `add` collides with a table any root declares. Columns are their own
    // entries, so a column the plan adds does not move its model's hash.
    const declared: Record<string, string[]> = {}
    for (const name of namesOf(target)) {
      declared[name] = sortedStrings(
        declaring(name).map((table) => canonicalJson({ identifier: table.identifier, tableName: table.tableName ?? null, module: table.module })),
      )
    }
    return { section: 'tables', declared }
  }

  const section = app[target.appSection]
  if (isUnreadable(section)) return section
  return namedFacts(target, section)
}

function hashFacts(facts: Facts[]): string {
  return createHash('sha256').update(canonicalJson({ v: CONTEXT_FACTS_VERSION, facts }), 'utf8').digest('hex')
}

/** One entry per element, in the order the checks judge them. A model's class and table are one entry. */
function elementContexts(plan: PlanDraft, app: PlanAppState): ElementContext[] {
  const byId = new Map<string, { target: PlanAppTarget; facts: Facts[]; unreadable?: PlanAppUnreadable }>()
  for (const target of listPlanAppTargets(plan)) {
    const entry = byId.get(target.id) ?? { target, facts: [] }
    byId.set(target.id, entry)
    if (entry.unreadable) continue
    const facts = targetFacts(target, app)
    if (isUnreadableFacts(facts)) entry.unreadable = { unreadable: `the application's ${target.appSection} could not be read (${facts.unreadable})` }
    else entry.facts.push(facts)
  }
  return [...byId.values()].map(({ target, facts, unreadable }) => ({
    id: target.id,
    section: target.section,
    // The first target is the element's own: a model's class comes before its table.
    change: target.kind,
    hash: unreadable ?? hashFacts(facts),
  }))
}

function isUnreadableFacts(facts: Facts | PlanAppUnreadable): facts is PlanAppUnreadable {
  return !('section' in facts)
}

/** What `plan:approve` writes into `baseline.contextHash` for a draft. */
export function stampContextHash(plan: PlanDraft, app: PlanAppState): PlanContextStamp {
  const contextHash: Record<string, string> = {}
  const unstamped: PlanContextStamp['unstamped'] = []
  for (const element of elementContexts(plan, app)) {
    if (typeof element.hash === 'string') contextHash[element.id] = element.hash
    else unstamped.push({ id: element.id, reason: element.hash.unreadable })
  }
  return { contextHash, unstamped }
}

/**
 * States that are positive evidence the element exists as the plan's own work left it. Its
 * context was bound to move, so a differing hash is the plan's doing, not someone else's.
 * `planned`, `blocked` and `unjudged` say nothing of the sort, so a difference there is stale.
 */
const WORKED_ON = new Set<PlanElementState>(['present', 'wired', 'drifted', 'verified', 'waived'])

/**
 * `states` is what `plan:status` reports per element, after verification and waivers are laid
 * over it: an `existing` element has no step to have moved it, so a difference is always stale.
 */
export function judgeFreshness(
  plan: PlanDraft & { baseline: { contextHash: Record<string, string> } },
  app: PlanAppState,
  states: ReadonlyArray<{ id: string; state: PlanElementState }>,
): PlanFreshness {
  const stateOf = new Map(states.map((element) => [element.id, element.state]))
  const stamped = plan.baseline.contextHash
  const elements: PlanElementFreshness[] = elementContexts(plan, app).map(({ id, section, change, hash }) => {
    const base = { id, section, change }
    if (typeof hash !== 'string') return { ...base, verdict: 'unjudged', reason: hash.unreadable }
    const before = Object.hasOwn(stamped, id) ? stamped[id] : undefined
    if (before === undefined) {
      return { ...base, verdict: 'unstamped', reason: 'No context was stamped for it: a revision named it after approval, or its section could not be read then.' }
    }
    if (before === hash) return { ...base, verdict: 'fresh' }
    const state = stateOf.get(id)
    if (change !== 'existing' && state !== undefined && WORKED_ON.has(state)) {
      return { ...base, verdict: 'fresh', reason: `Its context changed with the plan's own work (${state}).` }
    }
    return { ...base, verdict: 'stale', reason: 'What the scanners read for it changed since the plan was approved.' }
  })

  const stale = new Set(elements.filter((element) => element.verdict === 'stale').map((element) => element.id))
  const affects = new Map<string, Set<string>>()
  for (const reference of listPlanReferences(plan)) {
    if (!stale.has(reference.to) || reference.from.id === reference.to) continue
    const set = affects.get(reference.to) ?? new Set<string>()
    set.add(reference.from.id)
    affects.set(reference.to, set)
  }
  for (const element of elements) {
    if (element.verdict === 'stale') element.affects = [...(affects.get(element.id) ?? [])]
  }

  const summary = Object.fromEntries(PLAN_FRESHNESS_VERDICTS.map((verdict) => [verdict, 0])) as Record<PlanFreshnessVerdict, number>
  for (const element of elements) summary[element.verdict] += 1
  return { elements, summary }
}
