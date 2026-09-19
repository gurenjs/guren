/**
 * Plan identity (RFC 0030 §4): the SHA-256 of a plan's canonical bytes. The hash is
 * the only name a plan has, so two machines must agree on the bytes for equal
 * plans: keys sorted, arrays in document order, no insignificant whitespace.
 */

import { createHash } from 'node:crypto'

import type { Plan, PlanDraft } from './schema'

export class PlanCanonicalizationError extends Error {
  constructor(path: string, reason: string) {
    super(`Cannot canonicalize plan at ${path || '<root>'}: ${reason}`)
    this.name = 'PlanCanonicalizationError'
  }
}

export function canonicalJson(value: unknown): string {
  return write(value, '')
}

export function planHash(plan: Plan | PlanDraft): string {
  return createHash('sha256').update(canonicalJson(plan), 'utf8').digest('hex')
}

function write(value: unknown, path: string): string {
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

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => write(item, `${path}[${index}]`)).join(',')}]`
  }

  const record = value as Record<string, unknown>
  const members: string[] = []
  // Code-unit order, not locale order: `localeCompare` differs between machines.
  for (const key of Object.keys(record).sort()) {
    const member = record[key]
    // An absent optional and an explicit `undefined` are the same plan.
    if (member === undefined) continue
    members.push(`${JSON.stringify(key)}:${write(member, path ? `${path}.${key}` : key)}`)
  }
  return `{${members.join(',')}}`
}
