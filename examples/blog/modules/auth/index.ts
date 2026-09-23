import { defineModule } from '@guren/core'
import AuthProvider from './app/Providers/AuthProvider.js'
import { registerAuthModuleRoutes } from './routes/index.js'

// The bounded context for signing in: login, registration, password reset,
// email verification and OAuth. `User`, mail and the token stores stay in
// the app's root `app/` — a module may reach out to root (RFC 0002), and
// those are shared with app/Http/Controllers/ProfileController.ts and
// DashboardController.ts, which do not move here.
export const authModule = defineModule({
  name: 'auth',
  routes: registerAuthModuleRoutes,
  providers: [AuthProvider],
})
