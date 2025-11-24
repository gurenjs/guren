import { Application } from '@guren/server'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'
import requestLogger from '../app/Http/middleware/requestLogger.js'
import '../config/inertia.js'

const app = new Application({
  providers: [DatabaseProvider, AuthProvider],
  auth: {
    autoSession: true,
    sessionOptions: {
      cookieSecure: process.env.NODE_ENV === 'production',
    },
  },
})

app.use('*', requestLogger)

export default app
