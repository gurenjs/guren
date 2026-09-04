/**
 * The Workers env holder, published as `@guren/plugin-cloudflare/env`.
 *
 * **This module must stay import-free.** It is what application code reaches for
 * at runtime, while the package root also re-exports `buildCloudflareOutput` and
 * pulls `node:fs`, `node:path` and the deploy generator behind it — importing
 * these names from the root drags that into the route graph and the wrangler
 * bundle. The root keeps re-exporting them for compatibility;
 * `tests/lean-env-subpath.test.ts` holds the boundary.
 */

// Wrapper object distinguishes "never captured" from "captured undefined".
let holder: { env: unknown } | undefined

/** First call wins; later calls are ignored (never overwrite a live env). */
export function captureWorkersEnv(env: unknown): void {
  holder ??= { env }
}

/** Throws with a clear message if called before the first request captured env. */
export function getWorkersEnv<E = unknown>(): E {
  if (!holder) {
    throw new Error(
      'getWorkersEnv() was called before the first request captured the Workers env. ' +
        'Defer access behind a closure instead of reading it at module scope, ' +
        'e.g. binding: () => getWorkersEnv<Env>().DB',
    )
  }
  return holder.env as E
}

/** Clears the holder. Used by createWorkersHandler on boot failure and by tests. */
export function resetWorkersEnv(): void {
  holder = undefined
}
