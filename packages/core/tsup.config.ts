import { defineConfig } from 'tsup'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/bin.ts',
    'src/runtime.ts',
    'src/vite.ts',
    'src/lambda.ts',
    'src/redis.ts',
    'src/internal/deploy-build.ts',
  ],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
})
