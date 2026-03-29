import { describe, expect, it, vi } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

function createGurenCoreMock() {
  return {
    ...createControllerModuleMock(),
    AuthenticatableModel: class AuthenticatableModel {
      static table: unknown = null
      static recordType: unknown = {}
      static relationTypes: unknown = {}
      static find = vi.fn()
      static where = vi.fn()
      static update = vi.fn()
    },
    HasManyRecord: {} as never,
  }
}

vi.mock('guren', () => createControllerModuleMock())
vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createGurenCoreMock(),
    ServiceProvider: actual.ServiceProvider,
  }
})
import DashboardController from '../../app/Http/Controllers/DashboardController.js'
import ProfileController from '../../app/Http/Controllers/ProfileController.js'

type MockAuth = {
  user: ReturnType<typeof vi.fn>
  session: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
}

function createAuthStub(user: unknown = null): MockAuth {
  return {
    user: vi.fn().mockResolvedValue(user),
    session: vi.fn().mockReturnValue({
      regenerate: vi.fn(),
      invalidate: vi.fn(),
    }),
    login: vi.fn().mockResolvedValue(undefined),
  }
}

function createControllerWithAuth<T extends { setContext: (ctx: Context) => void }>(
  ControllerClass: new () => T,
  auth: MockAuth,
  ctx: Context
): T {
  const controller = new ControllerClass()
  Object.defineProperty(controller, 'auth', {
    value: auth,
    configurable: true,
  })
  controller.setContext(ctx)
  return controller
}

