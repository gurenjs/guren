import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  // paths: {} lives in tsconfig.build.json (like every sibling-importing
  // package), NOT in tsconfig.json: Bun honours tsconfig paths at runtime, so
  // clearing them in the runtime config made core/src resolve '@guren/orm' to
  // dist while the app and server resolved it to src — two adapter copies in
  // one monorepo-dev process.
  tsconfig: 'tsconfig.build.json',
  entry: [
    'src/index.ts',
    'src/jsx-runtime.ts',
    'src/jsx-dev-runtime.ts',
    'src/bin.ts',
    'src/runtime.ts',
    'src/vite.ts',
    'src/lambda.ts',
    'src/redis.ts',
    'src/agent.ts',
    'src/internal/deploy-build.ts',
    'src/internal/deploy-check.ts',
    'src/internal/route-path.ts',
    'src/internal/zod-compat.ts',
    'src/internal/zod-json-schema.ts',
  ],
})
