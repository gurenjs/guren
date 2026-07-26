import {
  createApp,
  AuthServiceProvider as CoreAuthServiceProvider,
  DatabaseSessionStore,
  setInertiaDocument,
} from '@guren/core'
import { redirectToCanonicalHost } from '../app/Http/Middleware/canonical-host.js'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import {
  COLOR_MODE_PREPAINT_SCRIPT,
  LIGHT_SURFACE_CRITICAL_CSS,
} from '../config/document-theme.js'
import { LIGHT_SURFACE_BODY_CLASS, usesLightSurface } from '../config/theme.js'
import { sessions } from '../db/schema.js'
import { blogModule } from '../modules/blog/index.js'
import registerWebRoutes from '../routes/web.js'

const secureCookies = process.env.NODE_ENV === 'production' && !process.env.CI

// Registered at module scope so every entrypoint picks it up — both the Bun
// server and the generated Workers bundle import this module.
setInertiaDocument({
  bodyClass: ({ component }) => (usesLightSurface(component) ? LIGHT_SURFACE_BODY_CLASS : undefined),
  criticalCss: ({ component }) => (usesLightSurface(component) ? LIGHT_SURFACE_CRITICAL_CSS : undefined),
  prepaintScript: ({ component }) =>
    usesLightSurface(component) ? COLOR_MODE_PREPAINT_SCRIPT : undefined,
})

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider, CoreAuthServiceProvider],
  modules: [blogModule],
  auth: {
    autoSession: true,
    sessionOptions: {
      // Database-backed sessions: required on Workers, where per-isolate
      // memory does not survive between the login redirect and the next read.
      store: new DatabaseSessionStore(sessions),
      cookieSecure: secureCookies,
    },
    csrfOptions: {
      cookieOptions: {
        secure: secureCookies,
      },
    },
  },
})

// Both hostnames are routed to this worker, so the redirect lives here
// rather than in DNS.
app.use('*', redirectToCanonicalHost)

export default app
