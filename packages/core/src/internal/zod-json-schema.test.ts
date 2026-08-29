import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import * as z3 from 'zod/v3'
import { isZodSchema, type JsonSchemaObject, readObjectSchema, toJsonSchema } from './zod-json-schema'

/** The walk with its warnings, since almost every assertion cares about both. */
function walk(schema: unknown, io: 'input' | 'output' = 'input') {
  const warnings: string[] = []
  const result = toJsonSchema(schema, warnings, 'schema', io)
  return { result, warnings }
}

/** The rendered schema, asserting the walk had nothing to complain about. */
function clean(schema: unknown, io: 'input' | 'output' = 'input'): JsonSchemaObject | undefined {
  const { result, warnings } = walk(schema, io)
  expect(warnings).toEqual([])
  return result
}

describe('toJsonSchema', () => {
  describe('types', () => {
    test('renders the primitive types', () => {
      expect(clean(z.string())).toEqual({ type: 'string' })
      expect(clean(z.number())).toEqual({ type: 'number' })
      expect(clean(z.boolean())).toEqual({ type: 'boolean' })
      expect(clean(z.bigint())).toEqual({ type: 'integer' })
      expect(clean(z.date())).toEqual({ type: 'string', format: 'date-time' })
      expect(clean(z.null())).toEqual({ type: 'null' })
    })

    test('renders an object with only its non-omissible keys required', () => {
      expect(clean(z.object({ a: z.string(), b: z.number().optional() }))).toEqual({
        type: 'object',
        properties: { a: { type: 'string' }, b: { type: 'number' } },
        required: ['a'],
      })
    })

    test('renders a nullable as a union with null rather than unwrapping it', () => {
      expect(clean(z.string().nullable())).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] })
    })

    test('reads the side of a pipe that matches the direction being described', () => {
      const piped = z.string().pipe(z.coerce.number())

      expect(clean(piped, 'input')).toEqual({ type: 'string' })
      expect(clean(piped, 'output')).toEqual({ type: 'number' })
    })

    test('warns rather than quietly dropping a schema it cannot read', () => {
      const { result, warnings } = walk(z.lazy(() => z.string()))

      expect(result).toBeUndefined()
      expect(warnings).toEqual(['schema: the contents of a "lazy" schema could not be read, so it is omitted.'])
    })

    test('refuses a zod 3 node with a warning naming the v3 API', () => {
      const { result, warnings } = walk(z3.string())

      expect(result).toBeUndefined()
      expect(warnings[0]).toContain('zod v3 API')
    })
  })

  // The walker used to drop every check, so `z.string().min(1)` and
  // `z.string()` produced the same schema — an agent handed the second learns
  // nothing about what the endpoint will actually accept.
  describe('string constraints', () => {
    test('carries min and max length', () => {
      expect(clean(z.string().min(2).max(5))).toEqual({ type: 'string', minLength: 2, maxLength: 5 })
    })

    test('pins both ends of an exact length', () => {
      expect(clean(z.string().length(4))).toEqual({ type: 'string', minLength: 4, maxLength: 4 })
    })

    test('keeps the tighter of two bounds of the same kind', () => {
      expect(clean(z.string().min(2).min(5))).toEqual({ type: 'string', minLength: 5 })
      expect(clean(z.string().max(9).max(3))).toEqual({ type: 'string', maxLength: 3 })
    })

    test('carries a regex as the pattern source, not the /…/ literal', () => {
      expect(clean(z.string().regex(/^[a-z]+$/))).toEqual({ type: 'string', pattern: '^[a-z]+$' })
    })

    test('carries the patterns zod compiles for prefix, suffix and substring tests', () => {
      expect(clean(z.string().startsWith('draft-'))?.pattern).toBe('^draft-.*')
      expect(clean(z.string().endsWith('.md'))?.pattern).toBe('.*\\.md$')
      expect(clean(z.string().includes('x'))?.pattern).toBe('x')
    })

    // zod 4 records a format two different ways depending on which spelling was
    // used, and only one of them is a check — a reader that consults a single
    // source silently loses half the formats an app writes.
    test('reads a format declared on the node (z.email())', () => {
      expect(clean(z.email())).toEqual({ type: 'string', format: 'email' })
      expect(clean(z.uuid())).toEqual({ type: 'string', format: 'uuid' })
      expect(clean(z.url())).toEqual({ type: 'string', format: 'uri' })
      expect(clean(z.iso.datetime())).toEqual({ type: 'string', format: 'date-time' })
      expect(clean(z.iso.date())).toEqual({ type: 'string', format: 'date' })
    })

    test('reads a format attached as a check (z.string().email())', () => {
      expect(clean(z.string().email())).toEqual({ type: 'string', format: 'email' })
      expect(clean(z.string().uuid())).toEqual({ type: 'string', format: 'uuid' })
      expect(clean(z.string().url())).toEqual({ type: 'string', format: 'uri' })
      expect(clean(z.string().datetime())).toEqual({ type: 'string', format: 'date-time' })
    })

    test('combines a format with the length bounds beside it', () => {
      expect(clean(z.email().max(254))).toEqual({ type: 'string', format: 'email', maxLength: 254 })
    })

    // A registered format says the same thing in a word; zod's own regex for it
    // runs to hundreds of characters and is its parser, not the contract.
    test('does not emit the internal regex of a registered format', () => {
      expect(clean(z.string().uuid())?.pattern).toBeUndefined()
      expect(clean(z.iso.datetime())?.pattern).toBeUndefined()
    })

    // JSON Schema has one `pattern` keyword, so the second is unrepresentable.
    test('keeps the first pattern when a schema carries two', () => {
      expect(clean(z.string().regex(/^a/).startsWith('b'))?.pattern).toBe('^a')
    })

    // Dropping an unmapped format leaves `type: 'string'`, which is still true.
    test('drops a format JSON Schema has not registered', () => {
      expect(clean(z.cuid())).toEqual({ type: 'string' })
      expect(clean(z.emoji())).toEqual({ type: 'string' })
    })

    // `.trim()` and `.toLowerCase()` are stored as `overwrite` checks — they
    // transform rather than constrain, and have no JSON Schema keyword.
    test('ignores checks that rewrite a value instead of constraining it', () => {
      expect(clean(z.string().trim().toLowerCase())).toEqual({ type: 'string' })
    })
  })

  describe('number constraints', () => {
    test('carries inclusive bounds as minimum and maximum', () => {
      expect(clean(z.number().min(1).max(10))).toEqual({ type: 'number', minimum: 1, maximum: 10 })
    })

    // `.min()` and `.gt()` are one zod check kind separated by `inclusive`;
    // collapsing them onto one keyword would widen or narrow the contract by one.
    test('separates exclusive bounds into their own keywords', () => {
      expect(clean(z.number().gt(1).lt(10))).toEqual({
        type: 'number',
        exclusiveMinimum: 1,
        exclusiveMaximum: 10,
      })
      expect(clean(z.number().positive())).toEqual({ type: 'number', exclusiveMinimum: 0 })
    })

    test('carries multipleOf', () => {
      expect(clean(z.number().multipleOf(0.5))).toEqual({ type: 'number', multipleOf: 0.5 })
    })

    test('keeps the tighter of two bounds of the same kind', () => {
      expect(clean(z.number().min(1).min(4))).toEqual({ type: 'number', minimum: 4 })
    })

    // `z.date().min()` and `z.bigint().min()` reuse the same check kinds with a
    // `Date` / `bigint` bound. Emitting either produces a keyword that is not a
    // JSON number — and a bigint one that `JSON.stringify` throws on outright.
    test('does not emit bounds whose value is not a JSON number', () => {
      expect(clean(z.date().min(new Date('2020-01-01')))).toEqual({ type: 'string', format: 'date-time' })
      expect(clean(z.bigint().min(1n))).toEqual({ type: 'integer' })
      expect(() => JSON.stringify(clean(z.bigint().min(1n)))).not.toThrow()
    })
  })

  describe('array constraints', () => {
    test('carries min and max items alongside the element type', () => {
      expect(clean(z.array(z.string()).min(1).max(3))).toEqual({
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 3,
      })
    })

    test('pins both ends of an exact length', () => {
      expect(clean(z.array(z.number()).length(2))).toEqual({
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
      })
    })
  })

  // Constraints must survive the wrappers a real schema is written with, or
  // they would only ever appear on bare top-level types.
  test('carries constraints through wrappers and into object properties', () => {
    expect(clean(z.string().min(3).optional())).toEqual({ type: 'string', minLength: 3 })
    expect(clean(z.object({ title: z.string().min(1).max(80) }))).toEqual({
      type: 'object',
      properties: { title: { type: 'string', minLength: 1, maxLength: 80 } },
      required: ['title'],
    })
  })
})

