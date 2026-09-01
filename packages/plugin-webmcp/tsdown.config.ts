import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  // Two entries that must not share a chunk's imports: the server half
  // reaches the container and Hono, the client half must reach neither. They
  // have no module in common, so rolldown has nothing to hoist between them.
  entry: ['src/index.ts', 'src/client.ts'],
  tsconfig: 'tsconfig.build.json',
})
