import { defineConfig } from 'tsdown'

import { tsdownPreset } from '../../scripts/tsdown-preset'

// rolldown shares chunks between entries, and this package depends on that: the
// job registry, mail manager and queue driver are module-level state, so a copy
// per entry would make registerJob via the root entry invisible to ./queue.
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
    // Browser-safe dispatch surface: its own entry so a client bundle gets
    // buildToolRequest/mapToolResponse without the package index's app graph.
    'src/agent/public.ts',
    // Not public API: @guren/core's database stores re-export the expiry
    // rules from here so the two packages cannot drift apart.
    'src/support/expiry.ts',
    // Not public API: `@guren/core/internal/*` re-exports these, so @guren/openapi,
    // @guren/cli and @guren/testing share one Zod → JSON Schema rule and one
    // request-body rule. A path in package.json `exports` but missing here emits
    // a .d.ts with no .js.
    'src/internal/request.ts',
    'src/internal/route-path.ts',
    'src/internal/zod-compat.ts',
    'src/internal/zod-json-schema.ts',
  ],
  // Declarations come from `tsc -p tsconfig.build.json`: unbundled, one .d.ts per
  // module, keeping the MCP SDK types behind ./mcp instead of in one root bundle.
  dts: false,
  // Both undeclared: @guren/cli is reached by dynamic import and would
  // otherwise be bundled through the root tsconfig paths; zod is the app's.
  deps: { neverBundle: ['@guren/cli', 'zod'] },
})
