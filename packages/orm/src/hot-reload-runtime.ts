/**
 * `bun --hot` re-runs the module graph in-process: module-level state resets
 * while `globalThis` survives, so state parked there has to tell a
 * re-evaluation from a new participant. `bun --watch` restarts the process
 * instead, and this answers for no other in-process re-evaluator (a Vite SSR
 * runner, `vi.resetModules()`). Twin of
 * `packages/server/src/hot-reload/hot-disposables.ts` — keep the two in step.
 */
export function isHotReloadRuntime(): boolean {
  return typeof process !== 'undefined' && Array.isArray(process.execArgv) && process.execArgv.includes('--hot')
}
