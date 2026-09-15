import { afterEach, describe, expect, test } from 'bun:test'

import { bootWorkersApp, type WorkersAppLike } from './boot'
import { resetWorkersEnv } from './env'

function fakeApp(bound: Map<string, unknown> = new Map()): WorkersAppLike & { sourceAtBoot: unknown } {
  const app = {
    sourceAtBoot: undefined as unknown,
    async boot() {
      app.sourceAtBoot = bound.get('env.source')
    },
    fetch: () => new Response('ok'),
    container: {
      makeOptional: <T>(key: string) => bound.get(key) as T | undefined,
      has: (key: string) => bound.has(key),
      instance: (key: string, value: unknown) => bound.set(key, value),
    },
  }
  return app
}

afterEach(() => {
  resetWorkersEnv()
})

describe('bootWorkersApp() and env.source (RFC 0027 §1)', () => {
  test('binds the entrypoint env before boot, so the env schema reads wrangler vars from it', async () => {
    const env = { APP_URL: 'https://example.com', DB: {} }
    const app = fakeApp()

    await bootWorkersApp(app, env)

    expect(app.sourceAtBoot).toBe(env)
  })

  test('keeps an env.source the app or a test bound itself', async () => {
    const own = { APP_URL: 'https://own.example' }
    const app = fakeApp(new Map([['env.source', own]]))

    await bootWorkersApp(app, { APP_URL: 'https://example.com' })

    expect(app.sourceAtBoot).toBe(own)
  })

  test('boots an app-like whose container cannot bind', async () => {
    let booted = false
    const app: WorkersAppLike = {
      async boot() {
        booted = true
      },
      fetch: () => new Response('ok'),
      container: { makeOptional: () => undefined },
    }

    await bootWorkersApp(app, { APP_URL: 'https://example.com' })

    expect(booted).toBe(true)
  })
})
