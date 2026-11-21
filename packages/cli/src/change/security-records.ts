/**
 * Per-route security records (RFC 0040 §3): what each route enforces, read from the introspected
 * application and the action body, and the comparison of two sides that gives
 * `authorization-removed` and `validation-removed`. The comparison fails closed: only records that
 * are equal, or provably stronger, give no fact, and anything it cannot order is incomparable.
 */
import type { AgentRouteMetadata, MiddlewareEntry } from '@guren/server'

import { CONTRACT_SEGMENTS, type ContractSegment } from '../contract-segments'
import type { ChangeFact } from './lane'

/**
 * Bumped whenever a field's meaning changes, a digest's inputs included: a stored record of another
 * version is not compared, and a differing `@guren/cli` is only named, so this is the one guard.
 */
export const SECURITY_RECORD_VERSION = 2

const CONTRACT_KEYS = CONTRACT_SEGMENTS
type ContractKey = ContractSegment

type MiddlewareCapabilities = MiddlewareEntry['capabilities']

export type MiddlewareRecord = Pick<MiddlewareEntry, 'kind' | 'name' | 'capabilities' | 'ability' | 'unresolved' | 'members' | 'unresolvedMembers'>

export interface ContractRecord {
  /** The JSON Schema the manifest renders, or why it could not. */
  schema: unknown
  /** `file#export` of each validator export the schema object is; empty when none is. */
  exports: string[]
  /** A digest of each export's declaration, what an unreadable schema is compared by. */
  declarations: Record<string, string>
}

export interface AuthorizationCall {
  member: 'authorize' | 'can'
  ability: string
  /** The arguments after the ability, as written: the record or class the policy is asked about. */
  subject: string
}

export interface ValidateCall {
  /** `validateBody`, `validateBodySafe`, `validateQuery`, …: a Safe call returns rather than throws. */
  member: string
  /** `file#export` of the schema, or `''` when the argument is no imported validator export. */
  schema: string
  /** A digest of that export's declaration, since its schema is not rendered. */
  declaration?: string
}

/** What the action body shows, or why it was not read. */
export type ActionRecord =
  | {
    /** The action calls `auth.userOrFail()` or `apiToken()`, which refuse a guest. */
    authenticates: boolean
    authorizes: AuthorizationCall[]
    validates: ValidateCall[]
    /** A digest of the body as written, set when a call's ability or schema the reader cannot follow. */
    unseen?: string
  }
  /** `digest`: of what declares the class, when the class is known though the body was not read. */
  | { unread: string; digest?: string }

export interface RouteSecurityRecord {
  method: string
  path: string
  name?: string
  module: string | null
  /** `file#export.action` (or `Class.action` where introspection placed no file), what a route is matched to its base counterpart by first. */
  action?: string
  middleware: MiddlewareRecord[]
  contracts: Partial<Record<ContractKey, ContractRecord>>
  handler: ActionRecord
  /** Each bound parameter and its model class, as `file#export` where introspection found the class, else by name. The lookup column is not in the manifest. */
  bindings?: Record<string, string>
  /** The `.agent()` metadata as declared, which makes the route a tool. */
  agent?: AgentRouteMetadata
}

export interface SecurityRecords {
  recordVersion: number
  routes: RouteSecurityRecord[]
  /** What introspection skipped that may register routes this list lacks (`skippedRegistrars()`). */
  skipped?: string[]
}

/**
 * The two sides' records, or why they could not both be read. `side` names the one the reader
 * could not read, when only one: a head the change made unreadable is not a missing base.
 */
export type SecurityRecordPair = { base: SecurityRecords; head: SecurityRecords } | { unavailable: string; side?: 'base' | 'head'; head?: SecurityRecords }

const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : entry)

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

/** Two values of a record equal as the comparison reads them, key order aside. */
export const sameRecordPart: (a: unknown, b: unknown) => boolean = same

const LOWER_BOUNDS = new Set(['minLength', 'minimum', 'exclusiveMinimum', 'minItems', 'minProperties'])
const UPPER_BOUNDS = new Set(['maxLength', 'maximum', 'exclusiveMaximum', 'maxItems', 'maxProperties'])

