import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/drizzle.ts', 'src/drizzle/pg.ts', 'src/drizzle/mysql.ts', 'src/drizzle/sqlite.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
  external: ['bun:sqlite', 'drizzle-orm/bun-sqlite', 'drizzle-orm/bun-sqlite/migrator', 'drizzle-orm/mysql2', 'drizzle-orm/mysql2/migrator'],
})
