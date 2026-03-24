import { createApp } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import registerWebRoutes from '../routes/web.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider],
  // Host authorization restricts which hosts can access the app (DNS rebinding protection).
  // In production, replace with your actual domain(s).
  hostAuthorization: {
    allowedHosts: ['localhost:*', '127.0.0.1:*'],
    exclude: ['/healthcheck', '/up'],
  },
})

export default app
