import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  entry: ['src/index.ts', 'src/drizzle.ts', 'src/drizzle/pg.ts', 'src/drizzle/mysql.ts', 'src/drizzle/sqlite.ts'],
  // Not a Node builtin, so rolldown would warn about it as unresolved.
  deps: { neverBundle: ['bun:sqlite'] },
})
