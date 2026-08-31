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
 * This suite runs on Bun (`bun run test:bun`), which is where the uppercase
 * case below was worth writing: `Request.formData()`'s handling of the media
 * type has differed by runtime and by Bun version, and the point of
 * `parseRequestUploads` is that none of that reaches `file()` / `files()`.
 *
 * Measured, because the numbers moved under this test once already: Bun 1.3.14
 * rejects `MULTIPART/FORM-DATA` out of `formData()` (case-sensitive where Hono
 * lowercases first), while **Bun 1.4.0 accepts it** — the same CI run, same
 * Linux runner, 1.3.14 green and 1.4.0 red on a hard assertion that the host
 * refuses. Node has always accepted it. So the host's behavior is recorded
 * here rather than required; what is required is that this function answers
 * with the file either way, which is the assertion the media-type-gate
 * mutation still turns red.
 */
describe('parseRequestUploads', () => {
  const BOUNDARY = 'guren-uploads-boundary'

  function uploadBody(files: Array<[field: string, filename: string, content: string]>): string {
    return (
      files
        .map(
          ([field, filename, content]) =>
            `--${BOUNDARY}\r\n` +
            `Content-Disposition: form-data; name="${field}"; filename="${filename}"\r\n` +
            'Content-Type: text/plain\r\n\r\n' +
            `${content}\r\n`,
        )
        .join('') + `--${BOUNDARY}--\r\n`
    )
  }

  function uploadInit(contentType: string, body: string): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': contentType }, body }
  }

  function uploadRequest(contentType: string, body: string): HonoRequest {
    return new HonoRequest(new Request('http://example.com/uploads', uploadInit(contentType, body)))
  }

  const names = (value: unknown): string[] =>
    (Array.isArray(value) ? value : value === undefined ? [] : [value])
      .filter((item): item is File => item instanceof File)
      .map((file) => file.name)

  // `{ all: true }` is the contract — `parseRequestUploads` says why.
  // `@guren/testing`'s upload table catches this mutation too; what this one
  // adds is naming the flag rather than an effect of it, so the reason survives
  // a rewrite of that table.
  it('keeps every part of a repeated field, which files() depends on', async () => {
    const uploads = await parseRequestUploads({
      req: uploadRequest(
        `multipart/form-data; boundary=${BOUNDARY}`,
        uploadBody([
          ['doc', 'a.txt', 'a'],
          ['doc', 'b.txt', 'b'],
        ]),
      ),
    })

    expect(names(uploads.doc)).toEqual(['a.txt', 'b.txt'])
  })

  // No media-type gate, deliberately: Hono lowercases before deciding. Gating
  // outside `parseBody()` — or reading uploads through `Request.formData()`,
  // whose answer for this header is runtime- and version-dependent per the
  // note above — is what loses the file.
  //
  // Not vacuous without a premise assertion about the host: adding a gate on
  // the raw media type makes this red on every runtime, including the ones
  // whose `formData()` would have accepted the body anyway. That mutation is
  // what this test is for; the host's own answer is context, not a contract.
  it('reads an uppercase multipart media type, whatever the host formData() makes of it', async () => {
    const uploads = await parseRequestUploads({
      req: uploadRequest(
        `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`,
        uploadBody([['doc', 'a.txt', 'a']]),
      ),
    })

    expect(names(uploads.doc)).toEqual(['a.txt'])
  })

  // Guarded so a body the parser cannot decode carries no files rather than
  // crashing the request — the same answer `file()` already gives for an
  // absent field.
  it('falls back to an empty record when the body cannot be decoded', async () => {
    const req = uploadRequest('multipart/form-data', 'not a multipart body')

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
