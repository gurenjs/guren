export type LifecycleHookFn = (fn: () => void | Promise<void>) => void

/**
 * Test-runner lifecycle hooks used by helpers that register per-test setup,
 * such as `useDatabaseTransactions()` and `useTruncateTables()`.
 */
export interface TestLifecycleHooks {
  beforeEach: LifecycleHookFn
  afterEach: LifecycleHookFn
}

let registeredHooks: TestLifecycleHooks | null = null

/**
 * Register the lifecycle hooks of the active test runner.
 *
 * Importing `@guren/testing/vitest` does this automatically for vitest.
 * Under bun:test the global `beforeEach`/`afterEach` are picked up without
 * registration.
 */
export function setTestLifecycleHooks(hooks: TestLifecycleHooks): void {
  registeredHooks = hooks
}

/**
 * Resolve the lifecycle hooks to use: explicitly registered hooks first,
 * then runner-injected globals (bun:test always, vitest with `globals: true`).
 */
export function getTestLifecycleHooks(): TestLifecycleHooks {
  if (registeredHooks) {
    return registeredHooks
  }

  const globals = globalThis as Record<string, unknown>
  if (
    typeof globals.beforeEach === 'function' &&
    typeof globals.afterEach === 'function'
  ) {
    return {
      beforeEach: globals.beforeEach as LifecycleHookFn,
      afterEach: globals.afterEach as LifecycleHookFn,
    }
  }

  throw new Error(
    'Test lifecycle hooks are not available. In vitest, import ' +
      "'@guren/testing/vitest' once in your test setup (or enable globals); " +
      'bun:test injects the required globals automatically. Alternatively, ' +
      'pass { beforeEach, afterEach } to the helper explicitly.'
  )
}
