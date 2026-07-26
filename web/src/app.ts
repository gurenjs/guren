import {
  createApp,
  AuthServiceProvider as CoreAuthServiceProvider,
  DatabaseSessionStore,
  setInertiaDocument,
} from '@guren/core'
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

// Registered at module scope so every entrypoint picks it up — the Bun server,
// the Vercel handler, and the generated Workers bundle all import this module.
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

export default app
