import { createApp, setInertiaDocument } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import { registerWebRoutes } from '../routes/web.js'

// Rendered into every server-rendered document. Replace public/favicon.svg
// with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
setInertiaDocument({
  head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
})

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider],
  hostAuthorization: process.env.NODE_ENV === 'production' ? false : {
    allowedHosts: ['localhost:*', '127.0.0.1:*'],
    exclude: ['/healthcheck', '/up'],
  },
})

export default app
