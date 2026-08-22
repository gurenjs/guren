import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  entry: ['src/index.ts', 'src/vitest.ts'],
  tsconfig: 'tsconfig.build.json',
  format: ['esm', 'cjs'],
  sourcemap: true,
})
