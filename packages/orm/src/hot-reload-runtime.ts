/**
 * `bun --hot` re-runs the module graph in-process: module-level state resets
 * while `globalThis` survives. Anything parked on `globalThis` to outlive a
 * reload has to tell that re-evaluation apart from a genuinely new participant,
 * and this is the one signal that says which mode the process is in.
 * `bun --watch` restarts the process instead, so `--hot` is the only one.
 */
export function isHotReloadRuntime(): boolean {
  return typeof process !== 'undefined' && Array.isArray(process.execArgv) && process.execArgv.includes('--hot')
}
