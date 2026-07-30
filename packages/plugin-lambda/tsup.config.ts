import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/commands.ts', 'src/cdk/index.ts'],
  external: ['aws-cdk-lib', 'constructs'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  tsconfig: 'tsconfig.json',
})
