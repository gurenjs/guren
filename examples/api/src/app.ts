// Every zod schema built after this import parses through a compiled fast path,
// so keep it the first import. It honors z.config({ jitless: true }) and never
// throws. Caveat: on invalid input a refinement/transform can run twice (fast
// path, then fallback), so keep them free of side effects.
import 'zod/compile'
import {
  createApp,
  NotificationServiceProvider as CoreNotificationServiceProvider,
  StorageServiceProvider as CoreStorageServiceProvider,
  BroadcastServiceProvider as CoreBroadcastServiceProvider,
} from '@guren/core'
import { mountOpenApiDocs } from '@guren/openapi'
import CacheProvider from '../app/Providers/CacheProvider.js'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import EventServiceProvider from '../app/Providers/EventServiceProvider.js'
import SchedulingProvider from '../app/Providers/SchedulingProvider.js'
import NotificationProvider from '../app/Providers/NotificationProvider.js'
import StorageProvider from '../app/Providers/StorageProvider.js'
import BroadcastProvider from '../app/Providers/BroadcastProvider.js'
import registerApiRoutes from '../routes/api.js'

const app = createApp({
  routes: registerApiRoutes,
  providers: [
    DatabaseProvider,
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
})

mountOpenApiDocs(app, {
  title: 'Guren Example API',
  version: '0.1.0',
  description: 'Example API for authentication, tokens, and task management.',
  jsonPath: '/api/openapi.json',
  docsPath: '/api/docs',
  // A function, not a list, so it is read per request: under `PORT=0` the OS
  // picks the port, which does not exist until `listen()` returns. The fallback
  // covers callers that never bind a socket (`app.fetch()`, tests).
  servers: () => [app.address?.url ?? 'http://localhost:3334'],
})

export default app
