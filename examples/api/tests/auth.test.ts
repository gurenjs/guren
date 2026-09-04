import { describe, expect, it, vi, beforeAll, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
} from '@guren/testing/controller'
import { NodeHasher, type Context } from '@guren/core'

vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    ServiceProvider: actual.ServiceProvider,
    // No hasher override, so the real implementation runs. A hand-rolled fake
    // is the hazard: its argument order can drift from `verify(hashed, plain)`
    // with no type error, which let a swapped call site ship green.
  }
})

const { mockUserCreate, mockUserFirst, mockUserFindOrFail } = vi.hoisted(() => ({
  mockUserCreate: vi.fn(),
  mockUserFirst: vi.fn(),
  mockUserFindOrFail: vi.fn(),
}))
const { mockEmit } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
}))

vi.mock('../app/Models/User.js', () => ({
  User: {
    create: mockUserCreate,
    first: mockUserFirst,
    findOrFail: mockUserFindOrFail,
  },
}))

import AuthController from '../app/Http/Controllers/AuthController.js'

function createController(ctx: Context): AuthController {
  const controller = new AuthController()
  controller.setContext(ctx)
  return controller
}

const hasher = new NodeHasher()

describe('AuthController', () => {
  let passwordHash: string
  let correctPasswordHash: string

  beforeAll(async () => {
    passwordHash = await hasher.hash('password123')
    correctPasswordHash = await hasher.hash('correctpassword')
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('register()', () => {
    it('creates a new user and returns token', async () => {
      const newUser = { id: 1, name: 'Test User', email: 'test@example.com', passwordHash, createdAt: new Date() }
      mockUserFirst.mockResolvedValue(null) // No existing user
      mockUserCreate.mockResolvedValue(newUser)

      const ctx = createControllerContext('http://api.test/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test User',
          email: 'test@example.com',
          password: 'password123',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.register()

      expect(response.status).toBe(201)
      const json = await response.json()
      expect(json.user.email).toBe('test@example.com')
      expect(json.token).toBeDefined()
      expect(json.tokenId).toBeDefined()
    })

    it('throws ValidationException for duplicate email', async () => {
      mockUserFirst.mockResolvedValue({ id: 1, email: 'existing@example.com' })

      const ctx = createControllerContext('http://api.test/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test',
          email: 'existing@example.com',
          password: 'password123',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createController(ctx)

      await expect(controller.register()).rejects.toMatchObject({
        statusCode: 422,
        errors: { email: ['Email already registered'] },
      })
    })

    it('throws validation errors for invalid data', async () => {
      const ctx = createControllerContext('http://api.test/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: '',
          email: 'invalid',
          password: 'short',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createController(ctx)

      await expect(controller.register()).rejects.toMatchObject({
        statusCode: 422,
      })
    })
  })

  describe('login()', () => {
    it('returns token for valid credentials', async () => {
      const user = { id: 1, name: 'Test', email: 'test@example.com', passwordHash, createdAt: new Date() }
      mockUserFirst.mockResolvedValue(user)

      const ctx = createControllerContext('http://api.test/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'password123',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.login()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.token).toBeDefined()
      expect(json.user.email).toBe('test@example.com')
    })

    it('returns 401 for invalid credentials', async () => {
      mockUserFirst.mockResolvedValue(null)

      const ctx = createControllerContext('http://api.test/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'wrong@example.com',
          password: 'wrongpassword',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.login()

      expect(response.status).toBe(401)
      const json = await response.json()
      expect(json.error).toBe('Invalid credentials')
    })

    it('returns 401 for wrong password', async () => {
      const user = { id: 1, name: 'Test', email: 'test@example.com', passwordHash: correctPasswordHash, createdAt: new Date() }
      mockUserFirst.mockResolvedValue(user)

      const ctx = createControllerContext('http://api.test/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'test@example.com',
          password: 'wrongpassword',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.login()

      expect(response.status).toBe(401)
    })
  })

  describe('register() then login()', () => {
    it('accepts the registered password against the stored hash', async () => {
      // `AuthenticatableModel` hashes the plain password on create; `User` is
      // mocked here, so do that step ourselves with the same hasher.
      const created: Record<string, unknown> = {}
      mockUserCreate.mockImplementation(async (data: { name: string; email: string; password: string }) => {
        Object.assign(created, {
          id: 1,
          name: data.name,
          email: data.email,
          passwordHash: await hasher.hash(data.password),
          createdAt: new Date(),
        })
        return created
      })
      mockUserFirst.mockResolvedValueOnce(null) // no existing user at register time

      const registerCtx = createControllerContext('http://api.test/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Round Trip',
          email: 'roundtrip@example.com',
          password: 'password123',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const registerResponse = await createController(registerCtx).register()
      expect(registerResponse.status).toBe(201)

      mockUserFirst.mockResolvedValue(created)

      const loginCtx = createControllerContext('http://api.test/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: 'roundtrip@example.com',
          password: 'password123',
        }),
        headers: { 'Content-Type': 'application/json' },
      }, {
        events: { emit: mockEmit },
      }) as unknown as Context

      const loginResponse = await createController(loginCtx).login()

      expect(loginResponse.status).toBe(200)
      const json = await loginResponse.json()
      expect(json.token).toBeDefined()
      expect(json.user.email).toBe('roundtrip@example.com')
    })
  })

  describe('user()', () => {
    it('throws when unauthenticated', async () => {
      const ctx = createControllerContext('http://api.test/api/auth/user', {
        method: 'GET',
      }) as unknown as Context

      const controller = createController(ctx)

      await expect(controller.user()).rejects.toMatchObject({
        statusCode: 401,
      })
    })

    it('returns user when authenticated', async () => {
      const user = { id: 1, name: 'Test', email: 'test@example.com', createdAt: new Date() }
      mockUserFindOrFail.mockResolvedValue(user)

      const ctx = createControllerContext('http://api.test/api/auth/user', {
        method: 'GET',
      }, {
        'guren:api-token': { userId: 1, abilities: ['*'], token: {} },
        events: { emit: mockEmit },
      }) as unknown as Context

      const controller = createController(ctx)
      const response = await controller.user()

      expect(response.status).toBe(200)
      const json = await response.json()
      expect(json.user.email).toBe('test@example.com')
      expect(json.tokenAbilities).toEqual(['*'])
    })
  })
})
