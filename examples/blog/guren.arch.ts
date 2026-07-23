import { defineArchRules } from '@guren/cli/arch'

// Dogfoods the RFC 0002 architecture boundary checker (see
// rfcs/0002-modules-and-architecture-boundaries.md) against this reference
// app: `guren check` (and the agent-harness edit hook) enforces this
// automatically now that this file exists.
export default defineArchRules({
  layers: {
    models: 'app/Models/**',
    http: 'app/Http/**',
  },
  rules: [
    // Models are the data-access boundary; they must not depend on
    // controllers, middleware, or other HTTP-layer concerns.
    { from: 'models', disallow: ['http'] },
    // Controllers query through Models, not the ORM directly.
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
