import { describe, test, expect, beforeEach } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { Controller } from '../../src/mvc/Controller'

const BodySchema = z.object({
  email: z.email(),
  name: z.string().min(1),
})

const QuerySchema = z.object({
  page: z.coerce.number().int().positive(),
  sort: z.enum(['asc', 'desc']).optional(),
})

const ParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
})

class TestController extends Controller {
  async bodySafe() {
    const result = await this.validateBodySafe(BodySchema)
    return this.json(result)
  }

  querySafe() {
    const result = this.validateQuerySafe(QuerySchema)
    return this.json(result)
  }

  paramsSafe() {
    const result = this.validateParamsSafe(ParamsSchema)
    return this.json(result)
  }

  async exceptRole() {
    const result = await this.except('role')
    return this.json({
      keys: Object.keys(result),
      ownProto: Object.hasOwn(result, '__proto__'),
      hasRole: 'role' in result,
      hasEmail: 'email' in result,
      plainPrototype: Object.getPrototypeOf(result) === Object.prototype,
      assignedRole: Object.assign({}, result).role ?? null,
    })
  }
}

function createApp() {
  const app = new Hono()

  app.post('/body-safe', async (c) => {
    const ctrl = new TestController()
    ctrl.setContext(c)
    return ctrl.bodySafe()
  })

  app.get('/query-safe', async (c) => {
    const ctrl = new TestController()
    ctrl.setContext(c)
    return ctrl.querySafe()
  })

  app.get('/params-safe/:id', async (c) => {
    const ctrl = new TestController()
    ctrl.setContext(c)
    return ctrl.paramsSafe()
  })

  app.post('/except-role', async (c) => {
    const ctrl = new TestController()
    ctrl.setContext(c)
    return ctrl.exceptRole()
  })

  return app
}

describe('Controller Safe Validation', () => {
  let app: Hono

  beforeEach(() => {
    app = createApp()
  })

  describe('validateBodySafe', () => {
    test('returns success with parsed data on valid input', async () => {
      const res = await app.request('/body-safe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'test@example.com', name: 'Test' }),
      })

      expect(res.status).toBe(200)
      const json = await res.json()
      expect(json).toEqual({
        success: true,
        data: { email: 'test@example.com', name: 'Test' },
      })
    })

    test('returns failure with flattened errors on invalid input', async () => {
      const res = await app.request('/body-safe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'not-an-email', name: '' }),
      })

      expect(res.status).toBe(200) // the safe variant does not throw
      const json = await res.json()
      expect(json.success).toBe(false)
      expect(json.errors).toBeDefined()
      expect(typeof json.errors.email).toBe('string')
      expect(typeof json.errors.name).toBe('string')
    })

    test('returns failure when body is empty', async () => {
      const res = await app.request('/body-safe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })

      const json = await res.json()
      expect(json.success).toBe(false)
      expect(Object.keys(json.errors).length).toBeGreaterThan(0)
    })
  })

  describe('validateQuerySafe', () => {
    test('returns success with parsed data on valid query', async () => {
      const res = await app.request('/query-safe?page=2&sort=desc')

      const json = await res.json()
      expect(json).toEqual({
        success: true,
        data: { page: 2, sort: 'desc' },
      })
    })

    test('returns failure with errors on invalid query', async () => {
      const res = await app.request('/query-safe?page=-1&sort=invalid')

      const json = await res.json()
      expect(json.success).toBe(false)
      expect(json.errors).toBeDefined()
    })

    test('returns success with optional field omitted', async () => {
      const res = await app.request('/query-safe?page=1')

      const json = await res.json()
      expect(json).toEqual({
        success: true,
        data: { page: 1 },
      })
    })
  })

  describe('validateParamsSafe', () => {
    test('returns success with parsed params', async () => {
      const res = await app.request('/params-safe/42')

      const json = await res.json()
      expect(json).toEqual({
        success: true,
        data: { id: 42 },
      })
    })

    test('returns failure with invalid params', async () => {
      const res = await app.request('/params-safe/abc')

      const json = await res.json()
      expect(json.success).toBe(false)
      expect(json.errors).toBeDefined()
    })
  })

  describe('except', () => {
    // Raw strings: `JSON.stringify({ __proto__: … })` would set the literal's
    // prototype and never send the key.
    async function exceptRole(body: string) {
      const res = await app.request('/except-role', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
      expect(res.status).toBe(200)
      return res.json()
    }

    test('removes the excluded keys and keeps the rest', async () => {
      const json = await exceptRole('{"name":"x","email":"e@example.com","role":"admin"}')

      expect(json).toEqual({
        keys: ['name', 'email'],
        ownProto: false,
        hasRole: false,
        hasEmail: true,
        plainPrototype: true,
        assignedRole: null,
      })
    })

    test('keeps an excluded key out when it is nested under __proto__', async () => {
      const json = await exceptRole('{"name":"x","__proto__":{"role":"admin"}}')

      expect(json).toEqual({
        keys: ['name'],
        ownProto: false,
        hasRole: false,
        hasEmail: false,
        plainPrototype: true,
        assignedRole: null,
      })
    })

    test('does not expose another key nested under __proto__', async () => {
      const json = await exceptRole('{"name":"x","__proto__":{"email":"e@example.com"}}')

      expect(json.keys).toEqual(['name'])
      expect(json.hasEmail).toBe(false)
      expect(json.plainPrototype).toBe(true)
    })

    test('drops a harmless __proto__ key without failing', async () => {
      const json = await exceptRole('{"name":"x","__proto__":{}}')

      expect(json.keys).toEqual(['name'])
      expect(json.ownProto).toBe(false)
      expect(json.plainPrototype).toBe(true)
    })
  })
})
