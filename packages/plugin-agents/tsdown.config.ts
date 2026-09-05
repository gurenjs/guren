import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  // Three entries, and the split is the package's whole shape. `agents`
  // statically imports `cloudflare:workers`, so evaluating it outside workerd
  // throws — and the root is imported by `src/app.ts`, which runs on Bun. So
  // `src/index.ts` holds only what Bun can evaluate, and `src/agent.ts` is the
  // workerd-only half that extends `Agent`.
  entry: ['src/index.ts', 'src/agent.ts', 'src/runtime.ts'],
  tsconfig: 'tsconfig.build.json',
})
