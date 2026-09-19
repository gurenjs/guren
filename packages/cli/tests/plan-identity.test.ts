import { describe, expect, test } from 'bun:test'

import { canonicalJson, PlanCanonicalizationError, planHash } from '../src/plan/identity'
import { PlanSchema, type Plan } from '../src/plan/schema'
import { loadCommentsPlan, TEST_BASELINE } from './plan-fixture'

function validPlan(): Plan {
  return PlanSchema.parse({ ...loadCommentsPlan(), baseline: TEST_BASELINE })
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
    expect(canonicalJson({ text: 'line\n"quoted" \u2028' })).toBe(JSON.stringify({ text: 'line\n"quoted" \u2028' }))
  })

  test('should keep NFC and NFD text apart, as the files that hold them are', () => {
    expect(canonicalJson('\u30AC')).not.toBe(canonicalJson('\u30AB\u3099'))
  })

  test('should accept an object with no prototype', () => {
    const record = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 })

    expect(canonicalJson(record)).toBe('{"a":1}')
  })

  test('should throw on a non-finite number rather than hashing it as null', () => {
    expect(() => canonicalJson({ status: Number.NaN })).toThrow(PlanCanonicalizationError)
    expect(() => canonicalJson({ expect: { status: Number.POSITIVE_INFINITY } })).toThrow('expect.status')
  })

  test('should throw on a sparse array rather than hashing it as a shorter one', () => {
    const holed: unknown[] = [1]
    holed[2] = 3

    expect(() => canonicalJson({ routes: Array(1) })).toThrow('routes[0]')
    expect(() => canonicalJson(holed)).toThrow(PlanCanonicalizationError)
  })

  test('should throw on an undefined array item', () => {
    expect(() => canonicalJson([undefined])).toThrow(PlanCanonicalizationError)
  })

  test('should throw on an object that is not a plain record rather than hashing it as {}', () => {
    expect(() => canonicalJson({ at: new Date(0) })).toThrow('not a plain object (Date)')
    expect(() => canonicalJson(new Map([[1, 2]]))).toThrow(PlanCanonicalizationError)
  })

  test('should throw on a cycle, and accept the same object reached twice without one', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const shared = { id: 'model.post' }

    expect(() => canonicalJson(cyclic)).toThrow('cycle')
    expect(canonicalJson({ a: shared, b: shared })).toBe('{"a":{"id":"model.post"},"b":{"id":"model.post"}}')
  })

  test('should throw on a value JSON cannot carry', () => {
    expect(() => canonicalJson({ run: () => 1 })).toThrow(PlanCanonicalizationError)
    expect(() => canonicalJson({ big: 1n })).toThrow(PlanCanonicalizationError)
  })
})

describe('planHash', () => {
  test('should be the SHA-256 of the canonical bytes', () => {
    const plan = { a: 1 } as unknown as Plan

    // printf '{"a":1}' | shasum -a 256
    expect(planHash(plan)).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862')
  })

  test('should not depend on key order', () => {
    const plan = validPlan()

    expect(planHash(reverseKeys(plan) as Plan)).toBe(planHash(plan))
  })

  test('should depend on array order, which is document order', () => {
    const plan = validPlan()
    const reordered = structuredClone(plan)
    reordered.routes.reverse()

    expect(planHash(reordered)).not.toBe(planHash(plan))
  })

  test('should change when any value changes', () => {
    const plan = validPlan()
    const edited = structuredClone(plan)
    edited.models[1]!.columns[1]!.nullable = true

    expect(planHash(edited)).not.toBe(planHash(plan))
  })

  test('should change when only the baseline changes', () => {
    const plan = validPlan()
    const moved = structuredClone(plan)
    moved.baseline.contextHash['model.post'] = 'cd34'

    expect(planHash(moved)).not.toBe(planHash(plan))
  })

  test('should name a document that omits an empty section like one that spells it out', () => {
    const omitted = PlanSchema.parse({ ...loadCommentsPlan(), baseline: TEST_BASELINE })
    const spelled = PlanSchema.parse({
      ...loadCommentsPlan(),
      sideEffects: [],
      commands: [],
      hints: [],
      baseline: TEST_BASELINE,
    })

    expect(planHash(spelled)).toBe(planHash(omitted))
  })
})