describe('DashboardController', () => {
  describe('index()', () => {
    it('returns Inertia JSON response for XHR requests', async () => {
      const mockUser = { id: 1, name: 'John Doe', email: 'john@example.com' }
      const auth = createAuthStub(mockUser)
      const ctx = createControllerContext('http://blog.test/dashboard', {
        headers: {
          'X-Inertia': 'true',
          Accept: 'application/json',
        },
      }) as unknown as Context

      const controller = createControllerWithAuth(DashboardController, auth, ctx)
      const response = await controller.index()
      const { format, payload } = await readInertiaResponse(response)

      expect(format).toBe('json')
      expect(payload.component).toBe('dashboard/Index')
      expect(payload.props.user).toEqual(mockUser)
      expect(payload.url).toBe('/dashboard')
    })

    it('returns Inertia HTML response for full page visits', async () => {
      const mockUser = { id: 1, name: 'Jane Doe', email: 'jane@example.com' }
      const auth = createAuthStub(mockUser)
      const ctx = createControllerContext('http://blog.test/dashboard') as unknown as Context

      const controller = createControllerWithAuth(DashboardController, auth, ctx)
      const response = await controller.index()
      const { format, payload, body } = await readInertiaResponse(response)

      expect(format).toBe('html')
      expect(body).toContain('data-page=')
      expect(payload.component).toBe('dashboard/Index')
      expect(payload.props.user).toEqual(mockUser)
    })

    it('passes null user when not authenticated', async () => {
      const auth = createAuthStub(null)
      const ctx = createControllerContext('http://blog.test/dashboard', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context

      const controller = createControllerWithAuth(DashboardController, auth, ctx)
      const response = await controller.index()
      const { payload } = await readInertiaResponse(response)

      expect(payload.props.user).toBeNull()
    })
  })
})

describe('ProfileController', () => {
  describe('edit()', () => {
    it('returns profile edit page with user data', async () => {
      const mockUser = { id: 1, name: 'John Doe', email: 'john@example.com' }
      const auth = createAuthStub(mockUser)
      const ctx = createControllerContext('http://blog.test/profile', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context

      const controller = createControllerWithAuth(ProfileController, auth, ctx)
      const response = await controller.edit()
      const { payload } = await readInertiaResponse(response)

      expect(response.status).toBe(200)
      expect(payload.component).toBe('profile/Edit')
      expect(payload.props.profile).toEqual({
        name: 'John Doe',
        email: 'john@example.com',
      })
    })

    it('redirects to login when not authenticated', async () => {
      const auth = createAuthStub(null)
      const ctx = createControllerContext('http://blog.test/profile', {
        method: 'GET',
      }) as unknown as Context

      const controller = createControllerWithAuth(ProfileController, auth, ctx)
      const response = await controller.edit()

      expect(response.status).toBe(302)
      expect(response.headers.get('Location')).toBe('/login')
    })
  })

  describe('update()', () => {
    it('redirects to login when not authenticated', async () => {
      const auth = createAuthStub(null)
      const ctx = createControllerContext('http://blog.test/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: 'New Name', email: 'new@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context

      const controller = createControllerWithAuth(ProfileController, auth, ctx)
      const response = await controller.update()

      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/login')
    })

    it('throws ValidationException for invalid data', async () => {
      const mockUser = { id: 1, name: 'John Doe', email: 'john@example.com' }
      const auth = createAuthStub(mockUser)
      const ctx = createControllerContext('http://blog.test/profile', {
        method: 'PUT',
        body: JSON.stringify({ name: '', email: 'invalid' }),
        headers: { 'Content-Type': 'application/json', 'X-Inertia': 'true' },
      }) as unknown as Context

      const controller = createControllerWithAuth(ProfileController, auth, ctx)
      await expect(controller.update()).rejects.toThrow()
    })
  })
})

describe('Inertia Response Format', () => {
  it('JSON response includes X-Inertia header', async () => {
    const mockUser = { id: 1, name: 'Test User', email: 'test@example.com' }
    const auth = createAuthStub(mockUser)
    const ctx = createControllerContext('http://blog.test/dashboard', {
      headers: { 'X-Inertia': 'true' },
    }) as unknown as Context

    const controller = createControllerWithAuth(DashboardController, auth, ctx)
    const response = await controller.index()

    expect(response.headers.get('X-Inertia')).toBe('true')
    expect(response.headers.get('Content-Type')).toContain('application/json')
  })

  it('HTML response includes X-Inertia header', async () => {
    const mockUser = { id: 1, name: 'Test User', email: 'test@example.com' }
    const auth = createAuthStub(mockUser)
    const ctx = createControllerContext('http://blog.test/dashboard') as unknown as Context

    const controller = createControllerWithAuth(DashboardController, auth, ctx)
    const response = await controller.index()

    expect(response.headers.get('X-Inertia')).toBe('true')
    expect(response.headers.get('Content-Type')).toContain('text/html')
  })

  it('HTML response contains data-page attribute with escaped JSON', async () => {
    const mockUser = { id: 1, name: 'Test <User>', email: 'test@example.com' }
    const auth = createAuthStub(mockUser)
    const ctx = createControllerContext('http://blog.test/dashboard') as unknown as Context

    const controller = createControllerWithAuth(DashboardController, auth, ctx)
    const response = await controller.index()
    const { body, payload } = await readInertiaResponse(response)

    expect(body).toContain('data-page=')
    expect((payload.props.user as { name: string }).name).toBe('Test <User>')
  })

  it('preserves URL path in payload', async () => {
    const mockUser = { id: 1, name: 'Test User', email: 'test@example.com' }
    const auth = createAuthStub(mockUser)
    const ctx = createControllerContext('http://blog.test/dashboard?tab=settings', {
      headers: { 'X-Inertia': 'true' },
    }) as unknown as Context

    const controller = createControllerWithAuth(DashboardController, auth, ctx)
    const response = await controller.index()
    const { payload } = await readInertiaResponse(response)

    expect(payload.url).toBe('/dashboard')
  })
})

describe('Inertia Content Type Detection', () => {
  it('returns JSON when Accept header contains application/json', async () => {
    const mockUser = { id: 1, name: 'Test', email: 'test@example.com' }
    const auth = createAuthStub(mockUser)
    const ctx = createControllerContext('http://blog.test/dashboard', {
      headers: { Accept: 'application/json' },
    }) as unknown as Context

    const controller = createControllerWithAuth(DashboardController, auth, ctx)
    const response = await controller.index()
    const { format } = await readInertiaResponse(response)

    expect(format).toBe('json')
  })

  it('returns JSON when X-Inertia header is true', async () => {
    const mockUser = { id: 1, name: 'Test', email: 'test@example.com' }
    const auth = createAuthStub(mockUser)
    const ctx = createControllerContext('http://blog.test/dashboard', {
      headers: { 'X-Inertia': 'true' },
    }) as unknown as Context

    const controller = createControllerWithAuth(DashboardController, auth, ctx)
    const response = await controller.index()
    const { format } = await readInertiaResponse(response)

    expect(format).toBe('json')
  })

  it('returns HTML when no special headers are set', async () => {
    const mockUser = { id: 1, name: 'Test', email: 'test@example.com' }
    const auth = createAuthStub(mockUser)
    const ctx = createControllerContext('http://blog.test/dashboard') as unknown as Context

    const controller = createControllerWithAuth(DashboardController, auth, ctx)
    const response = await controller.index()
    const { format } = await readInertiaResponse(response)

    expect(format).toBe('html')
  })
})
