import { describe, expect, it } from 'bun:test'
import { HonoRequest } from 'hono/request'
import {
  flattenRequestQueries,
  formatValidationErrors,
  parseRequestBody,
  parseRequestPayload,
  parseRequestUploads,
} from '../../src/http/request'

interface TestContext {
  req: {
    header: (name: string) => string | undefined
    json: () => Promise<unknown>
    parseBody?: () => Promise<Record<string, unknown>>
  }
}

function createContext(options: {
  headers?: Record<string, string>
  json?: () => Promise<unknown>
  parseBody?: () => Promise<Record<string, unknown>>
}): TestContext {
  const headers = Object.entries(options.headers ?? {}).reduce<Record<string, string>>((acc, [key, value]) => {
    acc[key.toLowerCase()] = value
    return acc
  }, {})

  const header = (name: string) => headers[name.toLowerCase()]

  return {
    req: {
      header,
      json: options.json ?? (async () => ({})),
      ...(options.parseBody ? { parseBody: options.parseBody } : {}),
    },
  }
}

describe('parseRequestPayload', () => {
  it('parses JSON bodies into plain objects', async () => {
    const ctx = createContext({
      headers: { 'content-type': 'application/json' },
      json: async () => ({ name: 'Asuka', nested: { ignored: true } }),
    })

    const payload = await parseRequestPayload(ctx as unknown as any)
    expect(payload).toEqual({ name: 'Asuka', nested: { ignored: true } })
  })

  // Deliberate: this is the record *view*. Callers that read the body field by
  // field have nothing to read on an array, so it reads as `{}` — the shape a
  // schema should judge comes from parseRequestBody below.
  it('returns an empty object when JSON parsing fails or yields non-objects', async () => {
    const ctx = createContext({
      headers: { 'content-type': 'application/json' },
      json: async () => {
        throw new Error('boom')
      },
    })

    const emptyPayload = await parseRequestPayload(ctx as unknown as any)
    expect(emptyPayload).toEqual({})

    const ctxWithArray = createContext({
      headers: { 'content-type': 'application/json' },
      json: async () => ['not', 'an', 'object'],
    })

    const arrayPayload = await parseRequestPayload(ctxWithArray as unknown as any)
    expect(arrayPayload).toEqual({})
  })

  it('normalizes form submissions via parseBody', async () => {
    const ctx = createContext({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      parseBody: async () => ({
        email: 'user@example.com',
        tags: ['core', 'framework'],
        remember: '1',
      }),
    })

    const formPayload = await parseRequestPayload(ctx as unknown as any)
    expect(formPayload).toEqual({
      email: 'user@example.com',
      tags: 'core',
      remember: '1',
    })
  })

  it('falls back to an empty object when no parser is available', async () => {
    const ctx = createContext({ headers: {} })
    const payload = await parseRequestPayload(ctx as unknown as any)
    expect(payload).toEqual({})
  })
})

describe('parseRequestBody', () => {
  it('returns JSON arrays, strings and null unnarrowed', async () => {
    const cases: unknown[] = [['a', 'b'], 'hello', 42, false, null]

    for (const value of cases) {
      const ctx = createContext({
        headers: { 'content-type': 'application/json' },
        json: async () => value,
      })

      expect(await parseRequestBody(ctx as unknown as any)).toEqual(value as any)
    }
  })

  it('returns objects unchanged, as parseRequestPayload does', async () => {
    const ctx = createContext({
      headers: { 'content-type': 'application/json' },
      json: async () => ({ name: 'Asuka' }),
    })

    expect(await parseRequestBody(ctx as unknown as any)).toEqual({ name: 'Asuka' })
  })

  // Load bearing: an all-optional object schema has to keep passing on an
  // empty or malformed body, which `undefined` would break.
  it('falls back to an empty object when JSON parsing fails', async () => {
    const ctx = createContext({
      headers: { 'content-type': 'application/json' },
      json: async () => {
        throw new Error('boom')
      },
    })

    expect(await parseRequestBody(ctx as unknown as any)).toEqual({})
  })

  it('normalizes form submissions the same way parseRequestPayload does', async () => {
    const ctx = createContext({
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      parseBody: async () => ({ email: 'user@example.com', tags: ['core', 'framework'] }),
    })

    expect(await parseRequestBody(ctx as unknown as any)).toEqual({
      email: 'user@example.com',
      tags: 'core',
    })
  })

  it('falls back to an empty object when no parser is available', async () => {
    const ctx = createContext({ headers: {} })
    expect(await parseRequestBody(ctx as unknown as any)).toEqual({})
  })
})

/**
 * `parseRequestUploads` is what `Controller.file()` / `files()` read, and what
 * `@guren/testing`'s controller mock reads so the two cannot disagree.
 *
 * These drive a real `HonoRequest` rather than the stub context above, because
 * both properties under test live *inside* Hono's `parseBody()` — a stub would
 * only re-assert its own return value.
 *
 * This suite runs on Bun (`bun run test:bun`), which is the point of it living
 * here. The uppercase case below is the divergence the shared read closed, and
 * Bun is the only runtime that can see it: `Request.formData()` is
 * case-sensitive here and case-insensitive on Node, so the same assertion in
 * `@guren/testing`'s vitest suite passes against an implementation that reads
 * uploads through `formData()` and one that does not. Measured both ways.
 */
