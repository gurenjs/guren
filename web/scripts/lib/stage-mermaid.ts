/**
 * Stage the mermaid bundle into `web/public/`, shared by the docs pages and
 * the docs-viewer snapshot, whose shell requests a fixed framework path.
 * Copying it twice would ship ~3.4 MB of identical bytes to Workers Static
 * Assets and leave two places to bump.
 *
 * Deliberately not `public/assets/`: `scripts/smoke/build-budget.ts` caps any
 * file in the client bundle's output tree at 600 kB, which mermaid cannot meet.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('../..', import.meta.url))

/** Path under `public/`. Keep in step with MERMAID_SCRIPT_SRC in Docs/Show.tsx. */
export const MERMAID_PUBLIC_PATH = '_guren/docs/assets/mermaid.js'

export function mermaidTargetPath(): string {
  return resolve(webRoot, 'public', MERMAID_PUBLIC_PATH)
}

/**
 * Copy the installed bundle into place, skipping the write when the staged copy
 * already matches: the callers sit on `prerender:stub`, which `dev`, `codegen`,
 * `typecheck` and `test` all chain.
 */
export function stageMermaid(): { path: string; copied: boolean } {
  const source = createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js')
  const target = mermaidTargetPath()

  const from = statSync(source)
  const current = existsSync(target) ? statSync(target) : null
  if (current && current.size === from.size && current.mtimeMs >= from.mtimeMs) {
    return { path: target, copied: false }
  }

  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
  return { path: target, copied: true }
}
