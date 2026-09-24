/**
 * Test-only helpers for the hot-reload registry. Not reachable from any tsdown
 * entry point, so it never ships.
 */

/**
 * Runs `callback` with the registry's `--hot` guard satisfied. The guard reads
 * `process.execArgv`, which is also how the real thing detects `bun --hot`. A
 * callback returning a promise keeps the flag until that promise settles.
 */
export function withHotRuntime<T>(callback: () => T): T {
  process.execArgv.push('--hot')
  const leave = () => {
    const index = process.execArgv.lastIndexOf('--hot')
    if (index !== -1) process.execArgv.splice(index, 1)
  }

  let result: T
  try {
    result = callback()
  } catch (error) {
    leave()
    throw error
  }

  if (result instanceof Promise) {
    return result.finally(leave) as T
  }
  leave()
  return result
}
