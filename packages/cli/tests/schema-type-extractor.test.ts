import { describe, expect, it } from 'bun:test'
import { z } from 'zod'
import * as z3 from 'zod/v3'
import { schemaToTypeString } from '../src/schema-type-extractor'

const input = (schema: unknown) => schemaToTypeString(schema, { io: 'input' })
const output = (schema: unknown) => schemaToTypeString(schema, { io: 'output' })

/**
 * `.pipe()` statically requires the target to accept the source's output, but
 * the extractor walks whatever schema object it is handed at runtime — including
 * shapes an app can reach through `z.custom`, a cast, or a Zod version bump.
 */
const pipeTo = (from: unknown, to: unknown) => (from as { pipe(t: unknown): unknown }).pipe(to)

describe('schemaToTypeString', () => {
  it('returns undefined for values that are not schemas', () => {
    expect(output(undefined)).toBeUndefined()
    expect(output({ nope: true })).toBeUndefined()
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
      for (const schema of [z.date(), z.number(), z.boolean(), z.string()]) {
        expect(input(schema)).toBe(output(schema)!)
      }
    })

    // Already JSON-native, so widening them would only cost callers precision —
    // a bare `boolean` is what a checkbox's `checked` needs.
    it('does not widen coerced strings or booleans', () => {
      expect(input(z.coerce.string())).toBe('string')
      expect(input(z.coerce.boolean())).toBe('boolean')
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

    // Distinguishing "the out side is a transform" from "the out side renders
    // as unknown" needs to be structural — a schema that genuinely parses to
    // `unknown` must keep saying so rather than borrow the in side's type.
    it('keeps a genuinely unknown output instead of borrowing the input', () => {
      const schema = pipeTo(z.string(), z.unknown())

      expect(input(schema)).toBe('string')
      expect(output(schema)).toBe('unknown')
    })
  })

  describe('optionality', () => {
    // A default is supplied when the field is missing, so a caller may omit it
    // but the controller always has it.
    it('treats a default as optional only on the way in', () => {
      const schema = z.object({ page: z.coerce.number().default(1) })

      expect(input(schema)).toBe('{ page?: number | string }')
      expect(output(schema)).toBe('{ page: number }')
    })

    // `.catch()` swallows any failure, so nothing is ever required of a caller.
    it('treats a catch as optional on the way in', () => {
      const schema = z.object({ mode: z.string().catch('safe') })

      expect(input(schema)).toBe('{ mode?: string }')
      expect(output(schema)).toBe('{ mode: string }')
    })

    it('reads each side of a pipe for its own optionality', () => {
      const schema = z.object({ value: pipeTo(z.string(), z.string().optional()) })

      expect(input(schema)).toBe('{ value: string }')
      expect(output(schema)).toBe('{ value?: string }')
    })
  })

  // Apps pin their own Zod, so both majors have to be walked. v3 names things
  // differently in ways that are easy to miss — `ZodPipeline` normalizes to
  // `pipeline`, not `pipe`, and an array's element lives in `_def.type`.
  describe('zod 3', () => {
    it('renders both sides of a pipeline', () => {
      const schema = z3.string().pipe(z3.number())

      expect(input(schema)).toBe('string')
      expect(output(schema)).toBe('number')
    })

    it('renders arrays, coercion and optionality', () => {
      const schema = z3.object({
        tags: z3.array(z3.string()),
        publishedAt: z3.coerce.date(),
        page: z3.coerce.number().default(1),
      })

      expect(input(schema)).toBe('{ tags: string[]; publishedAt: string; page?: number | string }')
      expect(output(schema)).toBe('{ tags: string[]; publishedAt: Date; page: number }')
    })
  })
})
