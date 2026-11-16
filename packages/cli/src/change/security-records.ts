/**
 * Per-route security records (RFC 0040 §3): what each route enforces, read from the introspected
 * application and the action body, and the comparison of two sides that gives
 * `authorization-removed` and `validation-removed`. The comparison fails closed: only records that
 * are equal, or provably stronger, give no fact, and anything it cannot order is incomparable.
 */
import type { MiddlewareEntry } from '@guren/server'

import type { ChangeFact } from './lane'

/** Bumped whenever a field's meaning changes: a stored record of another version is not compared. */
export const SECURITY_RECORD_VERSION = 1

const CONTRACT_KEYS = ['params', 'query', 'body'] as const
type ContractKey = (typeof CONTRACT_KEYS)[number]

type MiddlewareCapabilities = MiddlewareEntry['capabilities']

export type MiddlewareRecord = Pick<MiddlewareEntry, 'kind' | 'name' | 'capabilities' | 'ability' | 'unresolved'>

export interface ContractRecord {
  /** The JSON Schema the manifest renders, or why it could not. */
  schema: unknown
  /** `file#export` of each validator export the schema object is; empty when none is. */
  exports: string[]
}

/** What the action body shows, or why it was not read. */
export type ActionRecord =
  | {
    /** The action calls `auth.userOrFail()` or `apiToken()`, which refuse a guest. */
    authenticates: boolean
    authorizes: Array<{ member: 'authorize' | 'can'; ability: string }>
    /** An `authorize()`/`can()` call whose ability is not a literal: resolved at request time. */
    dynamicAuthorization?: true
    /** The schema each validate call passes, as written. */
    validates: string[]
    /** A validate call whose argument the reader cannot follow. */
    dynamicValidation?: true
  }
  | { unread: string }

export interface RouteSecurityRecord {
  method: string
  path: string
  name?: string
  module: string | null
  /** `Class.action`, what a route is matched to its base counterpart by first. */
  action?: string
  middleware: MiddlewareRecord[]
  contracts: Partial<Record<ContractKey, ContractRecord>>
  handler: ActionRecord
}

export interface SecurityRecords {
  recordVersion: number
  routes: RouteSecurityRecord[]
}

/** The two sides' records, or why they could not both be read. */
export type SecurityRecordPair = { base: SecurityRecords; head: SecurityRecords } | { unavailable: string }

const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : entry)

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b)

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

const capabilityKey = (entry: MiddlewareRecord): string => canonical(entry.capabilities)
const entryKey = (entry: MiddlewareRecord): string => canonical([entry.kind, entry.name, entry.capabilities, entry.ability ?? null])
const hasCapability = (entry: MiddlewareRecord): boolean => entry.capabilities.authentication !== undefined || entry.capabilities.authorization !== undefined
const entryName = (entry: MiddlewareRecord): string => entry.name ?? (entry.kind === 'inline' ? 'an inline middleware' : `an unnamed ${entry.kind}`)

