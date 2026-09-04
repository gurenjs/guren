import { describe, expect, it } from 'vitest'
import { configureInertiaVitest } from './vitest'
import { setInertiaPage } from './inertia'

describe('configureInertiaVitest', () => {
  const isBun = typeof globalThis.Bun !== 'undefined'

  // One test, because configureInertiaVitest() installs its stubs once per
  // process and returns early on any later call.
  it.skipIf(isBun)('stubs Bun and wires Inertia mocks', async () => {
    const globalRef = globalThis as { Bun?: unknown }
    const originalBun = globalRef.Bun
    delete globalRef.Bun

    configureInertiaVitest({ stubBun: true })

    const installed = globalRef.Bun as
      | {
          password: {
            hash(password: string): Promise<string>
            verify(password: string, hashed: string): Promise<boolean>
          }
        }
      | undefined
    if (!installed) {
      throw new Error('configureInertiaVitest({ stubBun: true }) installed no Bun stub')
    }

    // A working hasher on purpose: a hand-written double is a copy of a contract no
    // type constrains, which is how a `verify(plain, hashed)` inversion once shipped.
    const hashed = await installed.password.hash('password123')

    // The format `hashPassword()` writes, so the framework's real
    // `verifyPassword()` can read back a hash this stub produced.
    expect(hashed.startsWith('$scrypt$')).toBe(true)
    expect(await installed.password.verify('password123', hashed)).toBe(true)
    expect(await installed.password.verify('wrong', hashed)).toBe(false)

    // Throws on an unparseable hash exactly as Bun.password.verify does: returning
    // false would read as a wrong password in tests while it is a 500 in production.
    await expect(
      installed.password.verify('password123', 'not-a-hash'),
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