describe('parseRequestUploads', () => {
  const BOUNDARY = 'guren-uploads-boundary'

  function uploadRequest(contentType: string, files: Array<[string, string, string]>): HonoRequest {
    const body =
      files
        .map(
          ([field, filename, content]) =>
            `--${BOUNDARY}\r\n` +
            `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
            'Content-Type: text/plain\r\n\r\n' +
            `${content}\r\n`,
        )
        .join('') + `--${BOUNDARY}--\r\n`

    return new HonoRequest(
      new Request('http://example.com/uploads', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body,
      }),
    )
  }

  const names = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value === undefined ? [] : [value])
      .filter((item): item is File => item instanceof File)
      .map((file) => file.name)

  // `{ all: true }` is the contract, and this is the only assertion that can
  // lose it: without it Hono keeps one value per repeated field and `files()`
  // silently reduces to a single file per `<input multiple>`.
  it('keeps every part of a repeated field, which files() depends on', async () => {
    const uploads = await parseRequestUploads({
      req: uploadRequest(`multipart/form-data; boundary=${BOUNDARY}`, [
        ['doc', 'a.txt', 'a'],
        ['doc', 'b.txt', 'b'],
      ]),
    })

    expect(names(uploads.doc)).toEqual(['a.txt', 'b.txt'])
  })

  // No media-type gate, deliberately: Hono lowercases before deciding. Gating
  // outside `parseBody()` — or reading uploads through `Request.formData()`,
  // which on Bun refuses this exact header — loses the file entirely.
  it('reads an uppercase multipart media type, which Request.formData() refuses on Bun', async () => {
    const init = {
      method: 'POST',
      headers: { 'Content-Type': `MULTIPART/FORM-DATA; boundary=${BOUNDARY}` },
      body:
        `--${BOUNDARY}\r\n` +
        'Content-Disposition: form-data; name="doc"; filename="a.txt"\r\n' +
        'Content-Type: text/plain\r\n\r\n' +
        'a\r\n' +
        `--${BOUNDARY}--\r\n`,
    }

    // Pins the premise, so this test cannot quietly become vacuous on a runtime
    // whose formData() stops refusing: the assertion below is only interesting
    // while the two answers differ.
    await expect(new Request('http://example.com/uploads', init).formData()).rejects.toThrow()

    const uploads = await parseRequestUploads({ req: new HonoRequest(new Request('http://example.com/uploads', init)) })

    expect(names(uploads.doc)).toEqual(['a.txt'])
  })

  // Guarded so a body the parser cannot decode carries no files rather than
  // crashing the request — the same answer `file()` already gives for an
  // absent field.
  it('falls back to an empty record when the body cannot be decoded', async () => {
    const req = new HonoRequest(
      new Request('http://example.com/uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data' },
        body: 'not a multipart body',
      }),
    )

    expect(await parseRequestUploads({ req })).toEqual({})
  })
})

describe('formatValidationErrors', () => {
  it('maps the first issue per field into a flat record', () => {
    const errors = formatValidationErrors({
      issues: [
        { path: ['email'], message: 'Email is required' },
        { path: ['email'], message: 'Email must be unique' },
        { path: ['password'], message: 'Password is too short' },
      ],
    })

    expect(errors).toEqual({
      email: 'Email is required',
      password: 'Password is too short',
    })
  })

  it('falls back to the provided message when no field errors are present', () => {
    const errors = formatValidationErrors({ issues: [{ path: [0], message: 'Invalid' }] }, 'Try again')

    expect(errors).toEqual({ message: 'Try again' })
  })
})

/**
 * The flattener is handed attacker-controlled keys, so it must define fields
 * rather than assign them. Hono groups into a null-prototype object, which has
 * no inherited `__proto__` setter to hit; the flattening step is the one place
 * the key can still be lost, and assigning into an object literal lost it two
 * different ways depending on how many times the key was repeated.
 *
 * Built through a real `HonoRequest` rather than a hand-written `queries()`, so
 * the null-prototype input this relies on comes from Hono itself.
 */
describe('flattenRequestQueries', () => {
  const flattenFor = (query: string) =>
    flattenRequestQueries({ req: new HonoRequest(new Request(`http://example.com/posts${query}`)) })

  it('keeps a repeated key as an array and a single occurrence as a string', () => {
    expect(flattenFor('?tag=a&tag=b&page=2')).toEqual({ tag: ['a', 'b'], page: '2' })
  })

  it('defines a single `__proto__` as an own field instead of dropping it', () => {
    const flat = flattenFor('?__proto__=one')

    // Assigned rather than defined, this silently became a no-op: setting
    // `__proto__` to a string does nothing, so the field never reached the
    // schema at all.
    expect(Object.hasOwn(flat, '__proto__')).toBe(true)
    expect(flat).toEqual(Object.fromEntries([['__proto__', 'one']]))
    expect(Object.getPrototypeOf(flat)).toBe(Object.prototype)
  })

  it('defines a repeated `__proto__` as an own field instead of replacing the prototype', () => {
    const flat = flattenFor('?__proto__=one&__proto__=two')

    // The worse half of the same bug: assigning an *array* to `__proto__` does
    // not no-op, it replaces the record's prototype — so the object handed to
    // the schema had `Array.prototype`-shaped inheritance and still no field.
    expect(Object.hasOwn(flat, '__proto__')).toBe(true)
    expect(flat).toEqual(Object.fromEntries([['__proto__', ['one', 'two']]]))
    expect(Object.getPrototypeOf(flat)).toBe(Object.prototype)
  })
})
