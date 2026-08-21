import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/drizzle.ts', 'src/drizzle/pg.ts', 'src/drizzle/mysql.ts', 'src/drizzle/sqlite.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
  deps: { neverBundle: ['bun:sqlite', 'drizzle-orm/bun-sqlite', 'drizzle-orm/bun-sqlite/migrator', 'drizzle-orm/mysql2', 'drizzle-orm/mysql2/migrator'] },
})
