import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/bin.ts',
    'src/runtime.ts',
    'src/vite.ts',
    'src/lambda.ts',
    'src/redis.ts',
    'src/internal/deploy-build.ts',
    'src/internal/zod-compat.ts',
  ],
  format: ['esm'],
  platform: 'node',
  dts: true,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
})
