import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { AGENT_REDACTED } from '../../src/agent/redact'
import { defineEnv, Env, EnvValidationError } from '../../src/config/env'
import { ServiceProvider } from '../../src/container/ServiceProvider'
import { createApp } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { Controller } from '../../src/mvc/Controller'
import { resetWarnOnce } from '../../src/support/warn-once'
import { withEnv } from '../support/env'

const schema = defineEnv({
  RFC27_APP_KEY: Env.string().secret(),
  RFC27_SESSION_DRIVER: Env.enum(['database', 'cookie']).default('database'),
})

const seen: unknown[] = []

class ReadsEnvInRegister extends ServiceProvider {
  register(): void {
    seen.push(this.container.make('env'))
  }
}

afterEach(() => {
  seen.length = 0
  resetWarnOnce()
  resetDefaultApplication()
})

describe('createApp({ env })', () => {
  test('binds the validated values before any app provider registers', async () => {
    const app = createApp({ env: schema, providers: [ReadsEnvInRegister] })
    app.container.instance('env.source', { RFC27_APP_KEY: 'key', RFC27_SESSION_DRIVER: 'cookie' })

    await app.boot()

    expect(seen).toEqual([{ RFC27_APP_KEY: 'key', RFC27_SESSION_DRIVER: 'cookie' }])
    expect(app.container.make('env')).toEqual({ RFC27_APP_KEY: 'key', RFC27_SESSION_DRIVER: 'cookie' })
  })

  test('fails the boot on an invalid environment before any app provider registers', async () => {
    const app = createApp({ env: schema, providers: [ReadsEnvInRegister] })
    app.container.instance('env.source', { RFC27_SESSION_DRIVER: 'redis' })

    await expect(app.boot()).rejects.toBeInstanceOf(EnvValidationError)
    await expect(app.boot()).rejects.toThrow(/RFC27_APP_KEY\s+required, not set\n\s+RFC27_SESSION_DRIVER\s+"redis" is not one of/)
    expect(seen).toEqual([])
  })

  test('retries validation on the next boot once the value is supplied', async () => {
    const app = createApp({ env: schema })

    await withEnv({ RFC27_APP_KEY: undefined }, async () => {
      await expect(app.boot()).rejects.toBeInstanceOf(EnvValidationError)
      process.env.RFC27_APP_KEY = 'later'
      await app.boot()
    })

    expect(app.container.make('env')).toEqual({ RFC27_APP_KEY: 'later', RFC27_SESSION_DRIVER: 'database' })
  })

  test('reports instead of throwing under GUREN_INTROSPECT=1', async () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {})
    const app = createApp({ env: schema })

    let warnings = ''
    try {
      await withEnv({ GUREN_INTROSPECT: '1' }, () => app.boot())
      warnings = warn.mock.calls.flat().join('\n')
    } finally {
      warn.mockRestore()
    }

    expect(app.container.make('env')).toEqual({ RFC27_APP_KEY: AGENT_REDACTED, RFC27_SESSION_DRIVER: 'database' })
    expect(warnings).toContain('RFC27_APP_KEY required, not set')
  })

  test('binds nothing without a schema', async () => {
    const app = createApp()

    await app.boot()

    expect(app.container.has('env')).toBe(false)
  })
})

class PageController extends Controller {
  async show() {
    return this.inertia('Docs/Show', { page: 1 })
  }
}

async function sharedProps(app: ReturnType<typeof createApp>): Promise<Record<string, unknown>> {
  app.router.get('/page', [PageController, 'show'])
  await app.boot()
  const response = await app.fetch(new Request('http://example.com/page', {
    headers: { 'X-Inertia': 'true', 'X-Requested-With': 'XMLHttpRequest' },
  }))
  return ((await response.json()) as { props: Record<string, unknown> }).props
}

describe('createApp({ inertia: { share } })', () => {
  test('merges the shared props into every response of its own app only', async () => {
    const first = createApp({ inertia: { share: () => ({ tenant: 'first' }) } })
    expect(await sharedProps(first)).toMatchObject({ tenant: 'first', page: 1 })
    resetDefaultApplication()

    const second = createApp({ inertia: { share: () => ({ tenant: 'second' }) } })
    expect(await sharedProps(second)).toMatchObject({ tenant: 'second', page: 1 })
    expect(await sharedProps(first)).toMatchObject({ tenant: 'first', page: 1 })
  })
})
