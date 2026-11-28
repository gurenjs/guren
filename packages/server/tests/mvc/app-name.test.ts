import { afterEach, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { defineEnv, Env } from '../../src/config/env'
import { createApp } from '../../src/http/Application'
import { resolveSharedInertiaProps, setInertiaSharedProps, shareInertiaProps } from '../../src/mvc/inertia/shared'

const original = process.env.APP_NAME

afterEach(() => {
  setInertiaSharedProps(null)
  if (original === undefined) delete process.env.APP_NAME
  else process.env.APP_NAME = original
})

async function sharedProps(options: Parameters<typeof createApp>[0]): Promise<Record<string, unknown>> {
  const app = createApp(options)
  await app.boot()
  let props: Record<string, unknown> = {}
  const hono = new Hono()
  hono.get('/', async (ctx) => {
    props = await resolveSharedInertiaProps(ctx, app.container)
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

  test('gives way to an app key shared without a container before the app was created', async () => {
    process.env.APP_NAME = 'Job Board'
    shareInertiaProps(() => ({ app: { name: 'Global', version: 3 } }))
    const props = await sharedProps({ env: defineEnv({ APP_NAME: Env.string().default('Guren') }) })

    expect(props.app).toEqual({ name: 'Global', version: 3 })
  })
})
