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

// The default for callers that never bind a socket (`app.fetch()`, tests).
// `bin/serve.ts` replaces it with the address it really got: under `PORT=0` the
// OS picks the port, so it does not exist until `listen()` returns.
let openApiServerUrl = 'http://localhost:3334'

export function setOpenApiServerUrl(url: string): void {
  openApiServerUrl = url
}

mountOpenApiDocs(app, {
  title: 'Guren Example API',
  version: '0.1.0',
  description: 'Example API for authentication, tokens, and task management.',
  jsonPath: '/api/openapi.json',
  docsPath: '/api/docs',
  // A function, not a list: read per request, so a later address still lands.
  servers: () => [openApiServerUrl],
})

export default app
