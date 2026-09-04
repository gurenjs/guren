import { defineArchRules } from '@guren/cli/arch'

// Dogfoods the RFC 0002 architecture boundary checker against this reference
// app; `guren check` enforces these rules because this file exists.
export default defineArchRules({
  layers: {
    models: 'app/Models/**',
    http: 'app/Http/**',
  },
  rules: [
    { from: 'models', disallow: ['http'] },
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
