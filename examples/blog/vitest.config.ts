import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const rootDir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const reactEntry = require.resolve('react')
const reactDomEntry = require.resolve('react-dom')
const reactJsxRuntimeEntry = require.resolve('react/jsx-runtime')
const reactJsxDevRuntimeEntry = require.resolve('react/jsx-dev-runtime')
const reactDomClientEntry = require.resolve('react-dom/client')

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: [
      { find: '@', replacement: rootDir },
      {
        find: /^react$/,
        replacement: reactEntry,
      },
      {
        find: /^react-dom$/,
        replacement: reactDomEntry,
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: reactJsxRuntimeEntry,
      },
      {
        find: /^react\/jsx-dev-runtime$/,
        replacement: reactJsxDevRuntimeEntry,
      },
      {
        find: /^react-dom\/client$/,
        replacement: reactDomClientEntry,
      },
      {
        find: /^@guren\/testing\/vitest$/,
        replacement: resolve(rootDir, '../../packages/testing/src/vitest.ts'),
      },
      {
        find: /^@guren\/testing$/,
        replacement: resolve(rootDir, '../../packages/testing/src/index.ts'),
      },
      {
        find: /^@guren\/testing\//,
        replacement: resolve(rootDir, '../../packages/testing/src/'),
      },
      {
        find: /^@guren\/core$/,
        replacement: resolve(rootDir, '../../packages/core/src/index.ts'),
      },
      {
        find: /^@guren\/core\//,
        replacement: resolve(rootDir, '../../packages/core/src/'),
      },
      {
        find: /^@guren\/server$/,
        replacement: resolve(rootDir, '../../packages/server/src/index.ts'),
      },
      // Capture the subpath and restore the separator. The prefix form the
      // sibling rules still use consumes the separator without putting it
      // back — `resolve()` normalizes the replacement's trailing slash away —
      // so `@guren/server/internal/request` became '.../server/srcinternal/
      // request'. `support/expiry` used to need an exact-match entry above
      // this one for that reason; this form needs none. `web/vitest.config.ts`
      // has always aliased the server tree this way.
      {
        find: /^@guren\/server\/(.+)$/,
        replacement: `${resolve(rootDir, '../../packages/server/src')}/$1`,
      },
      {
        find: /^@guren\/orm$/,
        replacement: resolve(rootDir, '../../packages/orm/src/index.ts'),
      },
      {
        find: /^@guren\/orm\/drizzle$/,
        replacement: resolve(rootDir, '../../packages/orm/src/drizzle.ts'),
      },
      {
        find: /^@guren\/orm\/drizzle\/(.+)$/,
        replacement: resolve(rootDir, '../../packages/orm/src/drizzle/$1.ts'),
      },
      {
        find: /^@guren\/orm\//,
        replacement: resolve(rootDir, '../../packages/orm/src/'),
      },
      {
        find: /^@guren\/inertia-client$/,
        replacement: resolve(rootDir, '../../packages/inertia-client/src/index.ts'),
      },
      {
        find: /^@guren\/inertia-client\//,
        replacement: resolve(rootDir, '../../packages/inertia-client/src/'),
      },
      {
        find: /^@guren\/cli$/,
        replacement: resolve(rootDir, '../../packages/cli/src/index.ts'),
      },
      {
        find: /^@guren\/cli\//,
        replacement: resolve(rootDir, '../../packages/cli/src/'),
      },
      {
        find: /^bun:sqlite$/,
        replacement: resolve(rootDir, './tests/support/bun-sqlite.ts'),
      },
      {
        find: /^guren$/,
        replacement: resolve(rootDir, '../../packages/core/src/index.ts'),
      },
      {
        find: /^guren\//,
        replacement: resolve(rootDir, '../../packages/core/src/'),
      },
    ],
    dedupe: ['react', 'react-dom'],
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    server: {
      deps: {
        inline: ['@testing-library/react', '@inertiajs/react', 'react', 'react-dom'],
      },
    },
  },
})
