import { Router, registerAttachmentRoutes, requireAuthenticated } from '@guren/core'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'
import { PageQuerySchema, PostIdParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { pages } from '@/.guren/pages.gen'
import { registerAuthenticatedAreaRoutes } from './authenticated.js'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  // Attachment URLs point at this signed route, so unmounted every cover image
  // 404s — with the route's own uniform failure, naming no cause.
  registerAttachmentRoutes(router)

  router.get('/', [PostController, 'index']).name('home')

  // Matches the path the generated deploy configs probe and host authorization excludes.
  router.get('/health', (c) => c.json({ status: 'ok' })).name('health')

  registerAuthenticatedAreaRoutes(router)

  router.group('/posts', (posts) => {
    // The two reads an MCP Apps host renders with the blog's own pages (RFC 0038).
    posts.get('/', { query: PageQuerySchema }, [PostController, 'index'])
      .name('posts.index')
      .agent({ toolName: 'posts_index', description: 'List the latest blog posts, newest first.', ui: pages.posts.Index })
    posts.middleware('auth').get('/new', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { params: PostIdParamSchema }, [PostController, 'show'])
      .name('posts.show')
      .agent({ toolName: 'posts_show', description: 'Show one blog post with its author.', ui: pages.posts.Show })
    posts.middleware('auth').group((authed) => {
      authed.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
      authed.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
      authed.put('/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
      authed.patch('/:id', { bind: { id: Post }, name: 'posts.patch', body: PostPayloadSchema }, [PostController, 'update'])
      authed.delete('/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    })
  })
}
