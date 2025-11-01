import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/app.tsx', 'src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
})
