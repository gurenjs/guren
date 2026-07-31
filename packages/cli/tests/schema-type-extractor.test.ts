import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import { schemaToTypeString } from '../src/schema-type-extractor'

const input = (schema: unknown) => schemaToTypeString(schema, { io: 'input' })
const output = (schema: unknown) => schemaToTypeString(schema, { io: 'output' })

describe('schemaToTypeString', () => {
  it('defaults to the parsed (output) type', () => {
    expect(schemaToTypeString(z.coerce.date())).toBe('Date')
    expect(schemaToTypeString(z.coerce.number())).toBe('number')
  })

  it('returns undefined for values that are not schemas', () => {
    expect(schemaToTypeString(undefined)).toBeUndefined()
    expect(schemaToTypeString({ nope: true })).toBeUndefined()
  })

  describe('coercion', () => {
    // A coerced date parses to a `Date`, but JSON has no date type — the only
    // thing a client can actually put on the wire is an ISO string.
    it('renders a coerced date as the string that travels, not the Date', () => {
      expect(input(z.coerce.date())).toBe('string')
      expect(output(z.coerce.date())).toBe('Date')
    })

    it('lets a coerced number arrive as a string', () => {
      expect(input(z.coerce.number())).toBe('number | string')
      expect(output(z.coerce.number())).toBe('number')
    })

    it('leaves non-coercing schemas identical on both sides', () => {
      expect(input(z.date())).toBe('Date')
      expect(input(z.number())).toBe('number')
      expect(input(z.boolean())).toBe('boolean')
    })

    it('applies through wrappers and into object fields', () => {
      const schema = z.object({
        title: z.string(),
        publishedAt: z.coerce.date(),
        archivedAt: z.coerce.date().nullable().optional(),
        tags: z.array(z.coerce.number()),
      })

      expect(input(schema)).toBe(
        '{ title: string; publishedAt: string; archivedAt?: string | null; tags: (number | string)[] }',
      )
      expect(output(schema)).toBe(
        '{ title: string; publishedAt: Date; archivedAt?: Date | null; tags: number[] }',
      )
    })
  })

  describe('pipes', () => {
    it('reports each side of a pipe to the caller that needs it', () => {
      const schema = z.string().pipe(z.coerce.number())

      expect(input(schema)).toBe('string')
      expect(output(schema)).toBe('number')
    })

    // `.transform()` is a pipe whose out side is an opaque function, so there
    // is no parsed type to recover — the in side stays the best available.
    it('falls back to the in side for a transform', () => {
      const schema = z.object({ title: z.string() }).transform((v) => v.title)

      expect(input(schema)).toBe('{ title: string }')
      expect(output(schema)).toBe('{ title: string }')
    })
  })
})
