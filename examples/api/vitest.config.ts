import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = dirname(fileURLToPath(import.meta.url))
const resolveFromRoot = (...paths: string[]) => resolve(rootDir, ...paths)

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@guren\/testing\/controller$/,
        replacement: resolveFromRoot('../../packages/testing/src/controller.ts'),
      },
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
      // `@guren/core`'s index re-exports the server package wholesale, so
      // without these two the suite runs core from src while the server it
      // re-exports comes from dist. The generic form deliberately does not
      // append '.ts': a subpath may name a file ('internal/route-path') or a
      // directory resolved by index ('vite').
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
