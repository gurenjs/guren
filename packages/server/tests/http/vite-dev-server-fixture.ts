import { mock } from 'bun:test'

import * as realViteDevServer from '../../src/http/vite-dev-server'
import type { ActiveViteDevServer, GurenGlobalSlots } from '../../src/http/Application'

/**
 * Shared setup for the `Application` tests that stub the managed Vite dev
 * server. What they each need is a stand-in `startViteDevServer`, a view of the
 * ambient `__guren*` slots loose enough to hold fake servers, and a way to
 * clear those slots between tests.
 *
 * The `mock.module()` call itself deliberately stays at each call site. When it
 * runs, relative to the imports around it, is the part of this setup most
 * likely to matter; moving it here would hide that ordering behind an import.
 */

/**
 * The test-side view of {@link GurenGlobalSlots}: the slot names come from the
 * one declaration in `Application.ts`, so a misspelled slot in a test does not
 * compile, while the values widen to `unknown` because these tests plant plain
 * objects where the runtime keeps real Bun and Vite servers.
 */
type GurenTestGlobal = typeof globalThis & {
  [Slot in keyof GurenGlobalSlots]?: unknown
}

export const gurenGlobals = globalThis as GurenTestGlobal

/**
 * Clear every slot Guren plants on `globalThis`, so one test's leftover server
 * cannot be picked up as another's "previous run".
 *
 * Swept by prefix rather than by a list of names: the list would be one more
 * copy of the contract this fixture exists to keep in a single place, and it
 * would go stale silently. `__guren*` on `globalThis` is Guren's alone —
 * `__gurenInertia`, the one other name in this family, lives on response
 * objects rather than the global.
 *
 * A plain function, not a `beforeEach` of its own: the callers register their
 * hooks at different levels, and hook order across files is not something this
 * fixture should be quietly deciding.
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
 * Plant the active-server slot the way a previous `bun --hot` incarnation
 * leaves it. The record's owner is an application from the module instance the
 * reload replaced, so nothing in this run can equal it — which is the point:
 * the adopting app has to take ownership rather than share it.
 */
export function seedPreviousViteDevServer(server: unknown, localUrl: string): void {
  gurenGlobals.__gurenActiveViteDevServer = {
    server,
    localUrl,
    owner: {},
    disposeTeardown: () => {},
  }
}

/**
 * Read the slot back with the record's real shape, for assertions on what a
 * `listen()` or `stop()` left behind.
 */
export function activeViteDevServer(): ActiveViteDevServer | undefined {
  return gurenGlobals.__gurenActiveViteDevServer as ActiveViteDevServer | undefined
}

/**
 * The process listener counts the teardown assertions compare: one snapshot
 * before `listen()`, one after each transition.
 */
export function signalListenerCounts(): { exit: number; sigint: number; sigterm: number } {
  return {
    exit: process.listenerCount('exit'),
    sigint: process.listenerCount('SIGINT'),
    sigterm: process.listenerCount('SIGTERM'),
  }
}

/**
 * Build the Vite dev server mocks and the module body that installs them.
 *
 * `moduleFactory()` spreads the module and overrides only `startViteDevServer`:
 * Bun shares one module registry across test files, so replacing it wholesale
 * would strip its other exports for every test that loads it afterwards. The
 * reuse test pins this by reading back what `mock.module()` installed.
 */
export function createViteDevServerMocks() {
  const viteClose = mock(async () => {})

  const startViteDevServer = mock(async () => ({
    server: {
      close: viteClose,
      // A server that just started is listening. Tests that need the other
      // answer plant their own `__gurenActiveViteDevServer` instead of
      // reshaping this one.
      httpServer: { listening: true },
    },
    // Spelled out again in the callers' assertions on purpose: a test that
    // imported this value would compare the fixture against itself and stay
    // green whatever it published.
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
