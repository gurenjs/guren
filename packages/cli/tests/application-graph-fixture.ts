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
