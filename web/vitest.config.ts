import path from 'node:path'
import { defineConfig } from 'vitest/config'

const rootDir = __dirname
const resolveFromRoot = (...paths: string[]) => path.resolve(rootDir, ...paths)

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: rootDir },
      { find: /^@guren\/testing$/, replacement: resolveFromRoot('../packages/testing/src/index.ts') },
      { find: /^@guren\/testing\//, replacement: resolveFromRoot('../packages/testing/src/') },
      { find: /^@guren\/server$/, replacement: resolveFromRoot('../packages/server/src/index.ts') },
      // Exact match must precede the prefix rule below, which consumes the
      // separator without restoring it and would yield 'srcsupport/expiry'.
      {
        find: /^@guren\/server\/support\/expiry$/,
        replacement: resolveFromRoot('../packages/server/src/support/expiry.ts'),
      },
      { find: /^@guren\/server\//, replacement: resolveFromRoot('../packages/server/src/') },
      { find: /^@guren\/core$/, replacement: resolveFromRoot('../packages/core/src/index.ts') },
      { find: /^@guren\/core\//, replacement: resolveFromRoot('../packages/core/src/') },
      { find: /^@guren\/orm$/, replacement: resolveFromRoot('../packages/orm/src/index.ts') },
      {
        find: /^@guren\/orm\/drizzle\/(.+)$/,
        replacement: resolveFromRoot('../packages/orm/src/drizzle/$1.ts'),
      },
      { find: /^@guren\/orm\//, replacement: resolveFromRoot('../packages/orm/src/') },
      { find: /^@guren\/plugin-cloudflare$/, replacement: resolveFromRoot('../packages/plugin-cloudflare/src/index.ts') },
      { find: /^guren$/, replacement: resolveFromRoot('../packages/core/src/index.ts') },
      { find: /^guren\//, replacement: resolveFromRoot('../packages/core/src/') },
    ],
  },
  test: {
    environment: 'node',
    // Every test here runs in single-digit milliseconds except the two that
    // reach live shiki — FsDocsStore.getRendered and HomeController.index,
    // which take the live-highlighting path because shouldUsePrerendered() is
    // false outside production. Loading the WASM regex engine, the themes and
    // one grammar per fenced language costs ~1.2s on its own, ~2s under normal
    // full-suite contention and ~4s on an otherwise loaded machine, so the 5s
    // default sits just above a cold shiki start and flakes under load.
    testTimeout: 30_000,
  },
})
