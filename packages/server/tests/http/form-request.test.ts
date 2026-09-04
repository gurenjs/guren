import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { createMockAuthContext } from '@guren/testing'
import { FormRequest } from '../../src/http/FormRequest'
import { attachAuthContext, type AuthContext } from '../../src/http/middleware/auth'
import { AuthorizationException } from '../../src/errors/exceptions/AuthorizationException'
import { ValidationException } from '../../src/errors/exceptions/ValidationException'
import { required, string } from '../../src/http/validation/rules'

interface StorePostData {
  title: string
}

class StorePostRequest extends FormRequest<StorePostData> {
  rules() {
    return {
      title: [required(), string()],
    }
  }
}

// Routes the auth context through `attachAuthContext()` so the tests see
// whatever the framework actually stores under that key.
async function createContext(body: Record<string, unknown>, auth?: AuthContext): Promise<Context> {
  const app = new Hono()
  let captured: Context | undefined

  if (auth) {
    app.use(attachAuthContext(() => auth))
  }

  app.post('/posts', (ctx) => {
    captured = ctx
    return ctx.body(null, 204)
  })

  await app.request('/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!captured) {
    throw new Error('The route did not run, so no context was captured.')
  }

  return captured
}

describe('FormRequest', () => {
  describe('user', () => {
    /** Records what `user()` resolved to, which is otherwise unobservable. */
    class ProbeRequest extends StorePostRequest {
      resolved: unknown = 'never ran'

      async authorize(): Promise<boolean> {
        this.resolved = await this.user()
        return true
      }
    }

    test('resolves the authenticated user', async () => {
      const request = new ProbeRequest()
      await request.handle(await createContext({ title: 'Hello' }, createMockAuthContext({ isAuthenticated: true })))

      expect(request.resolved).toEqual({ id: 1, name: 'Test User' })
    })

    test('resolves null for a logged-out visitor', async () => {
      const request = new ProbeRequest()
      await request.handle(await createContext({ title: 'Hello' }, createMockAuthContext({ isAuthenticated: false })))

      expect(request.resolved).toBeNull()
    })

    test('resolves null when no auth context is attached', async () => {
      const request = new ProbeRequest()
      await request.handle(await createContext({ title: 'Hello' }))

      expect(request.resolved).toBeNull()
    })
  })

  describe('handle', () => {
    test('returns the validated payload, dropping fields the rules do not cover', async () => {
      const data = await new StorePostRequest().handle(await createContext({ title: 'Hello', extra: 'dropped' }))

      expect(data).toEqual({ title: 'Hello' })
    })

    test('throws AuthorizationException when authorize() returns false', async () => {
      class DeniedRequest extends StorePostRequest {
        authorize(): boolean {
          return false
        }
      }

      await expect(new DeniedRequest().handle(await createContext({ title: 'Hello' }))).rejects.toThrow(
        AuthorizationException,
      )
    })

    test('throws ValidationException when the payload fails the rules', async () => {
      await expect(new StorePostRequest().handle(await createContext({}))).rejects.toThrow(ValidationException)
    })
  })
})
