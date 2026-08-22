import { defineConfig } from 'tsdown'

// tsdown defaults cover format (esm), outDir (dist), clean and platform
// (node); no `types` in package.json, so no declarations. The bin is named
// dist/cli.js, while tsdown would emit .mjs on the node platform.
export default defineConfig({
  entry: ['src/cli.ts'],
  target: 'node18',
  fixedExtension: false,
  // bunx runs this bin under Node ESM, which cannot resolve dependencies
  // from Bun's node_modules/.bun layout (#33), so the CLI's two runtime
  // dependencies are bundled in. The patterns cover subpaths too: a bare
  // name matches only the exact id, and citty imports consola/utils.
  deps: { alwaysBundle: [/^consola(\/|$)/, /^citty(\/|$)/], neverBundle: ['@guren/cli'] },
  banner: {
    js: '#!/usr/bin/env node',
  },
})
