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
  cached ??= siblingEntry('bin') ?? fileURLToPath(import.meta.resolve('@guren/cli/bin'))
  return cached
}

/** `<name>.js` beside this module in dist, `<name>.ts` beside it from source; undefined when neither exists. */
export function siblingEntry(name: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  return [`${name}.js`, `${name}.ts`].map((file) => join(here, file)).find((candidate) => existsSync(candidate))
}
