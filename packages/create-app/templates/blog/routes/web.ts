import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { registerAuthRoutes } from './auth.js'

export function registerWebRoutes(baseRouter: Router): void {
  // Named rather than inline so `guren audit` can see which routes are
  // protected — it cannot inspect a middleware passed as a call result.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/dashboard' }))

  router.get('/', [HomeController, 'index']).name('home')

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))

  registerAuthRoutes(router)

  router.group('/posts', (posts) => {
    // Registered before '/:id', or "create" is read as a post id.
    posts.middleware('auth').group((authed) => {
      authed.get('/create', [PostController, 'create']).name('posts.create')
      authed.get('/:id/edit', [PostController, 'edit']).name('posts.edit')
      authed.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
      authed.put('/:id', { name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
      authed.delete('/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
    })

    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
  })
}
