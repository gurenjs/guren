import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/app.tsx', 'src/server.tsx', 'src/contracts.ts', 'src/channel.ts', 'src/typed-forms.ts', 'src/components.tsx', 'src/index.ts'],
  format: ['esm'],
  platform: 'node',
  dts: true,
  fixedExtension: false,
  outDir: 'dist',
  clean: true,
})
