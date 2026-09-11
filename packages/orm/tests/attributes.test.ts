import { describe, expect, it } from 'bun:test'
import { applyAccessors, applyMutators } from '../src/attributes'

describe('accessor and mutator keys', () => {
  it('refuses an accessor that would rewrite the prototype', () => {
    expect(() => applyAccessors({ id: 1 }, { ['__proto__']: () => ({ polluted: true }) })).toThrow(
      'cannot be named "__proto__"',
    )
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('refuses a mutator that would rewrite the prototype', () => {
    expect(() => applyMutators({ id: 1 }, { constructor: (value: unknown) => value })).toThrow('cannot be named "constructor"')
  })

  it('applies a mutator only to a field the record carries itself', () => {
    const result = applyMutators({ id: 1 }, { toString: () => 'x', id: (value: unknown) => Number(value) + 1 })
    expect(result.id).toBe(2)
    expect(Object.hasOwn(result, 'toString')).toBe(false)
  })
})
