import { describe, expect, it } from 'vitest'
import { configureInertiaVitest } from './vitest'
import { setInertiaPage } from './inertia'

describe('configureInertiaVitest', () => {
  const isBun = typeof globalThis.Bun !== 'undefined'

  // One test, because configureInertiaVitest() installs its stubs once per
  // process and returns early on any later call.
  it.skipIf(isBun)('stubs Bun and wires Inertia mocks', async () => {
    const globalRef = globalThis as { Bun?: any }
    const originalBun = globalRef.Bun
    delete globalRef.Bun

    configureInertiaVitest({ stubBun: true })

    expect(globalRef.Bun).toBeDefined()

    // The Bun.password stub is a working hasher on purpose. When it threw,
    // every app test touching a password had to hand-write a hasher double,
    // and a double is a copy of a contract that no type constrains - which is
    // how a `verify(plain, hashed)` inversion once shipped with a green suite.
    const hashed = await globalRef.Bun.password.hash('password123')

    // The format `hashPassword()` writes, so the framework's real
    // `verifyPassword()` can read back a hash this stub produced.
    expect(hashed.startsWith('$scrypt$')).toBe(true)
    expect(await globalRef.Bun.password.verify('password123', hashed)).toBe(true)
    expect(await globalRef.Bun.password.verify('wrong', hashed)).toBe(false)

    // Throws on an unparseable hash exactly as Bun.password.verify does.
    // Returning false there would make a swapped call look like a wrong
    // password in tests while it is a 500 in production.
    await expect(
      globalRef.Bun.password.verify('password123', 'not-a-hash'),
    ).rejects.toThrow()

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
