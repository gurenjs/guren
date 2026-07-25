import { defineModule } from '@guren/core'
import AuthProvider from './app/Providers/AuthProvider.js'
import OAuthProvider from './app/Providers/OAuthProvider.js'
import { registerBlogRoutes } from './routes.js'

// No `prefix`: the module spans several URL surfaces (/blog, /admin,
// /auth/github, /logout), so routes.ts declares full paths itself.
export const blogModule = defineModule({
  name: 'blog',
  routes: registerBlogRoutes,
  providers: [AuthProvider, OAuthProvider],
})
