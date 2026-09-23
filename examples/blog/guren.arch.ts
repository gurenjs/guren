import { defineArchRules } from '@guren/cli/arch'

// Dogfoods the RFC 0002 architecture boundary checker against this reference
// app; `guren check` enforces these rules because this file exists.
export default defineArchRules({
  // A module's own app/Models and app/Http (e.g. modules/auth) count too, so
  // adding a module does not quietly drop out of these explicit rules — only
  // the zero-config module-boundary rule is derived automatically.
  layers: {
    models: ['app/Models/**', 'modules/*/app/Models/**'],
    http: ['app/Http/**', 'modules/*/app/Http/**'],
  },
  rules: [
    { from: 'models', disallow: ['http'] },
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
