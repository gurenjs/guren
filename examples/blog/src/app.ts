import { fileURLToPath } from 'node:url'
import {
  createApp,
  ErrorServiceProvider,
  InertiaServiceProvider,
  AuthServiceProvider as CoreAuthServiceProvider,
  OAuthServiceProvider as CoreOAuthServiceProvider,
  NotificationServiceProvider as CoreNotificationServiceProvider,
  StorageServiceProvider as CoreStorageServiceProvider,
  BroadcastServiceProvider as CoreBroadcastServiceProvider,
} from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'
import OAuthProvider from '../app/Providers/OAuthProvider.js'
import CacheProvider from '../app/Providers/CacheProvider.js'
import requestLogger from '../app/Http/middleware/requestLogger.js'
import EventServiceProvider from '../app/Providers/EventServiceProvider.js'
import SchedulingProvider from '../app/Providers/SchedulingProvider.js'
import NotificationProvider from '../app/Providers/NotificationProvider.js'
import StorageProvider from '../app/Providers/StorageProvider.js'
import BroadcastProvider from '../app/Providers/BroadcastProvider.js'
import { registerWebRoutes } from '../routes/web.js'
import '../config/inertia.js'

const secureCookies = process.env.NODE_ENV === 'production' && !process.env.CI

// The Host header is client-controlled, so production should answer only to the
// host this app is deployed as, which APP_URL carries.
//
// Read at module scope, where not every platform has populated process.env yet
// (the Cloudflare worker imports this module before wrangler `vars` land). A
// missing value therefore warns and leaves the check off, rather than throwing
// and stopping the app from booting at all. Emailed links do not depend on this
// — app/Auth/AppUrl.ts resolves those per request and fails closed there.
function hostAuthorization() {
  const exclude = ['/health']

  if (process.env.NODE_ENV !== 'production') {
    return { allowedHosts: ['localhost:*', '127.0.0.1:*'], exclude }
  }

  const appUrl = process.env.APP_URL?.trim()
  if (!appUrl) {
    console.warn('[app] APP_URL is not set — host authorization is disabled. Set it to the public base URL of this app.')
    return false
  }

  // `hostname:*` rather than the bare host: the hostname is the security
  // boundary, and a proxy may or may not include the default port in `Host`.
  return { allowedHosts: [`${new URL(appUrl).hostname}:*`], exclude }
}

const app = createApp({
  routes: registerWebRoutes,
  providers: [
    ErrorServiceProvider,
    InertiaServiceProvider,
    CoreAuthServiceProvider,
    DatabaseProvider,
    AuthProvider,
    CoreOAuthServiceProvider,
    OAuthProvider,
    CacheProvider,
    CoreNotificationServiceProvider,
    NotificationProvider,
    CoreStorageServiceProvider,
    StorageProvider,
    CoreBroadcastServiceProvider,
    BroadcastProvider,
    EventServiceProvider,
    SchedulingProvider,
  ],
  i18n: {
    supported: ['en', 'ja'],
    // Monorepo artifact: tests can boot this app with cwd = repo root, so
    // anchor to this file instead of relying on the cwd-relative 'lang'
    // default. A scaffolded app (cwd = app root) does not need this.
    path: fileURLToPath(new URL('../lang', import.meta.url)),
  },
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
  hostAuthorization: hostAuthorization(),
})

app.use('*', requestLogger)

export default app
