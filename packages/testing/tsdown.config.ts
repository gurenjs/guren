import { defineConfig } from 'tsdown'

// tsdown defaults cover format (esm), outDir (dist), clean, platform (node)
// and dts (on when package.json declares `types`). The two settings below
// are not defaults: the exports map names dist/*.js and dist/*.d.ts, while
// tsdown would emit .mjs/.d.mts on the node platform; and without a target
// tsdown lowers no syntax at all (it reads engines.node, which no package
// declares), whereas the root tsconfig promises ES2022 output.
export default defineConfig({
  entry: ['src/index.ts', 'src/vitest.ts'],
  target: 'es2022',
  fixedExtension: false,
  format: ['esm', 'cjs'],
  sourcemap: true,
  // The root tsconfig maps @guren/* to package sources; without this they
  // would be bundled in rather than imported.
  deps: {
    neverBundle: [
      'vitest',
      'lightningcss',
      'hono',
      /^@guren\//,
      'bun:sqlite',
      'drizzle-orm/bun-sqlite',
      'drizzle-orm/bun-sqlite/migrator',
    ],
  },
})