/**
 * Whether `head` only tightens `base`: properties, required keys or bounds gained, nothing else
 * different. Any other difference, a description included, is not proven tighter.
 */
export function schemaOnlyTightens(base: unknown, head: unknown): boolean {
  if (same(base, head)) return true
  if (!base || !head || typeof base !== 'object' || typeof head !== 'object' || Array.isArray(base) || Array.isArray(head)) return false
  const before = base as Record<string, unknown>
  const after = head as Record<string, unknown>
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const [a, b] = [before[key], after[key]]
    if (key === 'properties') {
      if (a === undefined) continue
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
      const [ap, bp] = [a as Record<string, unknown>, b as Record<string, unknown>]
      if (Object.keys(ap).some((name) => !(name in bp) || !schemaOnlyTightens(ap[name], bp[name]))) return false
      continue
    }
    if (key === 'required') {
      const [ar, br] = [a ?? [], b ?? []]
      if (!Array.isArray(ar) || !Array.isArray(br) || ar.some((name) => !br.includes(name))) return false
      continue
    }
    if (LOWER_BOUNDS.has(key) || UPPER_BOUNDS.has(key)) {
      if (b === undefined) return false
      if (a === undefined) continue
      if (typeof a !== 'number' || typeof b !== 'number') return false
      if (LOWER_BOUNDS.has(key) ? b < a : b > a) return false
      continue
    }
    if (!same(a, b)) return false
  }
  return true
}

export type RecordVerdict =
  | { verdict: 'same' | 'stronger' }
  | { verdict: 'weaker'; authorization: string[]; validation: string[] }
  | { verdict: 'incomparable'; reasons: string[] }

const entryKey = (entry: MiddlewareRecord): string => canonical([entry.kind, entry.name, entry.capabilities, entry.ability ?? null, entry.members ?? null])
const hasCapability = (entry: MiddlewareRecord): boolean => entry.capabilities.authentication !== undefined || entry.capabilities.authorization !== undefined
const entryName = (entry: MiddlewareRecord): string => entry.name ?? (entry.kind === 'inline' ? 'an inline middleware' : `an unnamed ${entry.kind}`)
const requiresAuthentication = (chain: MiddlewareRecord[]): boolean => chain.some((entry) => entry.capabilities.authentication?.mode === 'required')

/** Removes and returns the items of `from` matched one to one in `other`, in `from`'s order. */
function matchedInOrder<T>(from: T[], other: T[], key: (item: T) => string): string[] {
  const left = other.map(key)
  return from.map(key).filter((entry) => {
    const at = left.indexOf(entry)
    if (at === -1) return false
    left.splice(at, 1)
    return true
  })
}

/** One to one: each item of `base` is matched to an equal item of `head` at most once. */
function unmatched<T>(base: T[], head: T[], key: (item: T) => string): { gone: T[]; added: T[] } {
  const added = [...head]
  const gone: T[] = []
  for (const item of base) {
    const at = added.findIndex((other) => key(other) === key(item))
    if (at === -1) gone.push(item)
    else added.splice(at, 1)
  }
  return { gone, added }
}

