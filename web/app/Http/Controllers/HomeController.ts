import { Controller } from '@guren/core'
import { codeToHtml } from 'shiki'
import { webPages } from '../../../resources/js/pages/contracts.js'

const CODE_EXAMPLES = {
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
    return this.inertia(appPages.posts.index, {
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

const SHIKI_THEME = 'rose-pine-moon'

let highlightedCache: Record<string, string> | null = null

async function getHighlightedExamples(): Promise<Record<string, string>> {
  if (highlightedCache) return highlightedCache

  const entries = await Promise.all(
    Object.entries(CODE_EXAMPLES).map(async ([key, code]) => {
      const html = await codeToHtml(code, { lang: 'typescript', theme: SHIKI_THEME })
      return [key, html] as const
    }),
  )

  highlightedCache = Object.fromEntries(entries)
  return highlightedCache
}

export default class HomeController extends Controller {
  async index(): Promise<Response> {
    const codeExamples = await getHighlightedExamples()

    const props = {
      message: 'Build full-stack web apps blazingly fast.',
      codeExamples,
    }

    return this.inertia(webPages.home, props, { url: this.request.path, title: 'Guren' })
  }
}
