import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/commands.ts', 'src/cdk/index.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
  deps: { neverBundle: ['aws-cdk-lib', 'constructs'] },
})
