/**
 * Plan identity (RFC 0030 §4): the SHA-256 of a plan's canonical bytes. The hash is
 * the only name a plan has, so two machines must agree on the bytes for equal
 * plans: keys sorted, arrays in document order, no insignificant whitespace.
 * Strings are hashed as written. No Unicode normalization: NFC and NFD text are
 * different plans, as they are different files.
 */

import { createHash } from 'node:crypto'

import type { Plan } from './schema'

export class PlanCanonicalizationError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot canonicalize plan at ${path || '<root>'}: ${reason}`)
    this.name = 'PlanCanonicalizationError'
  }
}

/** Accepts what `JSON.parse` can produce and nothing else; anything richer would hash ambiguously. */
export function canonicalJson(value: unknown): string {
  return write(value, '', new Set())
}

/**
 * Hash a *parsed* plan: `PlanSchema.parse()` fills defaulted sections, and a raw
 * document that omits one would otherwise name the same plan differently.
 * A draft has no identity, since the baseline it lacks is part of what is approved.
 */
export function planHash(plan: Plan): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}

function write(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      // NaN and Infinity serialize as `null`, which would hash two different plans alike.
      if (!Number.isFinite(value)) throw new PlanCanonicalizationError(path, 'non-finite number')
      return JSON.stringify(value)
    case 'object':
      break
    default:
      throw new PlanCanonicalizationError(path, `unsupported ${typeof value}`)
  }

  if (ancestors.has(value)) throw new PlanCanonicalizationError(path, 'cycle')
  ancestors.add(value)
  const text = Array.isArray(value) ? writeArray(value, path, ancestors) : writeRecord(value, path, ancestors)
  ancestors.delete(value)
  return text
}

function writeArray(items: unknown[], path: string, ancestors: Set<object>): string {
  const parts: string[] = []
  // By index, not `map`: `map` skips holes, so a sparse array would hash as a shorter one.
  // A hole reads as `undefined` here and is refused like any other.
  for (let index = 0; index < items.length; index++) {
    parts.push(write(items[index], `${path}[${index}]`, ancestors))
  }
  return `[${parts.join(',')}]`
}

function writeRecord(value: object, path: string, ancestors: Set<object>): string {
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    // A Date or a Map has no own enumerable keys and would hash as `{}`.
    throw new PlanCanonicalizationError(path, `not a plain object (${value.constructor?.name ?? 'unknown'})`)
  }

  const record = value as Record<string, unknown>
  const members: string[] = []
  // Code-unit order, not locale order: `localeCompare` differs between machines.
  for (const key of Object.keys(record).sort()) {
    const member = record[key]
    // An absent optional and an explicit `undefined` are the same plan.
    if (member === undefined) continue
    members.push(`${JSON.stringify(key)}:${write(member, path ? `${path}.${key}` : key, ancestors)}`)
  }
  return `{${members.join(',')}}`
}
