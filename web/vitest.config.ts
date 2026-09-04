import path from 'node:path'
import { defineConfig } from 'vitest/config'

const rootDir = __dirname
const resolveFromRoot = (...paths: string[]) => path.resolve(rootDir, ...paths)

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: rootDir },
      // Each subpath rule re-appends the captured path itself: path.resolve()
      // strips trailing slashes, so a bare prefix-replacement silently yields
      // src<subpath> with no separator. Extensionless on purpose, so vite
      // resolves both `src/foo.ts` and `src/foo/index.ts`.
      { find: /^@guren\/testing$/, replacement: resolveFromRoot('../packages/testing/src/index.ts') },
      { find: /^@guren\/testing\/(.+)$/, replacement: resolveFromRoot('../packages/testing/src') + '/$1' },
      { find: /^@guren\/server$/, replacement: resolveFromRoot('../packages/server/src/index.ts') },
      { find: /^@guren\/server\/(.+)$/, replacement: resolveFromRoot('../packages/server/src') + '/$1' },
      { find: /^@guren\/core$/, replacement: resolveFromRoot('../packages/core/src/index.ts') },
      { find: /^@guren\/core\/(.+)$/, replacement: resolveFromRoot('../packages/core/src') + '/$1' },
      { find: /^@guren\/orm$/, replacement: resolveFromRoot('../packages/orm/src/index.ts') },
      { find: /^@guren\/orm\/(.+)$/, replacement: resolveFromRoot('../packages/orm/src') + '/$1' },
      { find: /^@guren\/plugin-cloudflare$/, replacement: resolveFromRoot('../packages/plugin-cloudflare/src/index.ts') },
      { find: /^guren$/, replacement: resolveFromRoot('../packages/core/src/index.ts') },
      { find: /^guren\/(.+)$/, replacement: resolveFromRoot('../packages/core/src') + '/$1' },
    ],
  },
  test: {
    environment: 'node',
    // Two tests reach live shiki (FsDocsStore.getRendered, HomeController.index;
    // shouldUsePrerendered() is false outside production). A cold shiki start
    // costs ~1.2s alone, ~2s under full-suite contention and ~4s on a loaded
    // machine, so the 5s default sits just above it and flakes.
    testTimeout: 30_000,
  },
})
