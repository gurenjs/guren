import { afterEach, describe, expect, test } from 'bun:test'
import { defineConfig } from '../../src/config/define'
import { defineEnv, Env } from '../../src/config/env'
import { recordEnvReads } from '../../src/config/env-reads'
import { createApp } from '../../src/http/Application'
import { resetDefaultApplication } from '../../src/http/default-application'
import { withEnv } from '../support/env'

afterEach(() => {
  resetDefaultApplication()
})

describe('recordEnvReads()', () => {
  test('hands the values through and records the keys that were read', () => {
    const { env, read } = recordEnvReads({ RFC27_A: 'a', RFC27_B: 'b' } as never)
    const values = env as unknown as Record<string, string>

    expect(values.RFC27_A).toBe('a')

    expect([...read]).toEqual(['RFC27_A'])
  })

  test('records reads of a frozen parse() result', () => {
    const parsed = defineEnv({ RFC27_STORE: Env.string().default('memory') }).parse({})
    const { env, read } = recordEnvReads(parsed.values as never)

    expect((env as unknown as Record<string, string>).RFC27_STORE).toBe('memory')
    expect([...read]).toEqual(['RFC27_STORE'])
  })
})

describe('ConfigServiceProvider unset keys (RFC 0027 §2)', () => {
  test('leaves a definition that read an unset key unbound, and binds the others', async () => {
    const env = defineEnv({ RFC27_REQUIRED_KEY: Env.string(), RFC27_SET_KEY: Env.string().default('ok') })
    const app = createApp({
      env,
      config: [
        defineConfig({
          key: 'cache',
          resolve: (values) => ({ default: (values as unknown as Record<string, string>).RFC27_REQUIRED_KEY }),
          bind: (container, config) => {
            container.instance('cache', config)
          },
        }),
        defineConfig({
          key: 'http',
          resolve: (values) => {
            void (values as unknown as Record<string, string>).RFC27_SET_KEY
            return {}
          },
          bind: (container) => {
            container.instance('http.hostAuthorization', false)
          },
        }),
      ],
    })

    // Report mode, the only mode an unset key survives: `throw` fails the boot first.
    await withEnv({ GUREN_INTROSPECT: '1', RFC27_REQUIRED_KEY: undefined }, async () => {
      await app.boot()
    })

    expect(app.container.has('cache')).toBe(false)
    expect(app.container.has('http.hostAuthorization')).toBe(true)
  })
})
