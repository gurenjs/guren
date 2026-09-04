import { describe, expect, it, beforeEach } from 'bun:test'
import type { Context } from 'hono'
import { Container } from '../../src/container'
import {
  setInertiaSharedProps,
  shareInertiaProps,
  getInertiaSharedPropsResolver,
  ensureSharedInertiaPropsRegistry,
  resolveSharedInertiaProps,
  INERTIA_SHARED_PROPS_BINDING,
} from '../../src/mvc/inertia/shared'

const fakeCtx = {} as Context

beforeEach(() => {
  setInertiaSharedProps(null)
})

describe('shareInertiaProps', () => {
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

  it('composes the global registrations made before it was read', async () => {
    shareInertiaProps(() => ({ first: 1 }))
    shareInertiaProps(() => ({ second: 2 }))

    const composed = getInertiaSharedPropsResolver()!
    shareInertiaProps(() => ({ third: 3 }))

    expect(await composed(fakeCtx)).toEqual({ first: 1, second: 2 })
  })
})

describe('container-scoped shared props', () => {
  it('binds one registry per container and reuses it', () => {
    const container = new Container()

    const registry = ensureSharedInertiaPropsRegistry(container)
    expect(container.has(INERTIA_SHARED_PROPS_BINDING)).toBe(true)
    expect(ensureSharedInertiaPropsRegistry(container)).toBe(registry)
  })

  it('keeps two containers isolated and leaves the global registry untouched', async () => {
    const containerA = new Container()
    const containerB = new Container()

    shareInertiaProps(() => ({ app: 'A' }), containerA)
    shareInertiaProps(() => ({ app: 'B' }), containerB)

    expect(await resolveSharedInertiaProps(fakeCtx, containerA)).toEqual({ app: 'A' })
    expect(await resolveSharedInertiaProps(fakeCtx, containerB)).toEqual({ app: 'B' })
    expect(await resolveSharedInertiaProps(fakeCtx)).toEqual({})
  })

  it('resolves global and scoped props in registration order', async () => {
    const container = new Container()

    shareInertiaProps(() => ({ fromGlobal: true, overlap: 'global' }))
    shareInertiaProps(() => ({ overlap: 'scoped' }), container)

    expect(await resolveSharedInertiaProps(fakeCtx, container)).toEqual({
      fromGlobal: true,
      overlap: 'scoped',
    })
  })

  it('lets a globally registered resolver override an earlier scoped one', async () => {
    // Registration order wins across both scopes.
    const container = new Container()

    shareInertiaProps(() => ({ _i18n: { locale: 'en' } }), container)
    shareInertiaProps(() => ({ _i18n: { locale: 'ja' } }))

    expect(await resolveSharedInertiaProps(fakeCtx, container)).toEqual({ _i18n: { locale: 'ja' } })
  })

  it('falls back to global-only resolution for a container with no registry', async () => {
    const container = new Container()
    setInertiaSharedProps(() => ({ appName: 'Global' }))

    expect(await resolveSharedInertiaProps(fakeCtx, container)).toEqual({ appName: 'Global' })
    expect(container.has(INERTIA_SHARED_PROPS_BINDING)).toBe(false)
  })

  it('setInertiaSharedProps(null) leaves scoped registrations intact', async () => {
    const container = new Container()
    shareInertiaProps(() => ({ scoped: true }), container)
    setInertiaSharedProps(() => ({ global: true }))

    setInertiaSharedProps(null)

    expect(await resolveSharedInertiaProps(fakeCtx, container)).toEqual({ scoped: true })
  })
})