function compareChain(base: RouteSecurityRecord, head: RouteSecurityRecord, out: { incomparable: string[]; authorization: string[] }): boolean {
  let stronger = false
  for (const entry of [...base.middleware, ...head.middleware]) {
    if (entry.unresolved) out.incomparable.push(`the middleware ${entryName(entry)} is not registered, so what it enforces is unread`)
    if (entry.unresolvedMembers?.length) out.incomparable.push(`the group ${entryName(entry)} names ${entry.unresolvedMembers.join(', ')}, which nothing registers`)
    const authz = entry.capabilities.authorization
    if (authz?.mode === 'mixed') out.incomparable.push(`${entryName(entry)} combines authorization checks whose ability is not derivable`)
    if (authz?.resource && !authz.resource.fromMethodMap) out.incomparable.push(`${entryName(entry)} resolves its ability at request time`)
  }
  // Each base entry paired with at most one head entry, by index: equal first, then kept or same-named.
  const pairs: Array<[number, number]> = []
  const free = new Set(head.middleware.keys())
  const gone: number[] = []
  for (const [index, entry] of base.middleware.entries()) {
    const at = [...free].find((other) => entryKey(head.middleware[other]!) === entryKey(entry))
    if (at === undefined) gone.push(index)
    else { free.delete(at); pairs.push([index, at]) }
  }
  const authenticationKept = requiresAuthentication(head.middleware)
  for (const index of gone) {
    const entry = base.middleware[index]!
    const sameGroup = entry.kind === 'group' ? [...free].find((other) => head.middleware[other]!.kind === 'group' && head.middleware[other]!.name === entry.name) : undefined
    if (sameGroup !== undefined) {
      const group = head.middleware[sameGroup]!
      const [before, after] = [entry.members ?? [], group.members ?? []]
      const lost = before.filter((member) => !after.includes(member))
      if (lost.length > 0) { out.incomparable.push(`the group ${entryName(entry)} no longer runs ${lost.join(', ')}`); continue }
      if (!same(before, after.filter((member) => before.includes(member)))) { out.incomparable.push(`the group ${entryName(entry)} runs its members in another order`); continue }
      if (same(entry.capabilities, group.capabilities) && same(entry.ability ?? null, group.ability ?? null)) { free.delete(sameGroup); pairs.push([index, sameGroup]); stronger = true; continue }
    }
    if (!hasCapability(entry)) { out.incomparable.push(`${entryName(entry)}, a middleware that declares no capability, was removed or changed`); continue }
    const authn = entry.capabilities.authentication
    const authnKept = authn?.mode !== 'required' || authenticationKept
    const authz = entry.capabilities.authorization
    if (!authz) {
      if (!authnKept) out.authorization.push(`${entryName(entry)} (${describeCapabilities(entry.capabilities)}) is no longer on the chain`)
      continue
    }
    const kept = [...free].find((other) => {
      const candidate = head.middleware[other]!
      const theirs = candidate.capabilities.authorization
      if (!theirs || theirs.mode !== authz.mode || (candidate.ability ?? null) !== (entry.ability ?? null)) return false
      return authz.mode === 'all' ? authz.abilities.every((ability) => theirs.abilities.includes(ability)) : theirs.abilities.every((ability) => authz.abilities.includes(ability))
    })
    if (kept !== undefined && authnKept) { free.delete(kept); pairs.push([index, kept]); stronger = true; continue }
    out.authorization.push(`${entryName(entry)} (${describeCapabilities(entry.capabilities)}) is no longer on the chain`)
  }
  // The paired entries in base order must stay in head order: a changed order is incomparable.
  const order = pairs.sort(([a], [b]) => a - b).map(([, at]) => at)
  if (order.some((at, i) => i > 0 && at < order[i - 1]!)) out.incomparable.push('the chain runs the same middleware in another order')
  return stronger || free.size > 0
}

