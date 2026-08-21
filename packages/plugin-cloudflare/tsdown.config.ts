import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/commands.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
})
