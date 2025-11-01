import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['resources/js/app.tsx'],
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: true,
  outDir: 'public/assets',
  clean: true,
  target: 'esnext',
})
