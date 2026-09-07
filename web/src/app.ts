import {
  createApp,
  AuthServiceProvider as CoreAuthServiceProvider,
  setInertiaDocument,
} from '@guren/core'
import { redirectToCanonicalHost } from '../app/Http/Middleware/canonical-host.js'
import { recordSiteAnalytics } from '../app/Http/Middleware/site-analytics.js'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import SessionProvider from '../app/Providers/SessionProvider.js'
import {
  COLOR_MODE_PREPAINT_SCRIPT,
  FAVICON_HEAD,
  LIGHT_SURFACE_CRITICAL_CSS,
} from '../config/document-theme.js'
import { LIGHT_SURFACE_BODY_CLASS, usesLightSurface } from '../config/theme.js'
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
  head: FAVICON_HEAD,
})

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider, SessionProvider, CoreAuthServiceProvider],
  modules: [blogModule],
  auth: {
    autoSession: true,
    // The store comes from SessionProvider's manager (config/session.ts).
    sessionOptions: {
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

// After the canonical redirect, so www.-redirect responses are not counted.
app.use('*', recordSiteAnalytics)

export default app
