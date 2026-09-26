/**
 * Freshness (RFC 0030 §4): `baseline.contextHash`, one hash per element the §2 checks
 * judge by name, of what the scanners read for that name, and the comparison of it with
 * the application today. Pure. A section that cannot be read is never hashed as if it
 * were empty, so it is never `fresh`. The stamp is inside `baseline`, and so inside
 * `planHash()`: changing what is hashed renames every approved plan.
 */

import { createHash } from 'node:crypto'

import { declaresTable, findTable, isUnreadable, type PlanAppName, type PlanAppScope, type PlanAppState, type PlanAppUnreadable } from './app-state'
import { endpointKey, listPlanAppTargets, type PlanAppTarget, type PlanAppTargetSection } from './app-targets'
import { canonicalJson } from './identity'
import { listPlanReferences } from './references'
import type { PlanChange, PlanDraft, PlanElementSection } from './schema'

/** Hashed into every entry, so a change to what is hashed marks everything stale rather than colliding. */
const CONTEXT_FACTS_VERSION = 3

export interface PlanContextStamp {
  contextHash: Record<string, string>
  /** Elements the checks judge whose sections could not be read, which get no entry. */
  unstamped: Array<{ id: string; sections: PlanAppTargetSection[]; reason: string }>
}

export type PlanFreshnessVerdict = 'fresh' | 'stale' | 'unstamped' | 'unjudged'

export const PLAN_FRESHNESS_VERDICTS = ['fresh', 'stale', 'unstamped', 'unjudged'] as const satisfies readonly PlanFreshnessVerdict[]

export interface PlanElementFreshness {
  id: string
  section: PlanElementSection
  change: PlanChange['kind']
  verdict: PlanFreshnessVerdict
  /** Why, on every verdict but a `fresh` that matches its stamp. */
  reason?: string
  /**
   * On a `fresh` that does not match its stamp: `built` when the stamp is the state the plan
   * starts this element from, so the change is the plan's own work; `end` otherwise. On an
   * `unstamped` element, `end` when the application reads as the plan leaves it.
   */
  basis?: 'end' | 'built'
  /** On every verdict but `fresh`: the elements naming this one (`listPlanReferences()`), whose steps depend on it. */
  affects?: string[]
}

export interface PlanFreshness {
  elements: PlanElementFreshness[]
  summary: Record<PlanFreshnessVerdict, number>
}

/**
 * Whether the plan's own root declares a name, and for a table which other roots do: one
 * name is one SQL table across roots. A class elsewhere feeds only §2 message text.
 */
interface Presence {
  here: boolean
  elsewhere?: PlanAppScope[]
}

type Facts =
  | { section: 'named' | 'tables'; names: Record<string, Presence> }
  | { section: 'columns'; table: boolean; elsewhere: PlanAppScope[]; columns?: Record<string, boolean> }
  | { section: 'routes'; endpoints: Record<string, string[]>; registered?: boolean }

/** Project root first, then code-unit order, so two machines write the same bytes. */
function sortedRoots(modules: Iterable<PlanAppScope>): PlanAppScope[] {
  return [...new Set(modules)].sort((a, b) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1))
}

function namesOf(target: PlanAppTarget): string[] {
  return [...new Set([target.current, ...(target.previous === undefined ? [] : [target.previous])])].sort()
}

/** Whether the plan leaves `name` in place: the current name, unless the element or its parent is dropped. */
function presentAtEnd(target: PlanAppTarget, name: string): boolean {
  return name === target.current && target.kind !== 'drop' && !target.parentDropped
}

/**
 * Whether `name` is there before the plan's work: an `add` and the new name of a `rename` are
 * not. An `existing` or `alter` name is present at start and end alike, so it is never `built`.
 */
function presentAtStart(target: PlanAppTarget, name: string): boolean {
  if (target.kind === 'add') return false
  if (target.kind === 'rename') return name === (target.previous ?? target.current)
  return name === target.current
}

/**
 * The name an action is found under once its controller's rename is done. Both are read,
 * or implementing the rename would move the hash of every `existing` action under it.
 */
function aliasOf(target: PlanAppTarget, name: string): string | undefined {
  const renamed = target.renamedClass
  return renamed && name.startsWith(`${renamed.from}.`) ? `${renamed.to}${name.slice(renamed.from.length)}` : undefined
}

function namesFacts(section: 'named' | 'tables', target: PlanAppTarget, rootsOf: (name: string) => PlanAppScope[]): Facts {
  const own = target.perRoot ? (target.module ?? null) : null
  const names: Record<string, Presence> = {}
  for (const name of namesOf(target)) {
    const roots = sortedRoots(rootsOf(name))
    names[name] = { here: roots.includes(own), ...(section === 'tables' ? { elsewhere: roots.filter((root) => root !== own) } : {}) }
  }
  return { section, names }
}

