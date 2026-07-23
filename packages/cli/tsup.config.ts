import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts', 'src/vite/index.ts', 'src/arch/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
  external: ['@guren/core', '@guren/openapi']
})
