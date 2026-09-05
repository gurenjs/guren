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

export default defineConfig({
  resolve: {
    alias: UNREACHABLE_MODULES.map((specifier) => ({
      find: new RegExp(`^${specifier.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&')}$`),
      replacement: UNREACHABLE,
    })),
  },
  plugins: [
    cloudflareTest({
      // The Durable Object bindings and the SQLite migration are read from the
      // wrangler config rather than duplicated here.
      wrangler: { configPath: './tests/workers/wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['tests/workers/**/*.workers.ts'],
  },
})
