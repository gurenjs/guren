// Landing-page code sample sources. Pure data — shared by the request-path
// fallback (highlight-code-examples.ts) and scripts/prerender-docs.ts.

export interface HomeCodeExample {
  code: string
  lang: 'typescript' | 'tsx'
}

export const HOME_CODE_EXAMPLES: Record<string, HomeCodeExample> = {
  Routes: {
    lang: 'typescript',
    code: `import { Router } from '@guren/core'

export function routes(router: Router) {
  router.get('/posts', [PostController, 'index'])
  router.get('/posts/:id', [PostController, 'show'])

  router.middleware('auth').group((auth) => {
    auth.post('/posts', [PostController, 'store'])
  })
}`,
  },
  Controller: {
    lang: 'typescript',
    code: `export class PostController extends Controller {
  async index() {
    const posts = await Post.where('published', true).get()
    return this.inertia(pages.posts.Index, { posts }) // props are type-checked
  }

  async store() {
    const data = await this.validateBody(CreatePostSchema) // bad input? 422
    const user = await this.auth.userOrFail()              // no session? 401
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect(\`/posts/\${post.id}\`)
  }
}`,
  },
  Model: {
    lang: 'typescript',
    code: `export class Post extends defineModel(posts) {}

const post = await Post.findOrFail(id) // missing row? that's a 404

const latest = await Post
  .where('published', true)
  .orderBy('createdAt', 'desc')
  .get()`,
  },
  View: {
    lang: 'tsx',
    code: `import { Link } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'
import type { Data } from '@/.guren/data.gen'

interface Props {
  posts: Data.Post[] // the exact shape the controller sent
}

export default function Index({ posts }: Props) {
  return (
    <ul>
      {posts.map((post) => (
        <li key={post.id}>
          <Link href={route('posts.show', { id: post.id })}>{post.title}</Link>
        </li>
      ))}
    </ul>
  )
}`,
  },
}

export const HOME_SHIKI_THEME = 'rose-pine-moon'
