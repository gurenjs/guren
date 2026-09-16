// Every zod schema built after this import parses through a compiled fast
// path. Keep it the first import so it runs before any module that defines
// schemas. It honors z.config({ jitless: true }) for CSP-restricted runtimes
// and never throws — unsupported schemas keep the regular parser. One caveat:
// on invalid input, refinements/transforms can run twice (fast path, then
// fallback), so keep .refine()/.transform() free of side effects.
import 'zod/compile'
import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import http from '../config/http.js'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  // Rendered into every server-rendered document. Replace public/favicon.svg
  // with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
  inertia: {
    document: {
      head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    },
  },
  env,
  config: [database, http],
  routes: registerWebRoutes,
  // Translations live in lang/<locale>/*.json. Add locales to `supported`
  // and the request locale is detected from ?locale=, a locale cookie, or
  // Accept-Language. `guren codegen` types the keys for t()/useTranslation().
  i18n: { supported: ['en'] },
})

export default app
