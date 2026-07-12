import { describe, expect, it, beforeEach } from 'bun:test'
import type { Context } from 'hono'
import {
  setInertiaSharedProps,
  shareInertiaProps,
  getInertiaSharedPropsResolver,
  resolveSharedInertiaProps,
} from '../../src/mvc/inertia/shared'

const fakeCtx = {} as Context

describe('shareInertiaProps', () => {
  beforeEach(() => {
    setInertiaSharedProps(null)
  })

  it('merges props over a resolver registered via setInertiaSharedProps', async () => {
    setInertiaSharedProps(() => ({ appName: 'Test' }))
    shareInertiaProps(() => ({ i18n: { locale: 'ja' } }))

    const shared = await resolveSharedInertiaProps(fakeCtx)
    expect(shared).toEqual({ appName: 'Test', i18n: { locale: 'ja' } })
  })

  it('composes multiple shareInertiaProps calls, later ones winning on conflicts', async () => {
    shareInertiaProps(() => ({ a: 1, shared: 'first' }))
    shareInertiaProps(async () => ({ b: 2, shared: 'second' }))

    const shared = await resolveSharedInertiaProps(fakeCtx)
    expect(shared).toEqual({ a: 1, b: 2, shared: 'second' })
  })

  it('works as the first registration with no prior resolver', async () => {
    shareInertiaProps(() => ({ only: true }))

    const shared = await resolveSharedInertiaProps(fakeCtx)
    expect(shared).toEqual({ only: true })
  })

  it('getInertiaSharedPropsResolver exposes the current resolver for manual composition', async () => {
    setInertiaSharedProps(() => ({ base: true }))

    const previous = getInertiaSharedPropsResolver()
    expect(previous).not.toBeNull()

    setInertiaSharedProps(async (ctx) => ({
      ...(previous ? await previous(ctx) : {}),
      extra: 1,
    }))

    const shared = await resolveSharedInertiaProps(fakeCtx)
    expect(shared).toEqual({ base: true, extra: 1 })
  })
})
