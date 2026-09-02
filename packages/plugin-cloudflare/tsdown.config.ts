import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  // `src/env.ts` is an entry of its own so application code can reach
  // `getWorkersEnv` without the root entry's `buildCloudflareOutput` — and the
  // node builtins behind it — entering its module graph. See `src/env.ts`.
  entry: ['src/index.ts', 'src/commands.ts', 'src/env.ts'],
  tsconfig: 'tsconfig.build.json',
})
