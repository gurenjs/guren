import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node18',
  dts: false,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
  deps: { alwaysBundle: ['consola', 'citty'], neverBundle: ['@guren/cli'] },
  banner: {
    js: '#!/usr/bin/env node',
  },
})
