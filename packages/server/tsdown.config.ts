import { defineConfig } from 'tsdown'

const sharedExternal = [
  'bun:sqlite',
  'drizzle-orm/bun-sqlite',
  'drizzle-orm/bun-sqlite/migrator',
  '@aws-sdk/client-sqs',
  '@modelcontextprotocol/sdk',
  '@guren/cli',
  '@guren/orm',
  'zod',
]

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/auth/index.ts',
    'src/authorization/index.ts',
    'src/broadcasting/index.ts',
    'src/cache/index.ts',
    'src/encryption/index.ts',
    'src/events/index.ts',
    'src/health/index.ts',
    'src/i18n/index.ts',

    'src/logging/index.ts',
    'src/mail/index.ts',
    'src/notifications/index.ts',
    'src/queue/index.ts',
    'src/redis/index.ts',
    'src/runtime/index.ts',
    'src/scheduling/index.ts',
    'src/storage/index.ts',
    'src/vite/index.ts',
    'src/lambda/index.ts',
    'src/mcp/index.ts',
    // Not public API: @guren/core's database stores re-export the expiry
    // rules from here so the two packages cannot drift apart.
    'src/support/expiry.ts',
  ],
  format: ['esm'],
  platform: 'node',
  // Multiple entry points MUST share chunks (tsdown's default): with every
  // entry bundling its own copy of module-level state (job registry, mail
  // manager global, queue driver global), state set through one entry is
  // invisible through another (e.g. registerJob via the root entry + Worker
  // via ./queue never saw each other's registry).
  // Declarations come from `tsc -p tsconfig.build.json` (see the build
  // script), not from the bundler.
  dts: false,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
  deps: { neverBundle: sharedExternal },
})
