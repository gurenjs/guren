import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  entry: ['src/cli.ts'],
  target: 'node18',
  // bunx runs this bin under Node ESM, which cannot resolve dependencies from
  // Bun's node_modules/.bun layout (#33), so the two runtime deps are bundled
  // in. The patterns cover subpaths: a bare name matches only the exact id, and
  // citty imports consola/utils. @guren/cli is dynamic-imported on purpose.
  deps: { alwaysBundle: [/^consola(\/|$)/, /^citty(\/|$)/], neverBundle: ['@guren/cli'] },
  banner: {
    js: '#!/usr/bin/env node',
  },
})
