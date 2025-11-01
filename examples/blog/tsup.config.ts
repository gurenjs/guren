import { defineConfig } from 'tsup'

const isProduction = process.env.NODE_ENV === 'production'

export default defineConfig({
  entry: ['resources/js/app.tsx'],
  outDir: 'public/assets',
  format: ['esm'],
  splitting: false,
  sourcemap: !isProduction,
  clean: true,
  minify: isProduction,
  target: 'es2020',
  platform: 'browser',
  skipNodeModulesBundle: true,
})
