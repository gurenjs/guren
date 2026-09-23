import { defineModule } from '@guren/core'
import AuthProvider from './app/Providers/AuthProvider.js'
import { registerAuthModuleRoutes } from './routes/index.js'

// `User`, mail and the token stores stay in root `app/`: root controllers use
// them too, and a module may import root code (RFC 0002).
export const authModule = defineModule({
  name: 'auth',
  routes: registerAuthModuleRoutes,
  providers: [AuthProvider],
})
