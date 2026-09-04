import { mock } from 'bun:test'

import * as realViteDevServer from '../../src/http/vite-dev-server'
import type { ActiveViteDevServer, GurenGlobalSlots } from '../../src/http/Application'

/**
 * Shared setup for the `Application` tests that stub the managed Vite dev server.
 * The `mock.module()` call stays at each call site: when it runs relative to the
 * imports around it matters, and moving it here would hide that ordering.
 */

/**
 * The test-side view of {@link GurenGlobalSlots}: names come from the declaration in
 * `Application.ts` so a misspelling does not compile, while the values widen to
 * `unknown` because these tests plant plain objects in place of real servers.
 */
type GurenTestGlobal = typeof globalThis & {
  [Slot in keyof GurenGlobalSlots]?: unknown
}

export const gurenGlobals = globalThis as GurenTestGlobal

/**
 * Clear every slot Guren plants on `globalThis`, so one test's leftover server is
 * not picked up as another's "previous run". Swept by prefix, since a name list
 * would go stale silently; `__guren*` on `globalThis` is Guren's alone. A plain
 * function rather than a `beforeEach`, so this fixture does not decide hook order
 * for callers that register at different levels.
 */
export function resetGurenGlobals(): void {
  const slots = globalThis as Record<string, unknown>

  for (const key of Object.keys(slots)) {
    if (key.startsWith('__guren')) {
      delete slots[key]
    }
  }
}

/**
 * Plant the active-server slot the way a previous `bun --hot` incarnation leaves
 * it: the record's owner is from the replaced module instance, so nothing in this
 * run can equal it and the adopting app has to take ownership.
 */
export function seedPreviousViteDevServer(server: unknown, localUrl: string): void {
  gurenGlobals.__gurenActiveViteDevServer = {
    server,
    localUrl,
    owner: {},
    disposeTeardown: () => {},
  }
}

/** Read the slot back with the record's real shape. */
export function activeViteDevServer(): ActiveViteDevServer | undefined {
  return gurenGlobals.__gurenActiveViteDevServer as ActiveViteDevServer | undefined
}

/** The process listener counts the teardown assertions compare. */
export function signalListenerCounts(): { exit: number; sigint: number; sigterm: number } {
  return {
    exit: process.listenerCount('exit'),
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
  }
}

/**
 * `moduleFactory()` spreads the module and overrides only `startViteDevServer`:
 * Bun shares one module registry across test files, so replacing it wholesale
 * strips its other exports for every test that loads it afterwards.
 */
export function createViteDevServerMocks() {
  const viteClose = mock(async () => {})

  const startViteDevServer = mock(async () => ({
    server: {
      close: viteClose,
      // Tests that need a non-listening server plant their own
      // `__gurenActiveViteDevServer` rather than reshaping this one.
      httpServer: { listening: true },
    },
    // Spelled out again in the callers' assertions: a test importing this value
    // would compare the fixture against itself.
    localUrl: 'http://localhost:5174',
    networkUrls: [] as string[],
  }))

  return {
    viteClose,
    startViteDevServer,
    moduleFactory: () => ({ ...realViteDevServer, startViteDevServer }),
    clear: () => {
      viteClose.mockClear()
      startViteDevServer.mockClear()
    },
  }
}
