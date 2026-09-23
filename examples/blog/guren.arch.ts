import { defineArchRules } from '@guren/cli/arch'

// Dogfoods the RFC 0002 architecture boundary checker against this reference
// app; `guren check` enforces these rules because this file exists.
export default defineArchRules({
  // Layers are literal globs, so a module's own app/ is listed explicitly; only
  // the module-boundary rule is derived.
  layers: {
    models: ['app/Models/**', 'modules/*/app/Models/**'],
    http: ['app/Http/**', 'modules/*/app/Http/**'],
  },
  rules: [
    { from: 'models', disallow: ['http'] },
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
