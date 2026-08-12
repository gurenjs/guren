import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createControllerContext,
  createControllerModuleMock,
  readInertiaResponse,
} from '@guren/testing'
import type { Context } from '@guren/core'

const { mockEmit } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
}))

vi.mock('guren', () => createControllerModuleMock())
vi.mock('@guren/core', async () => {
  const actual = await vi.importActual<typeof import('@guren/core')>('@guren/core')
  return {
    ...actual,
    ...createControllerModuleMock(),
    ServiceProvider: actual.ServiceProvider,
  }
})

import LoginController from '../../app/Http/Controllers/Auth/LoginController.js'

type MockAuth = {
  user: ReturnType<typeof vi.fn>
  session: ReturnType<typeof vi.fn>
  attempt: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
}

type MockSession = {
  regenerate: ReturnType<typeof vi.fn>
  invalidate: ReturnType<typeof vi.fn>
}

function createMockSession(): MockSession {
  return {
    regenerate: vi.fn(),
    invalidate: vi.fn(),
  }
}

function createAuthStub(user: unknown = null): MockAuth {
  const session = createMockSession()

  return {
    user: vi.fn().mockResolvedValue(user),
    session: vi.fn().mockReturnValue(session),
    attempt: vi.fn(),
    logout: vi.fn(),
  }
}

function createLoginController(auth: MockAuth) {
  const controller = new LoginController()
  Object.defineProperty(controller, 'auth', {
    value: auth,
    configurable: true,
  })
  return controller
}

describe('LoginController', () => {
  describe('show()', () => {
    it('returns Inertia JSON payload for XHR visits', async () => {
      const auth = createAuthStub()
      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login?email=jane@example.com', {
        headers: {
          'X-Inertia': 'true',
          Accept: 'application/json',
        },
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.show()
      const { format, payload } = await readInertiaResponse(response)

      expect(response.status).toBe(200)
      expect(format).toBe('json')
      expect(payload.component).toBe('auth/Login')
      expect(payload.props.email).toBe('jane@example.com')
      expect(payload.url).toBe('/login?email=jane@example.com')
    })

    it('embeds Inertia page data in HTML for full page visits', async () => {
      const auth = createAuthStub()
      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login') as unknown as Context
      controller.setContext(ctx)

      const response = await controller.show()
      const { format, payload, body } = await readInertiaResponse(response)

      expect(response.status).toBe(200)
      expect(format).toBe('html')
      expect(body).toContain('data-page=')
      expect(payload.component).toBe('auth/Login')
    })

    it('passes empty email when query param is not provided', async () => {
      const auth = createAuthStub()
      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.show()
      const { payload } = await readInertiaResponse(response)

      expect(payload.props.email).toBe('')
    })

    it('sets correct page title', async () => {
      const auth = createAuthStub()
      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        headers: { 'X-Inertia': 'true' },
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.show()

      expect(response.headers.get('X-Inertia')).toBe('true')
    })
  })

  describe('store()', () => {
    it('authenticates user with valid credentials', async () => {
      const auth = createAuthStub()
      auth.attempt.mockResolvedValue(true)

      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', password: 'password123' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.store()

      expect(auth.session).toHaveBeenCalled()
      expect(auth.session().regenerate).toHaveBeenCalled()
      expect(auth.attempt).toHaveBeenCalledWith(
        { email: 'user@example.com', password: 'password123' },
        false
      )
      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/dashboard')
    })

    it('respects remember me option', async () => {
      const auth = createAuthStub()
      auth.attempt.mockResolvedValue(true)

      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', password: 'password123', remember: true }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      await controller.store()

      expect(auth.attempt).toHaveBeenCalledWith(
        { email: 'user@example.com', password: 'password123' },
        true
      )
    })

    it('throws ValidationException for invalid credentials', async () => {
      const auth = createAuthStub()
      auth.attempt.mockResolvedValue(false)

      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', password: 'wrongpassword' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      await expect(controller.store()).rejects.toThrow('The given data was invalid.')
    })

    it('throws ValidationException for missing email', async () => {
      const auth = createAuthStub()
      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ password: 'password123' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      await expect(controller.store()).rejects.toThrow()
      expect(auth.attempt).not.toHaveBeenCalled()
    })

    it('throws ValidationException for missing password', async () => {
      const auth = createAuthStub()
      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      await expect(controller.store()).rejects.toThrow()
      expect(auth.attempt).not.toHaveBeenCalled()
    })

    it('throws ValidationException for invalid email format', async () => {
      const auth = createAuthStub()
      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'invalid-email', password: 'password123' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      await expect(controller.store()).rejects.toThrow()
      expect(auth.attempt).not.toHaveBeenCalled()
    })

    it('handles string remember value "true"', async () => {
      const auth = createAuthStub()
      auth.attempt.mockResolvedValue(true)

      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', password: 'password123', remember: 'true' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      await controller.store()

      expect(auth.attempt).toHaveBeenCalledWith(
        { email: 'user@example.com', password: 'password123' },
        true
      )
    })

    it('handles string remember value "on" (checkbox)', async () => {
      const auth = createAuthStub()
      auth.attempt.mockResolvedValue(true)

      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.com', password: 'password123', remember: 'on' }),
        headers: { 'Content-Type': 'application/json' },
      }) as unknown as Context
      controller.setContext(ctx)

      await controller.store()

      expect(auth.attempt).toHaveBeenCalledWith(
        { email: 'user@example.com', password: 'password123' },
        true
      )
    })
  })

  describe('destroy()', () => {
    it('logs out user and invalidates session', async () => {
      const mockUser = { id: 1, email: 'user@example.com' }
      const auth = createAuthStub(mockUser)

      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/logout', {
        method: 'POST',
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.destroy()

      expect(auth.logout).toHaveBeenCalled()
      expect(auth.session).toHaveBeenCalled()
      expect(auth.session().invalidate).toHaveBeenCalled()
      expect(response.status).toBe(303)
      expect(response.headers.get('Location')).toBe('/')
    })

    it('redirects to home page after logout', async () => {
      const auth = createAuthStub()

      const controller = createLoginController(auth)
      const ctx = createControllerContext('http://blog.test/logout', {
        method: 'POST',
      }) as unknown as Context
      controller.setContext(ctx)

      const response = await controller.destroy()

      expect(response.headers.get('Location')).toBe('/')
    })
  })
})

