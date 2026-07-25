import { Router, requireAuthenticated } from '@guren/core'
import BlogController from './app/Http/Controllers/BlogController.js'
import PostsController from './app/Http/Controllers/Admin/PostsController.js'
import OAuthController from './app/Http/Controllers/Auth/OAuthController.js'

export function registerBlogRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware(
    'blog.auth',
    requireAuthenticated({ redirectTo: '/auth/github' }),
  )

  router.get('/blog', [BlogController, 'index']).name('blog.index')
  router.get('/blog/:slug', [BlogController, 'show']).name('blog.show')

  router.get('/auth/github', [OAuthController, 'redirectToProvider']).name('auth.github')
  router.get('/auth/github/callback', [OAuthController, 'callback']).name('auth.github.callback')
  router.post('/logout', [OAuthController, 'logout']).name('logout')

  router.group('/admin', (admin) => {
    admin.middleware('blog.auth').group((authed) => {
      authed.get('/', [PostsController, 'index']).name('admin.posts.index')
      authed.get('/posts/new', [PostsController, 'create']).name('admin.posts.create')
      authed.post('/posts', [PostsController, 'store']).name('admin.posts.store')
      authed.get('/posts/:id/edit', [PostsController, 'edit']).name('admin.posts.edit')
      authed.post('/posts/:id', [PostsController, 'update']).name('admin.posts.update')
      authed.post('/posts/:id/delete', [PostsController, 'destroy']).name('admin.posts.destroy')
      authed.post('/posts/:id/publish', [PostsController, 'setPublished']).name('admin.posts.publish')
    })
  })
}
