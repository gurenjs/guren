import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/shiki.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
})