/** Compares one route's two records by RFC 0040 §3's table. */
export function compareRecords(base: RouteSecurityRecord, head: RouteSecurityRecord): RecordVerdict {
  if (same({ ...base, method: '', path: '', name: '' }, { ...head, method: '', path: '', name: '' })) return { verdict: 'same' }
  const incomparable: string[] = []
  const authorization: string[] = []
  const validation: string[] = []
  let stronger = compareChain(base, head, { incomparable, authorization })

  for (const key of CONTRACT_KEYS) {
    const [a, b] = [base.contracts[key], head.contracts[key]]
    if (!a) { if (b) stronger = true; continue }
    if (!b) { validation.push(`the ${key} contract is gone`); continue }
    if (!same(a.exports, b.exports)) { incomparable.push(`the ${key} contract is another validator export (${a.exports.join(', ') || 'none'} → ${b.exports.join(', ') || 'none'})`); continue }
    const unreadable = (schema: unknown): boolean => !!schema && typeof schema === 'object' && 'unreadable' in schema
    if (unreadable(a.schema) || unreadable(b.schema)) {
      // Not rendered: the export's declaration is what can be compared.
      if (!same(a.schema, b.schema) || !same(a.declarations, b.declarations) || a.exports.length === 0) incomparable.push(`the ${key} schema is not rendered and its declaration changed or is not known`)
      continue
    }
    if (same(a.schema, b.schema)) continue
    if (schemaOnlyTightens(a.schema, b.schema)) stronger = true
    else incomparable.push(`the ${key} schema lost a property, a required key or a bound, or changed otherwise`)
  }

  if ('unread' in base.handler || 'unread' in head.handler) {
    if (!same(base.handler, head.handler)) incomparable.push(`the action ${'unread' in head.handler ? `at the head was not read: ${head.handler.unread}` : 'at the base was not read'}`)
  } else {
    const [a, b] = [base.handler, head.handler]
    if (a.authenticates && !b.authenticates && !requiresAuthentication(head.middleware)) authorization.push('the action no longer refuses a guest (auth.userOrFail() or apiToken())')
    if (!a.authenticates && b.authenticates) stronger = true
    if ((a.unseen || b.unseen) && a.unseen !== b.unseen) incomparable.push('the action makes a call whose ability or schema the reader cannot follow, and its body changed')

    const callKey = (call: AuthorizationCall): string => canonical(call)
    const calls = unmatched(a.authorizes, b.authorizes, callKey)
    if (!same(matchedInOrder(a.authorizes, b.authorizes, callKey), matchedInOrder(b.authorizes, a.authorizes, callKey))) incomparable.push('the authorization calls run in another order')
    for (const call of calls.gone) {
      const other = calls.added.find((entry) => entry.member === call.member)
      if (other) incomparable.push(`this.${call.member}('${call.ability}'${call.subject ? `, ${call.subject}` : ''}) became this.${other.member}('${other.ability}'${other.subject ? `, ${other.subject}` : ''})`)
      else authorization.push(`this.${call.member}('${call.ability}') is no longer called`)
    }
    if (calls.gone.length === 0 && calls.added.length > 0) stronger = true

    const validateKey = (call: ValidateCall): string => `${call.member}\0${call.schema}`
    const validates = unmatched(a.validates, b.validates, validateKey)
    for (const call of a.validates) {
      const other = b.validates.find((entry) => validateKey(entry) === validateKey(call))
      if (other && other.declaration !== call.declaration) incomparable.push(`${call.schema || 'a schema'} changed, and a schema an action validates with is not rendered`)
    }
    const label = (call: ValidateCall): string => `${call.member}(${call.schema || 'a schema written in place'})`
    if (validates.gone.length > 0 && validates.added.length > 0) incomparable.push(`the action calls ${validates.added.map(label).join(', ')} in place of ${validates.gone.map(label).join(', ')}`)
    else if (validates.gone.length > 0) validation.push(`the action no longer calls ${validates.gone.map(label).join(', ')}`)
    else if (validates.added.length > 0) stronger = true
  }

  if (incomparable.length > 0) return { verdict: 'incomparable', reasons: [...new Set(incomparable)] }
  if (authorization.length > 0 || validation.length > 0) return { verdict: 'weaker', authorization, validation }
  return { verdict: stronger ? 'stronger' : 'same' }
}

function describeCapabilities(capabilities: MiddlewareCapabilities): string {
  const parts: string[] = []
  if (capabilities.authentication) parts.push(`authentication ${capabilities.authentication.mode}`)
  if (capabilities.authorization) parts.push(`authorization ${capabilities.authorization.mode} ${capabilities.authorization.abilities.join(', ') || '(no ability)'}`)
  return parts.join('; ')
}

const routeLabel = (route: RouteSecurityRecord): string => `${route.method} ${route.path}`
const moduleOf = (route: RouteSecurityRecord): string => route.module ?? ''
const actionMethod = (route: RouteSecurityRecord): string | undefined => route.action?.slice(route.action.lastIndexOf('.') + 1)

export interface SecurityComparison {
  facts: ChangeFact[]
  /** Routes whose records could not be ordered: `unjudged` at high. */
  incomparable: string[]
  /** Head routes with no base counterpart, and not read as a move of one that left. */
  added: RouteSecurityRecord[]
  /** Base routes no head route was matched to. */
  removed: RouteSecurityRecord[]
  /** Matched pairs whose records differ in anything, endpoint and name included. */
  changed: Array<{ base: RouteSecurityRecord; head: RouteSecurityRecord }>
}

