export const APPLICATION_GRAPH_FIXTURE = {
  'package.json': '{"type":"module"}',
  'app/Models/Post.ts': 'export class Post { static findOrFail() { throw new Error("unused") } }',
  'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
export class PostController extends Controller {
  index() { return this.inertia('posts/Index', {}) }
}`,
  'resources/js/pages/posts/Index.tsx': 'export default function Page() { return <div>Posts</div> }',
  'src/main.ts': `import { createApp } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController'
import { Post } from '../app/Models/Post'
export default createApp({ routes(router) {
  router.bind('post', Post as never)
  router.get('/posts/:post', [PostController, 'index']).name('posts.show')
} })`,
}

/** A schema without zod, which the temp workspace does not install: the router only asks for `safeParse`. */
const schema = '{ safeParse: (data: unknown) => ({ success: true as const, data }) }'

/** The fixture plus one reader's worth of every remaining section: validators, a policy, middleware and a test. */
export const APPLICATION_GRAPH_RELATIONS_FIXTURE: Record<string, string> = {
  ...APPLICATION_GRAPH_FIXTURE,
  'app/Http/Validators/PostValidator.ts': `export const PostParamsSchema = ${schema}
export const PostPayloadSchema = ${schema}`,
  'app/Policies/PostPolicy.ts': 'export class PostPolicy { update() { return true } }',
  'app/Http/Controllers/PostController.ts': `import { Controller } from '@guren/core'
import { PostPayloadSchema } from '../Validators/PostValidator'
import { PostPolicy } from '../../Policies/PostPolicy'
import { Post } from '../../Models/Post'
const Local = ${schema}
export class PostController extends Controller {
  index() { return this.inertia('posts/Index', {}) }
  async store() { await this.validateBody(PostPayloadSchema); await this.validateBody(Local); return new PostPolicy() }
  async update() { await this.authorize('update', [Post, null]); return this.redirect('/posts') }
}`,
  'tests/posts.test.ts': `import { test } from 'bun:test'
import { TestApp } from '@guren/testing'
test('posts', async () => {
  const app = await TestApp.create()
  await app.get('/posts/1')
  await app.get('/posts/2')
  await app.get('/missing')
})`,
  'src/main.ts': `import { createApp } from '@guren/core'
import { PostController } from '../app/Http/Controllers/PostController'
import { Post } from '../app/Models/Post'
import { PostParamsSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator'
const pass = async (_c: unknown, next: () => Promise<void>) => next()
export default createApp({ routes(base) {
  const router = base.aliasMiddleware('auth', pass).aliasMiddleware('log', pass).groupMiddleware('web', ['auth', 'log'])
  router.bind('post', Post as never)
  router.get('/posts/:post', { params: PostParamsSchema }, [PostController, 'index']).name('posts.show').middleware('web')
  router.post('/posts', { body: PostPayloadSchema, query: ${schema} }, [PostController, 'store']).name('posts.store').middleware('auth', async function stamp(_c, next) { await next() })
  router.put('/posts/:post', [PostController, 'update']).name('posts.update')
} })`,
}
