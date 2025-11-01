import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  clean: true,
  target: 'node18',
  outDir: 'dist',
  platform: 'node',
  banner: {
    js: '#!/usr/bin/env node',
  },
})
