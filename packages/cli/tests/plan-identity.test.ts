import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { canonicalJson, PlanCanonicalizationError, planHash } from '../src/plan/identity'
import { PlanDraftSchema, type PlanDraft } from '../src/plan/schema'

function validDraft(): PlanDraft {
  const text = readFileSync(join(import.meta.dir, 'fixtures/plan/comments.plan.json'), 'utf8')
  return PlanDraftSchema.parse(JSON.parse(text))
}

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys)
  if (value === null || typeof value !== 'object') return value
  const entries = Object.entries(value as Record<string, unknown>).reverse()
  return Object.fromEntries(entries.map(([key, member]) => [key, reverseKeys(member)]))
}

describe('canonicalJson', () => {
  test('should sort object keys and keep array order', () => {
    expect(canonicalJson({ b: [2, 1], a: { d: null, c: true } })).toBe('{"a":{"c":true,"d":null},"b":[2,1]}')
  })

  test('should sort keys by code unit, not by locale', () => {
    expect(canonicalJson({ a: 1, B: 2, _: 3 })).toBe('{"B":2,"_":3,"a":1}')
  })

  test('should drop undefined members, so an absent optional and an explicit one agree', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
  })

  test('should escape strings the way JSON does', () => {
    expect(canonicalJson({ text: 'line\n"quoted"  ' })).toBe(JSON.stringify({ text: 'line\n"quoted"  ' }))
  })

  test('should throw on a non-finite number rather than hashing it as null', () => {
    expect(() => canonicalJson({ status: Number.NaN })).toThrow(PlanCanonicalizationError)
    expect(() => canonicalJson({ expect: { status: Number.POSITIVE_INFINITY } })).toThrow('expect.status')
  })

  test('should throw on a value JSON cannot carry', () => {
    expect(() => canonicalJson({ run: () => 1 })).toThrow(PlanCanonicalizationError)
  })
})

describe('planHash', () => {
  test('should be a 64-character hex digest', () => {
    expect(planHash(validDraft())).toMatch(/^[0-9a-f]{64}$/)
  })

  test('should not depend on key order', () => {
    const draft = validDraft()

    expect(planHash(reverseKeys(draft) as PlanDraft)).toBe(planHash(draft))
  })

  test('should depend on array order, which is document order', () => {
    const draft = validDraft()
    const reordered = structuredClone(draft)
    reordered.routes.reverse()

    expect(planHash(reordered)).not.toBe(planHash(draft))
  })

  test('should change when any value changes', () => {
    const draft = validDraft()
    const edited = structuredClone(draft)
    edited.models[1]!.columns[1]!.nullable = true

    expect(planHash(edited)).not.toBe(planHash(draft))
  })
})
