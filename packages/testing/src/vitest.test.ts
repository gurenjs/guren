import { describe, expect, it } from 'vitest'
import { configureInertiaVitest } from './vitest'
import { setInertiaPage } from './inertia'

describe('configureInertiaVitest', () => {
  const isBun = typeof globalThis.Bun !== 'undefined'

  it.skipIf(isBun)('stubs Bun and wires Inertia mocks', async () => {
    const globalRef = globalThis as { Bun?: unknown }
    const originalBun = globalRef.Bun
    delete globalRef.Bun

    configureInertiaVitest({ stubBun: true })

    expect(globalRef.Bun).toBeDefined()

    setInertiaPage({ component: 'Settings', props: { ready: true }, url: '/settings' })
    const inertia = await import('@inertiajs/react')
    expect(inertia.usePage().component).toBe('Settings')

    if (originalBun === undefined) {
      delete globalRef.Bun
    } else {
      globalRef.Bun = originalBun
    }
  })
})
