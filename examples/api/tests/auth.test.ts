import { beforeAll, describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
} from '@guren/testing/controller'
import { type Context, Hash } from '@guren/core'

// Mock dependencies
vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    ServiceProvider: actual.ServiceProvider,
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

// Hashes produced by the hasher the controller actually verifies with, rather
// than by a hand-written double. A double is a copy of a contract no type
// constrains: the one this file used to carry defined `verify(password, hash)`,
// the inverse of `PasswordHasher.verify(hashed, plain)`, and so agreed with a
// login that was broken in production and kept this suite green.
let passwordHash: string
let otherPasswordHash: string

beforeAll(async () => {
  const hasher = new Hash()
  passwordHash = await hasher.hash('password123')
  otherPasswordHash = await hasher.hash('correctpassword')
})

function createController(ctx: Context): AuthController {
  const controller = new AuthController()
  controller.setContext(ctx)
  return controller
}

describe('AuthController', () => {
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
      const user = { id: 1, name: 'Test', email: 'test@example.com', passwordHash: otherPasswordHash, createdAt: new Date() }
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
