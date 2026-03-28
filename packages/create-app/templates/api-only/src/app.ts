import { createApp } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import { registerApiRoutes } from '../routes/api.js'

const app = createApp({
  routes: registerApiRoutes,
  providers: [DatabaseProvider],
  hostAuthorization: {
    allowedHosts: ['localhost:*', '127.0.0.1:*'],
    exclude: ['/health'],
  },
})

export default app
