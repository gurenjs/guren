import {
  createApp,
  inertia,
  AuthServiceProvider as CoreAuthServiceProvider,
} from '@guren/core'
import { redirectToCanonicalHost } from '../app/Http/Middleware/canonical-host.js'
import { redirectToCanonicalPath } from '../app/Http/Middleware/canonical-path.js'
import { recordSiteAnalytics } from '../app/Http/Middleware/site-analytics.js'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import {
  COLOR_MODE_PREPAINT_SCRIPT,
  FAVICON_HEAD,
  LIGHT_SURFACE_CRITICAL_CSS,
} from '../config/document-theme.js'
import env from '../config/env.js'
import oauth from '../config/oauth.js'
import { pageTitle } from '../config/site.js'
import session from '../config/session.js'
import { LIGHT_SURFACE_BODY_CLASS, usesLightSurface } from '../config/theme.js'
import { blogModule } from '../modules/blog/index.js'
import registerWebRoutes from '../routes/web.js'

const secureCookies = process.env.NODE_ENV === 'production' && !process.env.CI

const app = createApp({
  inertia: {
    document: {
      bodyClass: ({ component }) => (usesLightSurface(component) ? LIGHT_SURFACE_BODY_CLASS : undefined),
      criticalCss: ({ component }) => (usesLightSurface(component) ? LIGHT_SURFACE_CRITICAL_CSS : undefined),
      prepaintScript: ({ component }) =>
        usesLightSurface(component) ? COLOR_MODE_PREPAINT_SCRIPT : undefined,
      head: FAVICON_HEAD,
    },
  },
  routes: registerWebRoutes,
  env,
  config: [session, oauth],
  providers: [DatabaseProvider, CoreAuthServiceProvider],
  modules: [blogModule],
  auth: {
    autoSession: true,
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
app.use('*', redirectToCanonicalPath)

// After the canonical redirect, so www.-redirect responses are not counted.
app.use('*', recordSiteAnalytics)

// A browser visit to a URL no route answers gets the site's 404 page; any
// other caller (an asset, a feed reader, a JSON client) keeps the plain one.
app.hono.notFound((ctx) => {
  const request = ctx.req.raw
  const wantsPage =
    (request.method === 'GET' || request.method === 'HEAD') &&
    (request.headers.has('X-Inertia') || (request.headers.get('Accept') ?? '').includes('text/html'))
  if (!wantsPage) return ctx.text('404 Not Found', 404)
  return inertia('NotFound', { path: new URL(request.url).pathname }, {
    request,
    container: app.container,
    status: 404,
    title: pageTitle('Page not found'),
  })
})

export default app
