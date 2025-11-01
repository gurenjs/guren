import { afterEach, beforeEach, vi } from 'vitest'
import type { PropsWithChildren, ReactElement } from 'react'
import { createInertiaReactMock, resetInertiaPage } from './inertia'

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
      password: {
        async hash() {
          throw new Error(
            'Bun.password.hash is not available in this test environment.',
          )
        },
        async verify() {
          throw new Error(
            'Bun.password.verify is not available in this test environment.',
          )
        },
      },
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
