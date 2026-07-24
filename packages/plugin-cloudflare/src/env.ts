let workersEnv: unknown
let captured = false

/** First call wins; later calls are ignored (never overwrite a live env). */
export function captureWorkersEnv(env: unknown): void {
  if (captured) {
    return
  }
  workersEnv = env
  captured = true
}

/** Throws with a clear message if called before the first request captured env. */
export function getWorkersEnv<E = unknown>(): E {
  if (!captured) {
    throw new Error(
      'getWorkersEnv() was called before the first request captured the Workers env. ' +
        'Defer access behind a closure instead of reading it at module scope, ' +
        'e.g. binding: () => getWorkersEnv<Env>().DB',
    )
  }
  return workersEnv as E
}

/** Clears the holder. Used by createWorkersHandler on boot failure and by tests. */
export function resetWorkersEnv(): void {
  workersEnv = undefined
  captured = false
}
