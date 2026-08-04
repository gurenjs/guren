import { createApp } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import { registerApiRoutes } from '../routes/api.js'

// The Host header is client-controlled, so production answers only to the host
// this app is actually deployed as. APP_URL carries that host and is required
// in production — anything derived from an unchecked Host (absolute links in
// emails, cached responses) would otherwise point wherever a caller asked.
function allowedHosts(): string[] {
  if (process.env.NODE_ENV !== 'production') {
    return ['localhost:*', '127.0.0.1:*']
  }

  const appUrl = process.env.APP_URL?.trim()
  if (!appUrl) {
    throw new Error('APP_URL must be set in production: it defines the host this app answers to.')
  }

  // `hostname:*` rather than the bare host: the hostname is the security
  // boundary, and a proxy may or may not include the default port in `Host`.
  return [`${new URL(appUrl).hostname}:*`]
}

const app = createApp({
  routes: registerApiRoutes,
  providers: [DatabaseProvider],
  hostAuthorization: {
    allowedHosts: allowedHosts(),
    exclude: ['/health'],
  },
})

export default app
