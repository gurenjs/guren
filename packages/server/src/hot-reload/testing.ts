/**
 * Test-only helpers for the hot-reload registry.
 *
 * Not reachable from any tsdown entry point, so it never ships — it lives beside
 * the code it exercises because both test files in this directory need it and
 * `@guren/server` has no shared test-support module.
 */

/**
 * Runs `callback` with the registry's `--hot` guard satisfied.
 *
 * The guard reads `process.execArgv`, which is also how the real thing detects
 * `bun --hot`; there is no flag or injection seam to prefer over it.
 */
export function withHotRuntime<T>(callback: () => T): T {
  process.execArgv.push('--hot')
  try {
    return callback()
  } finally {
    process.execArgv.splice(process.execArgv.indexOf('--hot'), 1)
  }
}
