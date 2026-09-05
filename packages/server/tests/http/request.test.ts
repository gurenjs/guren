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

  // This is the record *view*: callers reading the body field by field have
  // nothing to read on an array. Schemas judge parseRequestBody's shape instead.
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
 * `parseRequestUploads` backs `Controller.file()` / `files()` and `@guren/testing`'s
 * controller mock; driven through a real `HonoRequest`, since both properties under
 * test live inside Hono's `parseBody()`. Measured: Bun 1.3.14 rejects
 * `MULTIPART/FORM-DATA` out of `formData()` (case-sensitive where Hono lowercases
 * first), Bun 1.4.0 and Node accept it; the contract is the file answered either way.
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

  // `{ all: true }` is the contract — `parseRequestUploads` says why. Named here
  // rather than only as an effect, so the reason survives a rewrite of
  // `@guren/testing`'s upload table.
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

  // No media-type gate, deliberately: Hono lowercases before deciding, so gating
  // outside `parseBody()` (or reading uploads through the runtime-dependent
  // `Request.formData()`) is what loses the file. Adding such a gate turns this red
  // on every runtime, which is the mutation the test exists for.
  it('reads an uppercase multipart media type, whatever the host formData() makes of it', async () => {
    const uploads = await parseRequestUploads({
      req: uploadRequest(
        `MULTIPART/FORM-DATA; boundary=${BOUNDARY}`,
        uploadBody([['doc', 'a.txt', 'a']]),
      ),
    })

    expect(names(uploads.doc)).toEqual(['a.txt'])
  })

  // A body the parser cannot decode carries no files rather than crashing the
  // request — the same answer `file()` gives for an absent field.
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
 * The flattener is handed attacker-controlled keys, so it must define fields rather
 * than assign them: Hono's null-prototype grouping has no `__proto__` setter to hit,
 * but assigning into an object literal loses the key. Built through a real
 * `HonoRequest` so the null-prototype input comes from Hono itself.
 */
describe('flattenRequestQueries', () => {
  const flattenFor = (query: string) =>
    flattenRequestQueries({ req: new HonoRequest(new Request(`http://example.com/posts${query}`)) })

  it('keeps a repeated key as an array and a single occurrence as a string', () => {
    expect(flattenFor('?tag=a&tag=b&page=2')).toEqual({ tag: ['a', 'b'], page: '2' })
  })

  it('defines a single `__proto__` as an own field instead of dropping it', () => {
    const flat = flattenFor('?__proto__=one')

    // Assigned rather than defined, setting `__proto__` to a string is a no-op,
    // so the field never reaches the schema.
    expect(Object.hasOwn(flat, '__proto__')).toBe(true)
    expect(flat).toEqual(Object.fromEntries([['__proto__', 'one']]))
    expect(Object.getPrototypeOf(flat)).toBe(Object.prototype)
  })

  it('defines a repeated `__proto__` as an own field instead of replacing the prototype', () => {
    const flat = flattenFor('?__proto__=one&__proto__=two')

    // Worse: assigning an *array* to `__proto__` replaces the record's prototype
    // instead of no-opping, and the field is still missing.
    expect(Object.hasOwn(flat, '__proto__')).toBe(true)
    expect(flat).toEqual(Object.fromEntries([['__proto__', ['one', 'two']]]))
    expect(Object.getPrototypeOf(flat)).toBe(Object.prototype)
  })
})
