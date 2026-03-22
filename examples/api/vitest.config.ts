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
        find: /^@guren\/testing\//,
        replacement: resolveFromRoot('../../packages/testing/src/'),
      },
      {
        find: /^@guren\/core$/,
        replacement: resolveFromRoot('../../packages/core/src/index.ts'),
      },
      {
        find: /^@guren\/core\//,
        replacement: resolveFromRoot('../../packages/core/src/'),
      },
      {
        find: /^@guren\/core$/,
        replacement: resolveFromRoot('../../packages/core/src/index.ts'),
      },
      {
        find: /^@guren\/core\//,
        replacement: resolveFromRoot('../../packages/core/src/'),
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
        find: /^@guren\/orm\//,
        replacement: resolveFromRoot('../../packages/orm/src/'),
      },
      {
        find: /^@guren\/inertia-client$/,
        replacement: resolveFromRoot('../../packages/inertia-client/src/index.ts'),
      },
      {
        find: /^@guren\/inertia-client\//,
        replacement: resolveFromRoot('../../packages/inertia-client/src/'),
      },
      {
        find: /^@guren\/cli$/,
        replacement: resolveFromRoot('../../packages/cli/src/index.ts'),
      },
      {
        find: /^@guren\/cli\//,
        replacement: resolveFromRoot('../../packages/cli/src/'),
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
        find: /^guren\//,
        replacement: resolveFromRoot('../../packages/core/src/'),
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
        inline: ['@guren/core', '@guren/orm', '@guren/core', '@guren/testing'],
      },
    },
  },
})
