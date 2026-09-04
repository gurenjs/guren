/**
 * Test-only helpers for the hot-reload registry. Not reachable from any tsdown
 * entry point, so it never ships.
 */

/**
 * Runs `callback` with the registry's `--hot` guard satisfied. The guard reads
 * `process.execArgv`, which is also how the real thing detects `bun --hot`.
 */
export function withHotRuntime<T>(callback: () => T): T {
  process.execArgv.push('--hot')
  try {
    return callback()
  } finally {
    process.execArgv.splice(process.execArgv.indexOf('--hot'), 1)
  }
}
