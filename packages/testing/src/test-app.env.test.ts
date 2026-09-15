import { afterEach, describe, expect, it } from 'vitest'
import { defineEnv, Env, EnvValidationError, resetDefaultApplication, ServiceProvider } from '@guren/server'
import { TestApp } from './test-app'

const schema = defineEnv({
  RFC27_TESTING_DATABASE_URL: Env.url(),
  RFC27_TESTING_DRIVER: Env.enum(['database', 'cookie']).default('database'),
})

const seen: unknown[] = []

class ReadsEnv extends ServiceProvider {
  register(): void {
    seen.push(this.container.make('env'))
  }
}

afterEach(() => {
  seen.length = 0
  delete process.env.RFC27_TESTING_DATABASE_URL
  resetDefaultApplication()
})

describe('TestApp.create({ env, envSource }) (RFC 0027 §1)', () => {
  it('validates the schema with the overrides ahead of process.env', async () => {
    process.env.RFC27_TESTING_DATABASE_URL = 'postgres://localhost/development'

    await TestApp.create({
      env: schema,
      envSource: { RFC27_TESTING_DATABASE_URL: 'postgres://localhost/test' },
      providers: [ReadsEnv],
    })

    expect(seen).toEqual([{ RFC27_TESTING_DATABASE_URL: 'postgres://localhost/test', RFC27_TESTING_DRIVER: 'database' }])
  })

  it('fails the create when an override is invalid', async () => {
    await expect(TestApp.create({
      env: schema,
      envSource: { RFC27_TESTING_DATABASE_URL: 'not a url' },
    })).rejects.toBeInstanceOf(EnvValidationError)
  })
})