function targetFacts(target: PlanAppTarget, app: PlanAppState): Facts | PlanAppUnreadable {
  if (target.appSection === 'routes') {
    if (isUnreadable(app.routes)) return app.routes
    const routes = app.routes
    const endpoints: Record<string, string[]> = {}
    for (const name of namesOf(target)) {
      endpoints[name] = [...new Set(routes.filter((route) => route.name === name).map((route) => endpointKey(route.method, route.path)))].sort()
    }
    const registered = target.kind === 'add' && target.endpoint ? { registered: routes.some((route) => endpointKey(route.method, route.path) === target.endpoint) } : {}
    return { section: 'routes', endpoints, ...registered }
  }

  if (target.appSection === 'tables') {
    if (isUnreadable(app.tables)) return app.tables
    const tables = app.tables
    if (target.table) {
      // Found under its name today or the one the plan gives it, and hashed without saying
      // which, so implementing a table rename does not move its `existing` columns.
      const module = target.module ?? null
      const { lookup, current } = target.table
      const table = findTable(tables, lookup, module) ?? findTable(tables, current, module)
      // Where else the table is declared, which is what the checks say of a table not in its root.
      const elsewhere = sortedRoots(tables.filter((candidate) => candidate.module !== module && (declaresTable(candidate, lookup) || declaresTable(candidate, current))).map((candidate) => candidate.module))
      if (!table) return { section: 'columns', table: false, elsewhere }
      const columns: Record<string, boolean> = {}
      for (const name of namesOf(target)) columns[name] = table.columns.includes(name)
      return { section: 'columns', table: true, elsewhere, columns }
    }
    // Every root's: an `add` collides with a table any root declares. Columns are their own
    // entries, so a column the plan adds does not move its model's hash.
    return namesFacts('tables', target, (name) => tables.filter((table) => declaresTable(table, name)).map((table) => table.module))
  }

  const section = app[target.appSection]
  if (isUnreadable(section)) return section
  const entries: ReadonlyArray<PlanAppName> = section
  return namesFacts('named', target, (name) => {
    const alias = aliasOf(target, name)
    return entries.filter((entry) => entry.name === name || entry.name === alias).map((entry) => entry.module)
  })
}

/**
 * Whether the plan settles a table name in every root, not only its own: one name is one SQL
 * table, so a name it brings in was declared nowhere at approval (the §2 checks refuse it
 * otherwise) and a name it removes is left declared nowhere.
 */
function settlesTableName(target: PlanAppTarget, name: string): boolean {
  if (!presentAtEnd(target, name)) return true
  return name === target.current && (target.kind === 'add' || (target.kind === 'rename' && target.previous !== target.current))
}

/**
 * The same facts once the plan's own work is done: every name it controls in the root it
 * names is where the plan leaves it. Another root's declaration of a table is the plan's
 * where {@link settlesTableName} says so; otherwise it is carried over as read.
 */
function plannedEnd(target: PlanAppTarget, facts: Facts): Facts {
  switch (facts.section) {
    case 'named':
    case 'tables': {
      const names: Record<string, Presence> = {}
      for (const [name, found] of Object.entries(facts.names)) {
        const elsewhere = facts.section === 'tables' && settlesTableName(target, name) ? { elsewhere: [] } : {}
        names[name] = { ...found, here: presentAtEnd(target, name), ...elsewhere }
      }
      return { section: facts.section, names }
    }
    case 'columns': {
      // A dropped table is left declared nowhere, as settlesTableName() has it for the model.
      if (target.parentDropped) return { section: 'columns', table: false, elsewhere: [] }
      const columns: Record<string, boolean> = {}
      for (const name of namesOf(target)) columns[name] = presentAtEnd(target, name)
      return { section: 'columns', table: true, elsewhere: facts.elsewhere, columns }
    }
    case 'routes': {
      const endpoints: Record<string, string[]> = {}
      for (const name of Object.keys(facts.endpoints)) endpoints[name] = presentAtEnd(target, name) && target.endpoint ? [target.endpoint] : []
      return { section: 'routes', endpoints, ...(facts.registered === undefined ? {} : { registered: true }) }
    }
  }
}

/**
 * The same facts before the plan's work, for the element as the plan names it now. What
 * another root declares is carried over as read, and a route present at the start is
 * predicted at its planned endpoint: either one moved since approval does not match.
 */
function plannedStart(target: PlanAppTarget, facts: Facts): Facts {
  switch (facts.section) {
    case 'named':
    case 'tables': {
      const names: Record<string, Presence> = {}
      for (const [name, found] of Object.entries(facts.names)) names[name] = { ...found, here: presentAtStart(target, name) }
      return { section: facts.section, names }
    }
    case 'columns': {
      const columns: Record<string, boolean> = {}
      for (const name of namesOf(target)) columns[name] = presentAtStart(target, name)
      return { section: 'columns', table: true, elsewhere: facts.elsewhere, columns }
    }
    case 'routes': {
      const endpoints: Record<string, string[]> = {}
      for (const name of Object.keys(facts.endpoints)) endpoints[name] = presentAtStart(target, name) && target.endpoint ? [target.endpoint] : []
      return { section: 'routes', endpoints, ...(facts.registered === undefined ? {} : { registered: false }) }
    }
  }
}

