import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

// rolldown always shares chunks between entries, and this package depends on
// that: the job registry, mail manager and queue driver are module-level
// state, so a copy per entry would make registerJob via the root entry
// invisible to a Worker imported via ./queue.
export default defineConfig({
  ...tsdownPreset,
  entry: [
    'src/index.ts',
    'src/jsx-runtime.ts',
    'src/jsx-dev-runtime.ts',
    'src/auth/index.ts',
    'src/authorization/index.ts',
    'src/broadcasting/index.ts',
    'src/cache/index.ts',
    'src/encryption/index.ts',
    'src/events/index.ts',
    'src/health/index.ts',
    'src/i18n/index.ts',

    'src/logging/index.ts',
    'src/mail/index.ts',
    'src/notifications/index.ts',
    'src/queue/index.ts',
    'src/redis/index.ts',
    'src/runtime/index.ts',
    'src/scheduling/index.ts',
    'src/storage/index.ts',
    'src/vite/index.ts',
    'src/lambda/index.ts',
    'src/mcp/index.ts',
    // Not public API: @guren/core's database stores re-export the expiry
    // rules from here so the two packages cannot drift apart.
    'src/support/expiry.ts',
    // Not public API either, and here for the same reason one step further
    // out: `@guren/core/internal/*` re-exports these, so @guren/openapi and
    // @guren/cli keep one Zod → JSON Schema rule with `deriveAgentTools`.
    // Declarations come from tsc, JS from here — a path listed in
    // package.json `exports` but missing below emits a .d.ts with no .js.
    'src/internal/zod-compat.ts',
    'src/internal/zod-json-schema.ts',
  ],
  // Declarations come from `tsc -p tsconfig.build.json` (see the build
  // script): unbundled, one .d.ts per module, which keeps the MCP SDK types
  // behind the ./mcp subpath instead of in one root bundle.
  dts: false,
  // Both undeclared: @guren/cli is reached by dynamic import and would
  // otherwise be bundled through the root tsconfig paths; zod is the app's.
  deps: { neverBundle: ['@guren/cli', 'zod'] },
})
