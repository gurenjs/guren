import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { registerAuthRoutes } from './auth.js'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/dashboard' }))

  router.get('/', [PostController, 'index']).name('home')

  // Health check endpoint for load balancers and uptime monitors, matching the
  // path the generated deploy configs probe and the host-authorization exclude.
  router.get('/health', (c) => c.json({ status: 'ok' })).name('health')

  registerAuthRoutes(router)

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.middleware('auth').get('/new', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.middleware('auth').group((authed) => {
      authed.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
      authed.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
      authed.put('/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
      authed.patch('/:id', { bind: { id: Post }, name: 'posts.patch', body: PostPayloadSchema }, [PostController, 'update'])
    })
  })
}
