// Landing-page code sample sources. Pure data — shared by the request-path
// fallback (highlight-code-examples.ts) and scripts/prerender-docs.ts.

export const HOME_CODE_EXAMPLES = {
  Routes: `import { Router } from '@guren/core'

export function routes(router: Router) {
  router.get('/posts', [PostController, 'index'])
  router.post('/posts', [PostController, 'store'])

  router.middleware('auth').group((g) => {
    g.get('/dashboard', [DashCtrl, 'index'])
  })
}`,
  Controller: `export class PostController extends Controller {
  async index() {
    const result = await Post.paginate({ page: 1, perPage: 15 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })
    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: paginator,
    })
  }

  async store() {
    const data = await this.validateBody(Schema)
    await Post.create(data)
    return this.redirect('/posts')
  }
}`,
  Model: `export class Post extends Model {
  static table = posts
}

const post = await Post.findOrFail(1)
const all = await Post
  .where('published', true)
  .get()`,
} as const

export const HOME_SHIKI_THEME = 'rose-pine-moon'
