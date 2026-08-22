import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  entry: ['src/index.ts', 'src/bin.ts', 'src/vite/index.ts', 'src/arch/index.ts'],
  tsconfig: 'tsconfig.build.json',
})
