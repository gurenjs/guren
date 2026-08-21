import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts', 'src/vite/index.ts', 'src/arch/index.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  // package.json exports name dist/*.js and dist/*.d.ts; tsdown would
  // otherwise emit .mjs/.d.mts.
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
  deps: { neverBundle: ['@guren/core', '@guren/openapi'] },
})
