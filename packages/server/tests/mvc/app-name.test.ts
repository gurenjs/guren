import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { defineEnv, Env } from '../../src/config/env'
import { createApp } from '../../src/http/Application'
import { ensureSharedInertiaPropsRegistry } from '../../src/mvc/inertia/shared'

const original = process.env.APP_NAME

afterEach(() => {
  if (original === undefined) delete process.env.APP_NAME
  else process.env.APP_NAME = original
})

async function sharedProps(options: Parameters<typeof createApp>[0]): Promise<Record<string, unknown>> {
  const app = createApp(options)
  await app.boot()
  const registry = ensureSharedInertiaPropsRegistry(app.container)
  let props: Record<string, unknown> = {}
  const hono = new Hono()
  hono.get('/', async (ctx) => {
    props = await registry.resolve(ctx)
    return ctx.text('')
  })
  await hono.request('/')
  return props
}

describe('the app shared prop', () => {
  test('carries APP_NAME from the validated environment', async () => {
    process.env.APP_NAME = 'Job Board'
    const props = await sharedProps({ env: defineEnv({ APP_NAME: Env.string().default('Guren') }) })

    expect(props.app).toEqual({ name: 'Job Board' })
  })

  test('takes the default the environment declares', async () => {
    delete process.env.APP_NAME
    const props = await sharedProps({ env: defineEnv({ APP_NAME: Env.string().default('Guren') }) })

    expect(props.app).toEqual({ name: 'Guren' })
  })

  test('is absent when the environment declares no APP_NAME, or no environment is given', async () => {
    process.env.APP_NAME = 'Job Board'

    expect('app' in await sharedProps({ env: defineEnv({ OTHER_KEY: Env.string().default('x') }) })).toBe(false)
    expect('app' in await sharedProps({})).toBe(false)
  })

  test('gives way to an app key the application shares itself', async () => {
    process.env.APP_NAME = 'Job Board'
    const props = await sharedProps({
      env: defineEnv({ APP_NAME: Env.string().default('Guren') }),
      inertia: { share: () => ({ app: { name: 'Mine', version: 2 } }) },
    })

    expect(props.app).toEqual({ name: 'Mine', version: 2 })
  })
})
