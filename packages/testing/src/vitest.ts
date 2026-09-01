import { afterEach, beforeEach, vi } from 'vitest'
import type { PropsWithChildren, ReactElement } from 'react'
import { createInertiaReactMock, resetInertiaPage } from './inertia'
import { setTestLifecycleHooks } from './lifecycle'

// Importing this module wires vitest's lifecycle hooks into the runner-agnostic
// helpers on the main entry (useDatabaseTransactions, useTruncateTables).
setTestLifecycleHooks({ beforeEach, afterEach })

/**
 * scrypt cost for the `Bun.password` stand-in. Two orders of magnitude below
 * the framework default, which is the point: a test suite pays this per login.
 */
const TEST_SCRYPT_COST = 1024

/**
 * A working stand-in for `Bun.password`, which does not exist off Bun.
 *
 * Deliberately a real hasher rather than a throwing stub. A stub that throws
 * forces every app test touching a password into hand-writing its own hasher
 * double, and a hand-written double is a copy of a contract that no type
 * constrains - which is how a `verify(plain, hashed)` inversion once shipped
 * with a green suite, the double having encoded the same inversion.
 *
 * It delegates to the framework's own scrypt rather than reimplementing it:
 * the format, the parameter parsing, and the rejection of a malformed hash are
 * then the same code the application runs, and cannot drift from it. The
 * import is lazy because this module is also emitted as CJS, and `@guren/server`
 * is ESM-only - the same reason `test-app.ts` and `agent.ts` import it this way.
 */
const testPasswordApi = {
  async hash(password: string): Promise<string> {
    const { hashPassword } = await import('@guren/server/encryption')
    return hashPassword(password, { cost: TEST_SCRYPT_COST })
  },

  /**
   * Throws on a hash it cannot parse, as `Bun.password.verify` does. Returning
   * `false` would make a swapped `verify(plain, hashed)` call look like a wrong
   * password in tests while it is a 500 in production.
   */
  async verify(password: string, hashed: string): Promise<boolean> {
    const { verifyPassword } = await import('@guren/server/encryption')
    return verifyPassword(password, hashed)
  },
}

export interface ConfigureInertiaVitestOptions {
  Head?: (props: PropsWithChildren) => ReactElement | null
  stubBun?: boolean
}

let configured = false

export function configureInertiaVitest(
  options: ConfigureInertiaVitestOptions = {},
): void {
  if (configured) {
    return
  }

  configured = true

  const {
    Head = () => null,
    stubBun = true,
  } = options

  if (stubBun && typeof globalThis.Bun === 'undefined') {
    ;(globalThis as Record<string, unknown>).Bun = {
      env: {},
      password: testPasswordApi,
      file(path: string | URL) {
        if (typeof path === 'string' || path instanceof URL) {
          return {
            exists: false,
            type: 'file',
            size: 0,
            text: async () => '',
            arrayBuffer: async () => new ArrayBuffer(0),
          }
        }

        throw new TypeError(
          'Unsupported Bun.file argument in test environment.',
        )
      },
    }
  }

  vi.doMock('@inertiajs/react', async () => {
    const actual = await import('@inertiajs/react')
    return createInertiaReactMock(actual, { Head })
  })

  beforeEach(() => {
    resetInertiaPage()
  })

  afterEach(() => {
    vi.clearAllMocks()
    resetInertiaPage()
  })
}
