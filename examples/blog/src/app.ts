// Every zod schema built after this import parses through a compiled fast path,
// so keep it the first import. It honors z.config({ jitless: true }) and never
// throws. Caveat: on invalid input a refinement/transform can run twice (fast
// path, then fallback), so keep them free of side effects.
import 'zod/compile'
import { fileURLToPath } from 'node:url'
import {
  createApp,
  ErrorServiceProvider,
  InertiaServiceProvider,
  AuthServiceProvider as CoreAuthServiceProvider,
  NotificationServiceProvider as CoreNotificationServiceProvider,
  BroadcastServiceProvider as CoreBroadcastServiceProvider,
} from '@guren/core'
import AuthProvider from '../app/Providers/AuthProvider.js'
import requestLogger from '../app/Http/middleware/requestLogger.js'
import EventServiceProvider from '../app/Providers/EventServiceProvider.js'
import SchedulingProvider from '../app/Providers/SchedulingProvider.js'
import NotificationProvider from '../app/Providers/NotificationProvider.js'
import AttachmentsProvider from '../app/Providers/AttachmentsProvider.js'
import BroadcastProvider from '../app/Providers/BroadcastProvider.js'
import cache from '../config/cache.js'
import database from '../config/database.js'
import env from '../config/env.js'
import http from '../config/http.js'
import mail from '../config/mail.js'
import oauth from '../config/oauth.js'
import queue from '../config/queue.js'
import session from '../config/session.js'
import storage from '../config/storage.js'
import { registerWebRoutes } from '../routes/web.js'
import '../config/inertia.js'

// Raw rather than declared: `CI` is the e2e job's switch for serving over HTTP,
// not application configuration.
// oxlint-disable-next-line guren/no-unvalidated-env-read -- CI switch, not app config
const secureCookies = process.env.NODE_ENV === 'production' && !process.env.CI

const app = createApp({
  // Rendered into every server-rendered document. Replace public/favicon.svg
  // with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
  inertia: {
    document: {
      head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    },
  },
  env,
  config: [database, http, session, cache, mail, queue, storage, oauth],
  routes: registerWebRoutes,
  providers: [
    ErrorServiceProvider,
    InertiaServiceProvider,
    CoreAuthServiceProvider,
    AuthProvider,
    CoreNotificationServiceProvider,
    NotificationProvider,
    AttachmentsProvider,
    CoreBroadcastServiceProvider,
    BroadcastProvider,
    EventServiceProvider,
    SchedulingProvider,
  ],
  i18n: {
    supported: ['en', 'ja'],
    // Monorepo artifact: tests boot this app with cwd = repo root, so anchor to
    // this file rather than the cwd-relative 'lang' default. A scaffolded app
    // does not need this.
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
})

app.use('*', requestLogger)

export default app
