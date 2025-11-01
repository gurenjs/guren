import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/drizzle.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json'
})
