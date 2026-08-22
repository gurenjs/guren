import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  entry: [
    'src/index.ts',
    'src/bin.ts',
    'src/runtime.ts',
    'src/vite.ts',
    'src/lambda.ts',
    'src/redis.ts',
    'src/internal/deploy-build.ts',
    'src/internal/zod-compat.ts',
  ],
})
