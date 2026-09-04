import { describe, expect, it, spyOn } from 'bun:test'
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

    // Coerced strings and booleans are already JSON-native; a bare `boolean` is
    // what a checkbox's `checked` needs.
    it('renders schemas with no wire/parsed gap identically on both sides', () => {
      for (const [schema, type] of [
        [z.date(), 'Date'], [z.number(), 'number'], [z.boolean(), 'boolean'], [z.string(), 'string'],
        [z.coerce.string(), 'string'], [z.coerce.boolean(), 'boolean'],
      ] as const) {
        expect(input(schema)).toBe(type)
        expect(output(schema)).toBe(type)
      }
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

    // Structural: a schema that genuinely parses to `unknown` must keep saying
    // so rather than borrow the in side's type.
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

    it('treats prefault like default, and nonoptional as required', () => {
      expect(input(z.object({ a: z.string().prefault('p') }))).toBe('{ a?: string }')
      expect(output(z.object({ a: z.string().prefault('p') }))).toBe('{ a: string }')
      expect(input(z.object({ a: z.string().optional().nonoptional() }))).toBe('{ a: string }')
    })

    // `zodToType` and `isOptional` walk separately, so a wrapper added to one
    // unwrap list and not the other silently makes an optional field required.
    it('looks through the same wrappers when deciding presence as when reading the type', () => {
      for (const schema of [
        z.object({ a: z.string().optional().readonly() }),
        z.object({ a: z.string().optional().catch('x') }),
        z.object({ a: z.string().optional().brand<'Tagged'>() }),
      ]) {
        expect(input(schema)).toBe('{ a?: string }')
        expect(output(schema)).toBe('{ a?: string }')
      }
    })

    // The type comes from the in side for a transform; presence has to agree,
    // or one field is described by two different nodes.
    it('agrees with the rendered type when a pipe output is a transform', () => {
      const schema = z.object({ a: z.string().optional().transform((s) => s?.length) })

      expect(input(schema)).toBe('{ a?: string }')
      expect(output(schema)).toBe('{ a?: string }')
    })
  })

  // The zod 3 API is refused, not mis-rendered: on a v3 node `_def.type` holds a
  // nested schema where v4 keeps the type name. `zod/v3` ships inside zod 4, so
  // this arrives from apps that declare only zod 4.
  describe('zod 3 refusal', () => {
    // One test, deliberately: the warning fires once per process, so split tests
    // would be coupled by execution order. The nested case runs first because it
    // is the one that regressed silently.
    it('refuses v3 at entry and nested, warning once per process', () => {
      const warn = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const rendered = input(z.object({ legacy: z3.string() as never, ok: z.number() }))
        expect(rendered).toBe('{ legacy: unknown; ok: number }')
        expect(warn).toHaveBeenCalledTimes(1)
        expect(warn.mock.calls[0]?.[0]).toContain('zod v3 API')

        expect(input(z3.string().pipe(z3.number()))).toBeUndefined()
        expect(output(z3.object({ tags: z3.array(z3.string()) }))).toBeUndefined()
        expect(input(z3.coerce.number().default(1))).toBeUndefined()
        expect(warn).toHaveBeenCalledTimes(1)
      } finally {
        warn.mockRestore()
      }
    })
  })
})

describe('degenerate schemas', () => {
  // An enum with no members accepts nothing. This used to render as an empty
  // string, which is not valid TypeScript wherever the result is spliced in.
  it('renders an empty enum as never', () => {
    expect(schemaToTypeString(z.enum([]), { io: 'output' })).toBe('never')
  })

  // `JSON.stringify(undefined)` returns undefined rather than a string, so
  // rendering literal values through it alone dropped this to an empty string.
  it('renders a literal undefined as the undefined type', () => {
    expect(schemaToTypeString(z.literal(undefined), { io: 'output' })).toBe('undefined')
  })

  it('renders a record value type', () => {
    expect(schemaToTypeString(z.record(z.string(), z.number()), { io: 'output' }))
      .toBe('Record<string, number>')
  })
})
