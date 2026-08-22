import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  entry: ['src/app.tsx', 'src/server.tsx', 'src/contracts.ts', 'src/channel.ts', 'src/typed-forms.ts', 'src/components.tsx', 'src/index.ts'],
})
