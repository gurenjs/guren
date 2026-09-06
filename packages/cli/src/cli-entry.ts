import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let cached: string | undefined

/**
 * The CLI entry to spawn: `dist/bin.js` beside a built module, `src/bin.ts` beside
 * this one from source (the `./bin` export maps only to dist, so `import.meta.resolve`
 * cannot serve a test run from src). Self-resolving needs no linked `.bin/guren`:
 * `bun x guren` hits the npm registry, where the package does not exist.
 */
export function cliEntry(): string {
  if (cached) return cached
  const here = dirname(fileURLToPath(import.meta.url))
  for (const name of ['bin.js', 'bin.ts']) {
    const candidate = join(here, name)
    if (existsSync(candidate)) return (cached = candidate)
  }
  return (cached = fileURLToPath(import.meta.resolve('@guren/cli/bin')))
}
