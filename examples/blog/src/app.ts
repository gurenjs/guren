import { Application, createSessionMiddleware, attachAuthContext } from '@guren/server'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'
import requestLogger from '../app/Http/middleware/requestLogger.js'

const app = new Application({
  providers: [DatabaseProvider, AuthProvider],
})

app.use('*', requestLogger)
app.use('*', createSessionMiddleware({ cookieSecure: false }))
app.use('*', attachAuthContext((ctx) => app.auth.createAuthContext(ctx)))

export default app
