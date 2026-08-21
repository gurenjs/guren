import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/vitest.ts'],
  format: ['esm', 'cjs'],
  platform: 'node',
  dts: true,
  sourcemap: true,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
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
