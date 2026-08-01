import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import * as z3 from 'zod/v3'
import {
  arrayElement,
  enumValues,
  isTransform,
  literalValues,
  normalizeTypeName,
  objectShape,
  pipeSide,
  schemaAt,
  typeOf,
} from './zod-compat'

describe('typeOf', () => {
  test('normalizes a Zod v4 type name', () => {
    expect(typeOf(z.string() as never)).toBe('string')
  })

  test('normalizes a Zod v3 type name', () => {
    expect(typeOf(z3.string() as never)).toBe('string')
  })

  test('returns "unknown" for a node with no readable type name', () => {
    expect(typeOf({} as never)).toBe('unknown')
  })
})

describe('normalizeTypeName', () => {
  test('strips the "Zod" prefix and lowercases', () => {
    expect(normalizeTypeName('ZodString')).toBe('string')
  })

  test('lowercases a v4 bare type name', () => {
    expect(normalizeTypeName('string')).toBe('string')
  })

  test('returns "unknown" for undefined', () => {
    expect(normalizeTypeName(undefined)).toBe('unknown')
  })
})

describe('arrayElement', () => {
  // v4 puts the string 'array' in `_def.type` alongside the real element in
  // `_def.element`. Taking `_def.type` yields that string, which every caller
  // then renders as an empty/unknown element — the bug fixed once per package.
  test('reads the element off a Zod v4 array, not the type-name string in _def.type', () => {
    const arraySchema = z.array(z.string())
    const def = (arraySchema as never as { _def: Record<string, unknown> })._def
    expect(def.type).toBe('array')
    const element = arrayElement(def)
    expect(element).toBeDefined()
    expect(typeOf(element!)).toBe('string')
  })

  test('reads the element off a Zod v3 array', () => {
    const arraySchema = z3.array(z3.number())
    const def = (arraySchema as never as { _def: Record<string, unknown> })._def
    const element = arrayElement(def)
    expect(element).toBeDefined()
    expect(typeOf(element!)).toBe('number')
  })
})

describe('objectShape', () => {
  test('reads a Zod v4 object shape', () => {
    const schema = z.object({ name: z.string() })
    const shape = objectShape(schema as never)
    expect(shape && Object.keys(shape)).toEqual(['name'])
  })

  test('reads a Zod v3 object shape (shape is a function)', () => {
    const schema = z3.object({ name: z3.string() })
    const shape = objectShape(schema as never)
    expect(shape && Object.keys(shape)).toEqual(['name'])
  })
})

describe('pipeSide', () => {
  test('reads the coerced-from side for input, the parsed side for output', () => {
    const schema = z.string().pipe(z.coerce.number())
    const def = (schema as never as { _def: Record<string, unknown> })._def
    expect(typeOf(pipeSide(def, 'input')!)).toBe('string')
    expect(typeOf(pipeSide(def, 'output')!)).toBe('number')
  })

  test('falls back to the input side when the output side is a transform', () => {
    const schema = z.string().transform((value) => value.length)
    const def = (schema as never as { _def: Record<string, unknown> })._def
    expect(typeOf(pipeSide(def, 'output')!)).toBe('string')
  })
})

describe('isTransform', () => {
  test('identifies a transform node', () => {
    const schema = z.string().transform((value) => value.length)
    const def = (schema as never as { _def: Record<string, unknown> })._def
    const out = schemaAt(def, 'out')!
    expect(isTransform(out)).toBe(true)
  })

  test('a plain schema is not a transform', () => {
    expect(isTransform(z.string() as never)).toBe(false)
  })
})

describe('enumValues', () => {
  test('reads a Zod v4 enum (entries object)', () => {
    const schema = z.enum(['a', 'b'])
    const def = (schema as never as { _def: Record<string, unknown> })._def
    expect(enumValues(def)).toEqual(['a', 'b'])
  })

  test('reads a Zod v3 enum (values array)', () => {
    const schema = z3.enum(['a', 'b'])
    const def = (schema as never as { _def: Record<string, unknown> })._def
    expect(enumValues(def)).toEqual(['a', 'b'])
  })
})

describe('literalValues', () => {
  test('reads a Zod v3 single literal value', () => {
    const schema = z3.literal('a')
    const def = (schema as never as { _def: Record<string, unknown> })._def
    expect(literalValues(def)).toEqual(['a'])
  })

  test('reads Zod v4 literal values', () => {
    const schema = z.literal('a')
    const def = (schema as never as { _def: Record<string, unknown> })._def
    expect(literalValues(def)).toEqual(['a'])
  })
})
