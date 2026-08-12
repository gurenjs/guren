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
  // A function, not a list: read per request, so the address the app bound
  // still lands. Under `PORT=0` the OS picks the port, so it does not exist
  // until `listen()` returns; the fallback covers callers that never bind a
  // socket at all (`app.fetch()`, tests).
  servers: () => [app.address?.url ?? 'http://localhost:3334'],
})

export default app
