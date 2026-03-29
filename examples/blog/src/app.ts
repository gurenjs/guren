import {
  createApp,
  ErrorServiceProvider,
  InertiaServiceProvider,
  AuthServiceProvider as CoreAuthServiceProvider,
  NotificationServiceProvider as CoreNotificationServiceProvider,
  StorageServiceProvider as CoreStorageServiceProvider,
  BroadcastServiceProvider as CoreBroadcastServiceProvider,
} from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'
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

const app = createApp({
  routes: registerWebRoutes,
  providers: [
    ErrorServiceProvider,
    InertiaServiceProvider,
    CoreAuthServiceProvider,
    DatabaseProvider,
    AuthProvider,
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
  hostAuthorization: {
    allowedHosts: ['localhost:*', '127.0.0.1:*'],
    exclude: ['/healthcheck', '/up'],
  },
})

app.use('*', requestLogger)

export default app