describe('readObjectSchema', () => {
  test('reports the properties and the keys a caller must supply', () => {
    const warnings: string[] = []
    const details = readObjectSchema(
      z.object({ page: z.number().min(1), q: z.string().optional() }),
      warnings,
      'query',
      'input',
    )

    expect(warnings).toEqual([])
    expect(details?.properties).toEqual({
      page: { type: 'number', minimum: 1 },
      q: { type: 'string' },
    })
    expect([...(details?.required ?? [])]).toEqual(['page'])
  })

  test('looks through a wrapper around the object', () => {
    const warnings: string[] = []
    const details = readObjectSchema(z.object({ page: z.number() }).optional(), warnings, 'query', 'input')

    expect(warnings).toEqual([])
    expect(Object.keys(details?.properties ?? {})).toEqual(['page'])
  })

  test('warns when the schema is not an object once unwrapped', () => {
    const warnings: string[] = []

    expect(readObjectSchema(z.string(), warnings, 'query', 'input')).toBeUndefined()
    expect(warnings).toEqual(['query: expected an object schema for parameter expansion.'])
  })

  test('returns undefined without warning when there is no schema at all', () => {
    const warnings: string[] = []

    expect(readObjectSchema(undefined, warnings, 'query', 'input')).toBeUndefined()
    expect(warnings).toEqual([])
  })
})

describe('isZodSchema', () => {
  test('accepts a zod node and rejects a look-alike validator', () => {
    expect(isZodSchema(z.string())).toBe(true)
    expect(isZodSchema({ safeParse: () => ({ success: true }) })).toBe(false)
    expect(isZodSchema(null)).toBe(false)
    expect(isZodSchema('string')).toBe(false)
  })
})
