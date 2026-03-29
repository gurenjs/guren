import path from 'node:path'
import { defineConfig } from 'vitest/config'

const rootDir = __dirname
const resolveFromRoot = (...paths: string[]) => path.resolve(rootDir, ...paths)

export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: resolveFromRoot('app') },
      { find: /^@guren\/testing$/, replacement: resolveFromRoot('../packages/testing/src/index.ts') },
      { find: /^@guren\/testing\//, replacement: resolveFromRoot('../packages/testing/src/') },
      { find: /^@guren\/server$/, replacement: resolveFromRoot('../packages/server/src/index.ts') },
      { find: /^@guren\/server\//, replacement: resolveFromRoot('../packages/server/src/') },
      { find: /^@guren\/core$/, replacement: resolveFromRoot('../packages/core/src/index.ts') },
      { find: /^@guren\/core\//, replacement: resolveFromRoot('../packages/core/src/') },
      { find: /^guren$/, replacement: resolveFromRoot('../packages/core/src/index.ts') },
      { find: /^guren\//, replacement: resolveFromRoot('../packages/core/src/') },
    ],
  },
  test: {
    environment: 'node',
  },
})
