import { describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import {
  getValidatedData,
  validate,
  validateRequest,
  validateRequestWith,
  validateSafe,
  type ValidationSchema,
} from '../../../src/http/middleware/validation'

// Simple mock schema that mimics Zod's interface
function createSchema<T>(validator: (data: unknown) => T | null, errorMessage = 'Invalid data'): ValidationSchema<T> {
  return {
    parse(data: unknown): T {
      const result = validator(data)
      if (result === null) {
        throw { issues: [{ path: ['field'], message: errorMessage }] }
      }
      return result
    },
    safeParse(data: unknown) {
      const result = validator(data)
      if (result === null) {
        return {
          success: false as const,
          error: { issues: [{ path: ['field'], message: errorMessage }] },
        }
      }
      return { success: true as const, data: result }
    },
  }
}

// User schema mock
const userSchema = createSchema<{ name: string; email: string }>((data) => {
  if (
    typeof data === 'object' &&
    data !== null &&
    'name' in data &&
    'email' in data &&
    typeof (data as Record<string, unknown>).name === 'string' &&
    typeof (data as Record<string, unknown>).email === 'string' &&
    (data as Record<string, unknown>).name !== '' &&
    (data as { email: string }).email.includes('@')
  ) {
    return { name: (data as { name: string }).name, email: (data as { email: string }).email }
  }
  return null
}, 'Invalid user data')

describe('validateRequest', () => {
  it('allows valid requests to proceed', async () => {
    const app = new Hono()

    app.post('/users', validateRequest(userSchema), (c) => {
      const data = getValidatedData<{ name: string; email: string }>(c)
      return c.json({ user: data })
    })

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice', email: 'alice@example.com' }),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ user: { name: 'Alice', email: 'alice@example.com' } })
  })

  it('returns 422 for invalid requests', async () => {
    const app = new Hono()

    app.post('/users', validateRequest(userSchema), (c) => {
      return c.json({ user: getValidatedData(c) })
    })

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '', email: 'invalid' }),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.errors).toBeDefined()
  })

  it('uses custom status code when provided', async () => {
    const app = new Hono()

    app.post('/users', validateRequest(userSchema, { status: 400 }), (c) => {
      return c.json({ user: getValidatedData(c) })
    })

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    })

    expect(res.status).toBe(400)
  })

  it('uses custom error handler when provided', async () => {
    const app = new Hono()

    app.post(
      '/users',
      validateRequest(userSchema, {
        onError: (ctx, errors) =>
          new Response(JSON.stringify({ message: 'Custom error', details: errors }), {
            status: 422,
            headers: { 'X-Custom-Error': 'true' },
          }),
      }),
      (c) => c.json({ user: getValidatedData(c) }),
    )

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invalid: true }),
    })

    expect(res.status).toBe(422)
    expect(res.headers.get('X-Custom-Error')).toBe('true')
    const body = await res.json()
    expect(body.message).toBe('Custom error')
  })

  it('validates form submissions', async () => {
    const app = new Hono()

    app.post('/users', validateRequest(userSchema), (c) => {
      const data = getValidatedData<{ name: string; email: string }>(c)
      return c.json({ user: data })
    })

    const formData = new URLSearchParams()
    formData.set('name', 'Bob')
    formData.set('email', 'bob@example.com')

    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.name).toBe('Bob')
  })
})

describe('validateRequestWith', () => {
  it('creates schema based on request context', async () => {
    const app = new Hono()

    const strictSchema = createSchema<{ name: string }>((data) => {
      if (
        typeof data === 'object' &&
        data !== null &&
        'name' in data &&
        typeof (data as { name: string }).name === 'string' &&
        (data as { name: string }).name.length >= 5
      ) {
        return { name: (data as { name: string }).name }
      }
      return null
    }, 'Name must be at least 5 characters')

    const looseSchema = createSchema<{ name: string }>((data) => {
      if (typeof data === 'object' && data !== null && 'name' in data) {
        return { name: String((data as { name: string }).name) }
      }
      return null
    })

    app.post(
      '/users/:mode',
      validateRequestWith((ctx) => {
        const mode = ctx.req.param('mode')
        return mode === 'strict' ? strictSchema : looseSchema
      }),
      (c) => c.json({ data: getValidatedData(c) }),
    )

    // Strict mode - short name rejected
    const strictRes = await app.request('/users/strict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Al' }),
    })
    expect(strictRes.status).toBe(422)

    // Loose mode - short name accepted
    const looseRes = await app.request('/users/loose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Al' }),
    })
    expect(looseRes.status).toBe(200)
  })
})

describe('getValidatedData', () => {
  it('returns undefined when validation middleware not used', async () => {
    const app = new Hono()
    let data: unknown

    app.get('/test', (c) => {
      data = getValidatedData(c)
      return c.text('ok')
    })

    await app.request('/test')

    expect(data).toBeUndefined()
  })

  it('returns validated data with correct type', async () => {
    const app = new Hono()
    let data: { name: string; email: string } | undefined

    app.post('/users', validateRequest(userSchema), (c) => {
      data = getValidatedData<{ name: string; email: string }>(c)
      return c.text('ok')
    })

    await app.request('/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Test', email: 'test@example.com' }),
    })

    expect(data).toEqual({ name: 'Test', email: 'test@example.com' })
  })
})

describe('validate', () => {
  it('returns parsed data for valid input', () => {
    const result = validate(userSchema, { name: 'Alice', email: 'alice@example.com' })
    expect(result).toEqual({ name: 'Alice', email: 'alice@example.com' })
  })

  it('throws for invalid input', () => {
    expect(() => validate(userSchema, { name: '', email: 'invalid' })).toThrow()
  })
})

describe('validateSafe', () => {
  it('returns success with data for valid input', () => {
    const result = validateSafe(userSchema, { name: 'Alice', email: 'alice@example.com' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ name: 'Alice', email: 'alice@example.com' })
    }
  })

  it('returns failure with errors for invalid input', () => {
    const result = validateSafe(userSchema, { name: '', email: 'invalid' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.errors).toBeDefined()
    }
  })
})
