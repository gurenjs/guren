import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  entry: ['src/index.ts', 'src/vitest.ts'],
  tsconfig: 'tsconfig.build.json',
  format: ['esm', 'cjs'],
  sourcemap: true,
  // Reached by dynamic import as a fallback and undeclared on purpose (the
  // declared peer is @guren/server, which it aggregates).
  deps: { neverBundle: ['@guren/core'] },
})
