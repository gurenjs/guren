import { describe, expect, it } from 'bun:test'
import { formatValidationErrors, parseRequestBody, parseRequestPayload } from '../../src/http/request'

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
