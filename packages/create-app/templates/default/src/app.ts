import { createApp } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider],
  hostAuthorization: process.env.NODE_ENV === 'production' ? false : {
    allowedHosts: ['localhost:*', '127.0.0.1:*'],
    exclude: ['/healthcheck', '/up'],
  },
})

export default app
