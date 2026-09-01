import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { afterEach, beforeEach, vi } from 'vitest'
import type { PropsWithChildren, ReactElement } from 'react'
import { createInertiaReactMock, resetInertiaPage } from './inertia'
import { setTestLifecycleHooks } from './lifecycle'

// Importing this module wires vitest's lifecycle hooks into the runner-agnostic
// helpers on the main entry (useDatabaseTransactions, useTruncateTables).
setTestLifecycleHooks({ beforeEach, afterEach })

const TEST_SCRYPT_COST = 1024
const TEST_SCRYPT_BLOCK_SIZE = 8
const TEST_SALT_LENGTH = 16
const TEST_KEY_LENGTH = 64

function deriveScrypt(
  password: string,
  salt: Buffer,
  keyLength: number,
  cost: number,
  blockSize: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, { N: cost, r: blockSize, p: 1 }, (error, derived) => {
      if (error) {
        reject(error)
        return
      }
      resolve(derived)
    })
  })
}

/**
 * A working stand-in for `Bun.password`, which does not exist off Bun.
 *
 * Deliberately a real hasher rather than a throwing stub. A stub that throws
 * forces every app test touching a password into hand-writing its own hasher
 * double, and a hand-written double is a copy of a contract that no type
 * constrains - which is how a `verify(plain, hashed)` inversion once shipped
 * with a green suite, the double having encoded the same inversion.
 *
 * The output format matches `hashPassword()`'s `$scrypt$N=...,r=...,p=1$salt$hash`,
 * so the framework's real `verifyPassword()` can read it back; the cost
 * parameter is lowered for test speed and read from the hash on verify.
 *
 * `verify` throws on a hash it cannot parse, exactly as `Bun.password.verify`
 * does. Returning `false` there would make a swapped call look like a wrong
 * password in tests while it is a 500 in production.
 */
function createTestPasswordApi() {
  return {
    async hash(password: string): Promise<string> {
      const salt = randomBytes(TEST_SALT_LENGTH)
      const derived = await deriveScrypt(
        password,
        salt,
        TEST_KEY_LENGTH,
        TEST_SCRYPT_COST,
        TEST_SCRYPT_BLOCK_SIZE,
      )
      const params = `N=${TEST_SCRYPT_COST},r=${TEST_SCRYPT_BLOCK_SIZE},p=1`
      return `$scrypt$${params}$${salt.toString('base64')}$${derived.toString('base64')}`
    },

    async verify(password: string, hashed: string): Promise<boolean> {
      const parts = hashed.split('$')
      if (parts.length !== 5 || parts[1] !== 'scrypt') {
        throw new Error(
          `Password verification failed with error "UnsupportedAlgorithm"`,
        )
      }

      const params: Record<string, number> = {}
      for (const pair of parts[2].split(',')) {
        const [key, value] = pair.split('=')
        params[key] = Number.parseInt(value, 10)
      }

      const salt = Buffer.from(parts[3], 'base64')
      const expected = Buffer.from(parts[4], 'base64')
      const derived = await deriveScrypt(
        password,
        salt,
        expected.length,
        params.N,
        params.r,
      )

      return derived.length === expected.length && timingSafeEqual(derived, expected)
    },
  }
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
      password: createTestPasswordApi(),
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
