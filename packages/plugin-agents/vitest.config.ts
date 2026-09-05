import { SQL_CLIENT_MODULES } from '@guren/core/internal/deploy-build'
import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

/**
 * The workerd lane, on its own runner because `import { Agent } from 'agents'`
 * evaluates `cloudflare:workers` at module load.
 *
 * `include` names exactly the `*.workers.ts` files and `bun test` discovers
 * only `*.test.ts`: the two runners must never pick up each other's files.
 */

/** A Node-only dependency a Worker can never reach. */
const UNREACHABLE = new URL('./tests/workers/stubs/unreachable.ts', import.meta.url).pathname

/**
 * Modules the fixture worker must not load.
 *
 * The app's graph names its mail, cache and database drivers statically. A real
 * Workers bundle drops them, but Vite's SSR transform follows every static
 * import, so the fixture dies in a CJS shim running `require('node:os')`.
 */
const UNREACHABLE_MODULES = [
  ...SQL_CLIENT_MODULES.map((module) => module.specifier),
  'nodemailer',
  'ioredis',
]

/**
 * This package's own name, which nothing links into `node_modules`.
 *
 * The *generated* worker imports these subpaths the way a deployed app's would,
 * while the fixture's own sources reach the same files relatively — so both
 * spellings land on one `latch.ts`, which is the seam's whole premise.
 */
const SELF_SUBPATHS: Record<string, string> = {
  '@guren/plugin-agents/runtime': './src/runtime.ts',
  '@guren/plugin-agents/agent': './src/agent.ts',
  '@guren/plugin-agents': './src/index.ts',
}

function exactly(specifier: string): RegExp {
  return new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}$`)
}

export default defineConfig({
  resolve: {
    alias: [
      ...Object.entries(SELF_SUBPATHS).map(([specifier, target]) => ({
        find: exactly(specifier),
        replacement: new URL(target, import.meta.url).pathname,
      })),
      ...UNREACHABLE_MODULES.map((specifier) => ({
        find: exactly(specifier),
        replacement: UNREACHABLE,
      })),
    ],
  },
  plugins: [
    cloudflareTest({
      // The fixture app's own committed config: `main` is the generated worker,
      // and the Durable Object bindings and the SQLite migration are read from
      // there rather than duplicated here.
      wrangler: { configPath: './tests/workers/app/wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/workers/**/*.workers.ts'],
  },
})
