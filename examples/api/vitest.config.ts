import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(fileURLToPath(import.meta.url))
const resolveFromRoot = (...paths: string[]) => resolve(rootDir, ...paths)

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@guren\/testing$/,
        replacement: resolveFromRoot('../../packages/testing/src/index.ts'),
      },
      {
        find: /^@guren\/testing\/(.+)$/,
        replacement: `${resolveFromRoot('../../packages/testing/src')}/$1`,
      },
      {
        find: /^@guren\/core$/,
        replacement: resolveFromRoot('../../packages/core/src/index.ts'),
      },
      {
        find: /^@guren\/core\/(.+)$/,
        replacement: `${resolveFromRoot('../../packages/core/src')}/$1`,
      },
      // `@guren/core`'s index re-exports the server wholesale, so without these
      // the suite runs core from src and the server from dist. The generic form
      // appends no '.ts': a subpath may name a file or a directory.
      {
        find: /^@guren\/server$/,
        replacement: resolveFromRoot('../../packages/server/src/index.ts'),
      },
      {
        find: /^@guren\/server\/(.+)$/,
        replacement: `${resolveFromRoot('../../packages/server/src')}/$1`,
      },
      {
        find: /^@guren\/orm$/,
        replacement: resolveFromRoot('../../packages/orm/src/index.ts'),
      },
      // First match wins, so these must stay above the generic orm rule. Pinned
      // because 'src/drizzle.ts' and the 'src/drizzle/' directory coexist.
      {
        find: /^@guren\/orm\/drizzle$/,
        replacement: resolveFromRoot('../../packages/orm/src/drizzle.ts'),
      },
      {
        find: /^@guren\/orm\/drizzle\/(.+)$/,
        replacement: resolveFromRoot('../../packages/orm/src/drizzle/$1.ts'),
      },
      {
        find: /^@guren\/orm\/(.+)$/,
        replacement: `${resolveFromRoot('../../packages/orm/src')}/$1`,
      },
      {
        find: /^@guren\/inertia-client$/,
        replacement: resolveFromRoot('../../packages/inertia-client/src/index.ts'),
      },
      {
        find: /^@guren\/inertia-client\/(.+)$/,
        replacement: `${resolveFromRoot('../../packages/inertia-client/src')}/$1`,
      },
      {
        find: /^@guren\/cli$/,
        replacement: resolveFromRoot('../../packages/cli/src/index.ts'),
      },
      {
        find: /^@guren\/cli\/(.+)$/,
        replacement: `${resolveFromRoot('../../packages/cli/src')}/$1`,
      },
      {
        find: /^bun:sqlite$/,
        replacement: resolveFromRoot('./tests/support/bun-sqlite.ts'),
      },
      {
        find: /^guren$/,
        replacement: resolveFromRoot('../../packages/core/src/index.ts'),
      },
      {
        find: /^guren\/(.+)$/,
        replacement: `${resolveFromRoot('../../packages/core/src')}/$1`,
      },
    ],
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['./tests/setup.ts'],
    server: {
      deps: {
        inline: ['@guren/core', '@guren/orm', '@guren/testing'],
      },
    },
  },
})