describe('Auth Flow Integration', () => {
  it('complete login flow: show -> store -> redirect', async () => {
    const auth = createAuthStub()
    auth.attempt.mockResolvedValue(true)

    // Step 1: Show login form
    const showController = createLoginController(auth)
    const showCtx = createControllerContext('http://blog.test/login', {
      headers: { 'X-Inertia': 'true' },
    }) as unknown as Context
    showController.setContext(showCtx)

    const showResponse = await showController.show()
    const { payload } = await readInertiaResponse(showResponse)
    expect(payload.component).toBe('auth/Login')

    // Step 2: Submit login form
    const storeController = createLoginController(auth)
    const storeCtx = createControllerContext('http://blog.test/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@example.com', password: 'password123' }),
      headers: { 'Content-Type': 'application/json' },
    }) as unknown as Context
    storeController.setContext(storeCtx)

    const storeResponse = await storeController.store()
    expect(storeResponse.status).toBe(303)
    expect(storeResponse.headers.get('Location')).toBe('/dashboard')
  })

  it('complete logout flow: destroy -> redirect to home', async () => {
    const mockUser = { id: 1, email: 'user@example.com', name: 'John Doe' }
    const auth = createAuthStub(mockUser)

    const controller = createLoginController(auth)
    const ctx = createControllerContext('http://blog.test/logout', {
      method: 'POST',
    }) as unknown as Context
    controller.setContext(ctx)

    const response = await controller.destroy()

    expect(auth.logout).toHaveBeenCalled()
    expect(auth.session().invalidate).toHaveBeenCalled()
    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('/')
  })
})