function hashFacts(facts: Facts[]): string {
  return createHash('sha256').update(canonicalJson({ v: CONTEXT_FACTS_VERSION, facts }), 'utf8').digest('hex')
}

interface ElementContext {
  id: string
  section: PlanElementSection
  change: PlanChange['kind']
  now: { hash: string; start: string; end: string } | { unreadable: string; sections: PlanAppTargetSection[] }
}

/** One entry per element; a model's class and its table are one entry, and the class comes first. */
function elementContexts(plan: PlanDraft, app: PlanAppState): ElementContext[] {
  const byId = new Map<string, { first: PlanAppTarget; facts: Facts[]; start: Facts[]; end: Facts[]; unreadable: string[]; sections: PlanAppTargetSection[] }>()
  for (const target of listPlanAppTargets(plan)) {
    const entry = byId.get(target.id) ?? { first: target, facts: [], start: [], end: [], unreadable: [], sections: [] }
    byId.set(target.id, entry)
    const facts = targetFacts(target, app)
    if ('unreadable' in facts) {
      entry.unreadable.push(`the application's ${target.appSection} could not be read (${facts.unreadable})`)
      entry.sections.push(target.appSection)
      continue
    }
    entry.facts.push(facts)
    entry.start.push(plannedStart(target, facts))
    entry.end.push(plannedEnd(target, facts))
  }
  return [...byId.values()].map(({ first, facts, start, end, unreadable, sections }) => ({
    id: first.id,
    section: first.section,
    change: first.kind,
    now: unreadable.length > 0 ? { unreadable: unreadable.join('; '), sections } : { hash: hashFacts(facts), start: hashFacts(start), end: hashFacts(end) },
  }))
}

/** What `plan:approve` writes into `baseline.contextHash` for a draft. */
export function stampContextHash(plan: PlanDraft, app: PlanAppState): PlanContextStamp {
  const contextHash: Record<string, string> = {}
  const unstamped: PlanContextStamp['unstamped'] = []
  for (const { id, now } of elementContexts(plan, app)) {
    if ('hash' in now) contextHash[id] = now.hash
    else unstamped.push({ id, sections: now.sections, reason: now.unreadable })
  }
  return { contextHash, unstamped }
}

/**
 * An element is fresh while what the scanners read for it is what was stamped, or what the
 * plan's own work leaves there. Anything else is someone else's change. A name the plan
 * adds that another commit declares first in the same root reads as the plan's own add.
 */
export function judgeFreshness(plan: PlanDraft & { baseline: { contextHash: Record<string, string> } }, app: PlanAppState): PlanFreshness {
  const stamped = plan.baseline.contextHash
  const elements: PlanElementFreshness[] = elementContexts(plan, app).map(({ id, section, change, now }) => {
    const base = { id, section, change }
    if ('unreadable' in now) return { ...base, verdict: 'unjudged', reason: now.unreadable }
    const before = Object.hasOwn(stamped, id) ? stamped[id] : undefined
    if (before === undefined) {
      const reason = 'No context was stamped for it: a revision named it after approval, or its section could not be read then.'
      return { ...base, verdict: 'unstamped', reason, ...(now.hash === now.end ? { basis: 'end' as const } : {}) }
    }
    if (before === now.hash) return { ...base, verdict: 'fresh' }
    if (now.hash === now.end) {
      if (before === now.start) return { ...base, verdict: 'fresh', basis: 'built', reason: 'The application reads as the plan leaves it, from the state it was stamped in.' }
      return { ...base, verdict: 'fresh', basis: 'end', reason: 'The application reads as the plan leaves it.' }
    }
    return { ...base, verdict: 'stale', reason: 'What the scanners read for it changed since approval, to neither what was stamped nor what the plan leaves.' }
  })

  const judged = new Set(elements.filter((element) => element.verdict !== 'fresh').map((element) => element.id))
  const affects = new Map<string, Set<string>>()
  for (const reference of listPlanReferences(plan)) {
    if (!judged.has(reference.to) || reference.from.id === reference.to) continue
    const set = affects.get(reference.to) ?? new Set<string>()
    set.add(reference.from.id)
    affects.set(reference.to, set)
  }
  for (const element of elements) {
    if (element.verdict !== 'fresh') element.affects = [...(affects.get(element.id) ?? [])]
  }

  const summary = Object.fromEntries(PLAN_FRESHNESS_VERDICTS.map((verdict) => [verdict, 0])) as Record<PlanFreshnessVerdict, number>
  for (const element of elements) summary[element.verdict] += 1
  return { elements, summary }
}