/** Compares one route's two records by RFC 0040 §3's table. */
export function compareRecords(base: RouteSecurityRecord, head: RouteSecurityRecord): RecordVerdict {
  if (same({ ...base, method: '', path: '', name: '' }, { ...head, method: '', path: '', name: '' })) return { verdict: 'same' }
  const incomparable: string[] = []
  const authorization: string[] = []
  const validation: string[] = []
  let stronger = false

  // The chain.
  for (const entry of [...base.middleware, ...head.middleware]) {
    if (entry.unresolved) incomparable.push(`the middleware ${entryName(entry)} is not registered, so what it enforces is unread`)
    const authz = entry.capabilities.authorization
    if (authz?.mode === 'mixed') incomparable.push(`${entryName(entry)} combines authorization checks whose ability is not derivable`)
    if (authz?.resource && !authz.resource.fromMethodMap) incomparable.push(`${entryName(entry)} resolves its ability at request time`)
  }
  const [baseCapable, headCapable] = [base.middleware.filter(hasCapability), head.middleware.filter(hasCapability)]
  const headKeys = headCapable.map(capabilityKey)
  for (const entry of baseCapable) {
    if (headKeys.includes(capabilityKey(entry))) continue
    const authn = entry.capabilities.authentication
    if (authn?.mode === 'guest-only' && !entry.capabilities.authorization) continue
    if (authn?.mode === 'required' && head.middleware.some((other) => other.capabilities.authentication?.mode === 'required') && !entry.capabilities.authorization) continue
    const authz = entry.capabilities.authorization
    if (authz) {
      const kept = headCapable.find((other) => other.capabilities.authorization?.mode === authz.mode && other.ability === entry.ability)
      const abilities = kept?.capabilities.authorization?.abilities
      if (abilities && authz.mode === 'all' && authz.abilities.every((ability) => abilities.includes(ability))) { stronger = true; continue }
      if (abilities && authz.mode === 'any' && abilities.every((ability) => authz.abilities.includes(ability))) { stronger = true; continue }
    }
    authorization.push(`${entryName(entry)} (${describeCapabilities(entry.capabilities)}) is no longer on the chain`)
  }
  // The whole chain, as a multiset of entries: an inline middleware has no name to tell it by.
  const [baseEntries, headEntries] = [base.middleware.map(entryKey), head.middleware.map(entryKey)]
  const common = (from: string[], other: string[]): string[] => {
    const left = [...other]
    return from.filter((key) => {
      const at = left.indexOf(key)
      if (at === -1) return false
      left.splice(at, 1)
      return true
    })
  }
  if (!same(common(baseEntries, headEntries), common(headEntries, baseEntries))) incomparable.push('the chain runs the same middleware in another order')
  const remainingHead = [...headEntries]
  for (const [index, key] of baseEntries.entries()) {
    const at = remainingHead.indexOf(key)
    if (at !== -1) { remainingHead.splice(at, 1); continue }
    const entry = base.middleware[index]!
    if (!hasCapability(entry)) incomparable.push(`${entryName(entry)}, a middleware that declares no capability, was removed or changed`)
  }
  if (remainingHead.length > 0) stronger = true

  // The contracts.
  for (const key of CONTRACT_KEYS) {
    const [a, b] = [base.contracts[key], head.contracts[key]]
    if (!a) { if (b) stronger = true; continue }
    if (!b) { validation.push(`the ${key} contract is gone`); continue }
    if (!same(a.exports, b.exports)) { incomparable.push(`the ${key} contract is another validator export (${a.exports.join(', ') || 'none'} → ${b.exports.join(', ') || 'none'})`); continue }
    if (same(a.schema, b.schema)) continue
    if (schemaOnlyTightens(a.schema, b.schema)) stronger = true
    else incomparable.push(`the ${key} schema lost a property, a required key or a bound, or changed otherwise`)
  }

  // The action body.
  if ('unread' in base.handler || 'unread' in head.handler) {
    if (!same(base.handler, head.handler)) incomparable.push(`the action ${'unread' in head.handler ? `at the head was not read: ${head.handler.unread}` : 'at the base was not read'}`)
  } else {
    const [a, b] = [base.handler, head.handler]
    // Moved onto the chain is not lost.
    if (a.authenticates && !b.authenticates && !head.middleware.some((entry) => entry.capabilities.authentication?.mode === 'required')) authorization.push('the action no longer refuses a guest (auth.userOrFail() or apiToken())')
    if (!a.authenticates && b.authenticates) stronger = true
    if (a.dynamicAuthorization || b.dynamicAuthorization) {
      if (!same([a.authorizes, a.dynamicAuthorization], [b.authorizes, b.dynamicAuthorization])) incomparable.push('an authorization call resolves its ability at request time')
    } else {
      const remaining = [...b.authorizes]
      const missing: typeof a.authorizes = []
      for (const call of a.authorizes) {
        const at = remaining.findIndex((other) => other.member === call.member && other.ability === call.ability)
        if (at === -1) missing.push(call)
        else remaining.splice(at, 1)
      }
      const replaced = missing.filter((call) => remaining.some((other) => other.member === call.member))
      if (replaced.length > 0) incomparable.push(`this.${replaced[0]!.member}('${replaced[0]!.ability}') became a call for another ability`)
      for (const call of missing.filter((entry) => !replaced.includes(entry))) authorization.push(`this.${call.member}('${call.ability}') is no longer called`)
      if (remaining.length > 0 && replaced.length === 0) stronger = true
      if (missing.length === 0 && !same(a.authorizes, b.authorizes) && remaining.length === 0) incomparable.push('the authorization calls run in another order')
    }
    if (a.dynamicValidation || b.dynamicValidation) {
      if (!same([a.validates, a.dynamicValidation], [b.validates, b.dynamicValidation])) incomparable.push('a validate call passes a schema the reader cannot follow')
    } else {
      const gone = a.validates.filter((schema) => !b.validates.includes(schema))
      const added = b.validates.filter((schema) => !a.validates.includes(schema))
      if (gone.length > 0 && added.length > 0) incomparable.push(`the action validates with ${added.join(', ')} in place of ${gone.join(', ')}`)
      else if (gone.length > 0) validation.push(`the action no longer validates with ${gone.join(', ')}`)
      else if (added.length > 0) stronger = true
    }
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

export interface SecurityComparison {
  facts: ChangeFact[]
  /** Routes whose records could not be ordered: `unjudged` at high. */
  incomparable: string[]
}

/**
 * Matches each head route to its base counterpart (by action, then by method and path, within a
 * module) and turns the verdicts into facts. An added route to an action that has routes at the
 * base is compared with each of them, so a second path with fewer guards is Weaker.
 */
export function compareSecurityRecords(base: SecurityRecords, head: SecurityRecords): SecurityComparison {
  const facts: ChangeFact[] = []
  const incomparable: string[] = []
  for (const route of head.routes) {
    const inModule = base.routes.filter((entry) => moduleOf(entry) === moduleOf(route))
    const byAction = route.action ? inModule.filter((entry) => entry.action === route.action) : []
    const byEndpoint = inModule.filter((entry) => entry.method === route.method && entry.path === route.path)
    let counterparts: RouteSecurityRecord[]
    if (byAction.length === 1) counterparts = byAction
    else if (byAction.length > 1) {
      const exact = byAction.filter((entry) => byEndpoint.includes(entry))
      counterparts = exact.length === 1 ? exact : byAction
    } else counterparts = byEndpoint
    if (byAction.length === 0 && byEndpoint.length > 1) {
      incomparable.push(`${routeLabel(route)}: ${byEndpoint.length} base routes share its method and path`)
      continue
    }
    for (const counterpart of counterparts) {
      const result = compareRecords(counterpart, route)
      const label = counterpart.path === route.path && counterpart.method === route.method ? routeLabel(route) : `${routeLabel(route)} (against ${routeLabel(counterpart)})`
      if (result.verdict === 'incomparable') incomparable.push(`${label}: ${result.reasons.join('; ')}`)
      else if (result.verdict === 'weaker') {
        if (result.authorization.length > 0) facts.push({ code: 'authorization-removed', lane: 'high', evidence: 'static', files: [], message: `${label}: ${result.authorization.join('; ')}` })
        if (result.validation.length > 0) facts.push({ code: 'validation-removed', lane: 'high', evidence: 'static', files: [], message: `${label}: ${result.validation.join('; ')}` })
      }
    }
  }
  return { facts, incomparable }
}
