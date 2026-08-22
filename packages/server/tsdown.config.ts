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

// tsdown defaults cover format (esm), outDir (dist), clean and platform
// (node). rolldown always shares chunks between entries, and this package
// depends on that: the job registry, mail manager and queue driver are
// module-level state, so a copy per entry would make registerJob via the
// root entry invisible to a Worker imported via ./queue.
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
  // The root tsconfig promises ES2022 output; without a target tsdown lowers
  // no syntax (it reads engines.node, which no package declares).
  target: 'es2022',
  // The exports map names dist/*.js; tsdown would emit .mjs on node.
  fixedExtension: false,
  // Declarations come from `tsc -p tsconfig.build.json` (see the build
  // script): unbundled, one .d.ts per module, which keeps the MCP SDK types
  // behind the ./mcp subpath instead of in one root bundle.
  dts: false,
  deps: { neverBundle: sharedExternal },
})
