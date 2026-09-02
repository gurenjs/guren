/**
 * The Workers env holder, published as `@guren/plugin-cloudflare/env`.
 *
 * **This module must stay import-free.** It is the one thing *application*
 * code reaches for at runtime — a scaffolded controller resolving a binding,
 * the OAuth consent screen reading `env.OAUTH_PROVIDER` — and the package's
 * root entry re-exports `buildCloudflareOutput`, which pulls `node:fs`,
 * `node:path` and the whole deploy generator behind it. An app importing
 * `getWorkersEnv` from the root therefore drags the build tooling into its
 * route graph on every `bun run dev` boot and into the wrangler bundle on
 * every deploy, for three functions that need nothing at all.
 *
 * The root keeps re-exporting these names, so nothing that already imports
 * them from there breaks. New application code should import from this
 * subpath; `tests/lean-env-subpath.test.ts` holds that boundary, and the
 * scaffolded consent controller is checked against it by name.
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
