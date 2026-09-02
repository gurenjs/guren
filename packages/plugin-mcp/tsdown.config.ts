import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

export default defineConfig({
  ...tsdownPreset,
  // `src/oauth.ts` is a second entry, not a second copy: it and `src/plugin.ts`
  // both reach `src/external-auth.ts`, whose `WeakMap` *is* the seam. Two
  // bundles each carrying their own copy of that module would be two maps and
  // the seam would never hit — `external-auth.test.ts` asserts identity holds
  // across the built entries for exactly this reason.
  entry: ['src/index.ts', 'src/oauth.ts'],
  tsconfig: 'tsconfig.build.json',
})
