import { describe, expect, it } from 'bun:test'
import { Application, type ServiceProviderConstructor } from '../../src'
import { ServiceProvider } from '../../src/container/ServiceProvider'
import { ValidationException } from '../../src/errors/exceptions/ValidationException'
import type { ExceptionHandler } from '../../src/errors/ExceptionHandler'

function throwingApp(providers?: ServiceProviderConstructor[]): Application {
  const app = new Application(providers ? { providers } : {})
  app.router.post('/submit', () => {
    throw ValidationException.withMessages({ email: 'Email is required' })
  })
  return app
}

describe('InertiaServiceProvider auto-registration', () => {
  it('redirects Inertia requests back with 303 without explicit registration', async () => {
    const app = throwingApp()
    await app.boot()

    const response = await app.fetch(
      new Request('http://example.com/submit', {
        method: 'POST',
        headers: {
          'X-Inertia': 'true',
          Referer: 'http://example.com/form',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    )

    expect(response.status).toBe(303)
    expect(response.headers.get('Location')).toBe('http://example.com/form')
  })

  it('returns 422 JSON for non-Inertia requests', async () => {
    const app = throwingApp()
    await app.boot()

    const response = await app.fetch(
      new Request('http://example.com/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    )

    expect(response.status).toBe(422)
    const body = await response.json() as { message: string; errors: Record<string, string[]> }
    expect(body.message).toBe('The given data was invalid.')
    expect(body.errors).toEqual({ email: ['Email is required'] })
  })

  it('lets a custom ValidationException renderer from a user provider win', async () => {
    class CustomValidationProvider extends ServiceProvider {
      register(): void {}

      boot(): void {
        const handler = this.container.make<ExceptionHandler>('exception.handler')
        handler.render(ValidationException, (_error, ctx) => ctx.json({ custom: true }, 400))
      }
    }

    const app = throwingApp([CustomValidationProvider])
    await app.boot()

    const response = await app.fetch(
      new Request('http://example.com/submit', {
        method: 'POST',
        headers: {
          'X-Inertia': 'true',
          Referer: 'http://example.com/form',
          'Content-Type': 'application/json',
        },
        body: '{}',
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ custom: true })
  })
})
