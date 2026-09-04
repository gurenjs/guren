import { defineModule } from '@guren/core'
import AuthProvider from './app/Providers/AuthProvider.js'
import OAuthProvider from './app/Providers/OAuthProvider.js'
import { registerBlogRoutes } from './routes.js'

// What the site's sitemap and llms.txt need, without reaching into internals.
export { listPublishedPosts, type PublishedPost } from './app/Services/published-posts.js'

// No `prefix`: the module spans /blog, /admin, /auth/github and /logout, so
// routes.ts declares full paths itself.
export const blogModule = defineModule({
  name: 'blog',
  routes: registerBlogRoutes,
  providers: [AuthProvider, OAuthProvider],
})
