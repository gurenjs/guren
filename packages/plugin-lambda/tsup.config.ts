import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/commands.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
})
