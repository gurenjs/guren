// Every zod schema built after this import parses through a compiled fast path,
// so keep it the first import. It honors z.config({ jitless: true }) and never
// throws. Caveat: on invalid input a refinement/transform can run twice (fast
// path, then fallback), so keep them free of side effects.
import 'zod/compile'
import {
  createApp,
  NotificationServiceProvider as CoreNotificationServiceProvider,
  BroadcastServiceProvider as CoreBroadcastServiceProvider,
} from '@guren/core'
import { mountOpenApiDocs } from '@guren/openapi'
import EventServiceProvider from '../app/Providers/EventServiceProvider.js'
import SchedulingProvider from '../app/Providers/SchedulingProvider.js'
import NotificationProvider from '../app/Providers/NotificationProvider.js'
import BroadcastProvider from '../app/Providers/BroadcastProvider.js'
import cache from '../config/cache.js'
import database from '../config/database.js'
import env from '../config/env.js'
import mail from '../config/mail.js'
import queue from '../config/queue.js'
import storage from '../config/storage.js'
import registerApiRoutes from '../routes/api.js'

const app = createApp({
  env,
  config: [database, cache, mail, queue, storage],
  routes: registerApiRoutes,
  providers: [
    CoreNotificationServiceProvider,
    NotificationProvider,
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
