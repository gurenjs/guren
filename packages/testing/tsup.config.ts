import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: [
    'vitest',
    'lightningcss',
    'hono',
    /^@guren\//,
    'bun:sqlite',
    'drizzle-orm/bun-sqlite',
    'drizzle-orm/bun-sqlite/migrator',
  ],
})
