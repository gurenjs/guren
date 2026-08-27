import path from 'node:path'
import { defineConfig } from 'vitest/config'

const rootDir = __dirname
const resolveFromRoot = (...paths: string[]) => path.resolve(rootDir, ...paths)

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: rootDir },
      // Exact-match root entries first, then one capture-group rule per
      // package for subpaths. The replacement must re-append the captured
      // path itself: path.resolve() strips trailing slashes, so a bare
      // prefix-replacement silently yields src<subpath> (no separator) —
      // the trap the old exact-match patches existed to dodge. Extensionless
      // on purpose: vite's resolver then handles both `src/foo.ts` and
      // `src/foo/index.ts`.
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
