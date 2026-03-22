import { defineConfig } from 'tsup'

const sharedExternal = [
  'bun:sqlite',
  'drizzle-orm/bun-sqlite',
  'drizzle-orm/bun-sqlite/migrator',
  '@aws-sdk/client-sqs',
  '@modelcontextprotocol/sdk',
  '@guren/cli',
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
    'src/runtime/index.ts',
    'src/scheduling/index.ts',
    'src/storage/index.ts',
    'src/vite/index.ts',
    'src/lambda/index.ts',
    'src/mcp/index.ts',
  ],
  format: ['esm'],
  splitting: false,
  dts: { only: false },
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
  external: sharedExternal,
})
