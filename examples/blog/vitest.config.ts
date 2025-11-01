import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const rootDir = dirname(fileURLToPath(import.meta.url))
const resolveFromRoot = (...paths: string[]) => resolve(rootDir, ...paths)
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
      { find: '@', replacement: resolveFromRoot('app') },
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
        find: '@guren/testing',
        replacement: resolve(rootDir, '../../packages/testing/src/index.ts'),
      },
      {
        find: 'guren',
        replacement: resolve(rootDir, '../../packages/core/src/index.ts'),
      },
      {
        find: 'guren/',
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