/** The base routes a head route is compared with: by action, then by method and path in its module, then across modules. */
function counterpartsOf(route: RouteSecurityRecord, base: RouteSecurityRecord[]): RouteSecurityRecord[] | { ambiguous: string } {
  const inModule = base.filter((entry) => moduleOf(entry) === moduleOf(route))
  const byAction = route.action ? inModule.filter((entry) => entry.action === route.action) : []
  const sameEndpoint = (entry: RouteSecurityRecord): boolean => entry.method === route.method && entry.path === route.path
  if (byAction.length === 1) return byAction
  if (byAction.length > 1) {
    const exact = byAction.filter(sameEndpoint)
    return exact.length === 1 ? exact : byAction
  }
  const byEndpoint = inModule.filter(sameEndpoint)
  if (byEndpoint.length === 1) return byEndpoint
  if (byEndpoint.length > 1) return { ambiguous: `${byEndpoint.length} base routes share its method and path` }
  const anywhere = base.filter(sameEndpoint)
  if (anywhere.length > 1) return { ambiguous: `${anywhere.length} base routes in other modules share its method and path` }
  return anywhere
}

/**
 * Matches each head route to its base counterpart and turns the verdicts into facts. An added
 * route to an action that has routes at the base is compared with each of them, so a second path
 * with fewer guards is Weaker. A head route with no counterpart, while a base route of its method
 * and its action's method name or path left, is a rename and a move the reader cannot pair.
 */
export function compareSecurityRecords(base: SecurityRecords, head: SecurityRecords): SecurityComparison {
  const facts: ChangeFact[] = []
  const incomparable: string[] = []
  const matched = new Set<RouteSecurityRecord>()
  const orphans: RouteSecurityRecord[] = []
  const added: RouteSecurityRecord[] = []
  const changed: SecurityComparison['changed'] = []
  for (const route of head.routes) {
    const counterparts = counterpartsOf(route, base.routes)
    if (!Array.isArray(counterparts)) { incomparable.push(`${routeLabel(route)}: ${counterparts.ambiguous}`); continue }
    if (counterparts.length === 0) { orphans.push(route); continue }
    for (const counterpart of counterparts) {
      matched.add(counterpart)
      if (!same(counterpart, route)) changed.push({ base: counterpart, head: route })
      const result = compareRecords(counterpart, route)
      const label = counterpart.path === route.path && counterpart.method === route.method ? routeLabel(route) : `${routeLabel(route)} (against ${routeLabel(counterpart)})`
      if (result.verdict === 'incomparable') incomparable.push(`${label}: ${result.reasons.join('; ')}`)
      else if (result.verdict === 'weaker') {
        if (result.authorization.length > 0) facts.push({ code: 'authorization-removed', lane: 'high', evidence: 'static', files: [], message: `${label}: ${result.authorization.join('; ')}` })
        if (result.validation.length > 0) facts.push({ code: 'validation-removed', lane: 'high', evidence: 'static', files: [], message: `${label}: ${result.validation.join('; ')}` })
      }
    }
  }
  const left = base.routes.filter((entry) => !matched.has(entry))
  for (const route of orphans) {
    const gone = left.find((entry) => entry.method === route.method && (entry.path === route.path || (actionMethod(entry) !== undefined && actionMethod(entry) === actionMethod(route))))
    if (gone) incomparable.push(`${routeLabel(route)} has no counterpart at the base, while ${routeLabel(gone)}${gone.action ? ` (${gone.action})` : ''} left it: a rename and a move the reader cannot pair`)
    else added.push(route)
  }
  // Pairing compares each head route with its counterparts, so one endpoint registered once more pairs twice: the extra registrations are added.
  const endpoint = (route: RouteSecurityRecord): string => `${moduleOf(route)}\u0000${route.method}\u0000${route.path}`
  const atBase = new Map<string, number>()
  for (const route of base.routes) atBase.set(endpoint(route), (atBase.get(endpoint(route)) ?? 0) + 1)
  const seen = new Map<string, number>()
  for (const route of head.routes) {
    const count = (seen.get(endpoint(route)) ?? 0) + 1
    seen.set(endpoint(route), count)
    // An endpoint the base lacks is a move or an addition, which the pairing above has judged.
    const before = atBase.get(endpoint(route)) ?? 0
    if (before > 0 && count > before && !added.includes(route) && !orphans.includes(route)) added.push(route)
  }
  return { facts, incomparable, added, removed: left, changed }
}
