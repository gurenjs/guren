# 第 4 章: バリデーションとリソース

第 3 章ではスキーマをコントローラーの中に置き、ページには生のフィールドの写しを送っていました。この章では両方にきちんとした置き場所を与えます。ルート、コントローラー、フォームが共有する、人が書くようなメッセージ付きのバリデーターファイル。そして、投稿がブラウザからどう見えるかを決めるリソースクラスです。その後、編集、削除、ページネーションをテストで仕様化してエージェントに委ね、受け入れる前に `code-review` subagent を第二の読者として使います。

**この章で学ぶこと:**

- バリデーションの置き場所と、ひとつの Zod スキーマがルート契約、コントローラー、フォームを型付けする仕組み
- 422 レスポンスが運ぶもの、Inertia がフィールドのメッセージを `form.errors` に入れる仕組み
- リソースは何のためにあるか、なぜページは生のレコードを決して見ないのか
- 生成マニフェストの `Data.Post` がリソースに追随する仕組み
- subagent に変更のレビューを頼む方法と、その答えをどう扱うか

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. まずテスト: 人が書くメッセージ

今 `POST /posts` に空のフォームを送ると、スキーマは拒否しますが、文言は Zod 自身のものです。代わりに何が欲しいかを書きます。`tests/PostController.test.ts` にテストをひとつ足します。

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'

describe('PostController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('lists posts, newest first', async () => {
    await Post.create({ title: 'First post', body: 'Hello' })
    await Post.create({ title: 'Second post', body: 'Again' })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('serves the form for a new post', async () => {
    await http.get('/posts/create').assertOk()
  })

  it('stores a post and redirects to it', async () => {
    await http.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
  })

  it('rejects an empty post with a message per field', async () => {
    await http
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })
})
```

```bash run expect-fail
bun test
```

赤いのはメッセージだけです。ステータスはすでに 422 です。これが Guren のバリデーション失敗すべてに共通する形です。ステータス 422、フィールドをキーにした `errors` を持つ JSON ボディ、各フィールドはメッセージの配列。Inertia のフォームはまさにこれを読みます。

## 2. バリデーター

スキーマをコントローラーから専用ファイルへ移し、メッセージを与えます。`app/Http/Validators/PostValidator.ts` を作ります。

```ts file=app/Http/Validators/PostValidator.ts
import { z } from 'zod'

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>
```

次にルートへ束縛します。`routes/web.ts` を置き換えます。

```ts file=routes/web.ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`body: PostPayloadSchema` は**ルート契約**です。これ自体がリクエストを検証するわけではありません。コントローラーアクションでは、検証はコントローラーの `validateBody()` 呼び出しであり、その呼び出しがあることを `guren audit` が検査します。契約がすることは codegen への供給です。ルートのボディ型が生成される `ApiRoutes` の一部になり、次の節でフォームを型付けするのがそれです。

そしてコントローラーはスキーマをバリデーターから読みます。

```ts file=app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { PostPayloadSchema } from '../Validators/PostValidator.js'

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const posts = await Post.orderBy(['id', 'desc'])

    return this.inertia(pages.posts.Index, {
      posts: posts.map((post) => ({ id: post.id, title: post.title, body: post.body })),
    })
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: { id: post.id, title: post.title, body: post.body, createdAt: post.createdAt },
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)
    return this.redirect(`/posts/${post.id}`)
  }
}
```

```bash run
bun test
```

緑です。スキーマはひとつ、読み手は 3 つ。ルート契約、コントローラー、そして(次は)フォームです。

## 3. メッセージを表示する

ルート契約がフロントエンドに届くよう、マニフェストを再生成します。

```bash run
bun run codegen
```

そしてフォームを置き換えます。変更は 2 つ。データ型がルートから導出されるようになったことと、`form.errors` をレンダリングすることです。

```tsx file=resources/js/pages/posts/New.tsx
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type PostForm = RouteBody<ApiRoutes, 'posts.store'>

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '' })

  return (
    <>
      <Head title="New post" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="text-3xl font-bold text-g-heading">New post</h1>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              form.post(route('posts.store'))
            }}
          >
            <div>
              <input
                value={form.data.title}
                onChange={(event) => form.setData('title', event.target.value)}
                placeholder="Title"
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea
                value={form.data.body}
                onChange={(event) => form.setData('body', event.target.value)}
                placeholder="Body"
                rows={8}
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <button type="submit" className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Publish
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

`RouteBody<ApiRoutes, 'posts.store'>` は `{ title: string; body: string }` で、ルート契約を通して `PostPayloadSchema` から導出されています。スキーマにフィールドを足せばフォームの型もそれを得ますし、ルート名を打ち間違えれば型は `never` になります。形を書いたのはバリデーターの中の一度だけで、書き直すことなくブラウザまで届きました。

**チェックポイント:** [http://localhost:3333/posts/create](http://localhost:3333/posts/create) を開いて空のフォームを送信します。タイトルの下に「Title is required」、本文の下に「Body is required」。Inertia が 422 を受け取り、メッセージを `form.errors` に入れて同じページを再レンダリングしました。エラー処理は何も書いていません。

## 4. リソース

`index` も `show` も投稿の形をしたオブジェクトを手で組み立てていて、しかもどのフィールドを持つかで食い違っています。この写しには Guren での名前があります。**リソース**です。`app/Http/Resources/PostResource.ts` を作ります。

```ts file=app/Http/Resources/PostResource.ts
import { Resource } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
}

export class PostResource extends Resource<PostRecord, PostResourceData> {
  toArray(): PostResourceData {
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
    }
  }
}
```

リソースは、サーバーの外から投稿がどう見えるかを決める唯一の場所です。列が 4 つでは儀式に見えます。第 5 章でアプリにパスワードハッシュ付きのユーザーが加わったとき、`passwordHash` が決して prop にならないよう守っているのがリソースです。ここからのルールはこうです。**ページは生のレコードを受け取らない。**

コントローラーで使います。

```ts file=app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { PostResource } from '../Resources/PostResource.js'
import { PostPayloadSchema } from '../Validators/PostValidator.js'

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const posts = await Post.orderBy(['id', 'desc'])

    return this.inertia(pages.posts.Index, {
      posts: posts.map((post) => new PostResource(post).toJSON()),
    })
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)
    return this.redirect(`/posts/${post.id}`)
  }
}
```

ページには形を言い直させず、import させます。

```tsx file=resources/js/pages/posts/Index.tsx
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  posts: PostResourceData[]
}

export default function PostsIndex({ posts }: Props) {
  return (
    <>
      <Head title="Posts" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
              <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
              Posts
            </h1>
            <Link href={route('posts.create')} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              New post
            </Link>
          </div>
          {posts.length === 0 && <p className="text-g-text-2">No posts yet.</p>}
          <div className="space-y-4">
            {posts.map((post) => (
              <article key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card">
                <Link href={route('posts.show', { id: post.id })} className="text-xl font-bold text-g-heading transition hover:text-g-accent-text">
                  {post.title}
                </Link>
                <p className="mt-2 text-sm text-g-text-2">{post.body}</p>
              </article>
            ))}
          </div>
        </div>
      </main>
    </>
  )
}
```

```tsx file=resources/js/pages/posts/Show.tsx
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
}

export default function PostShow({ post }: Props) {
  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">{post.createdAt}</p>
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
        </div>
      </main>
    </>
  )
}
```

```bash run
bun run codegen
```

codegen はリソースに気づきました。`.guren/data.gen.ts` が `PostResourceData` と同じ形の `Data.Post` を export するようになり、リソースを import せずに投稿の型を名指ししたいコードから使えます。すべて走らせます。

```bash run
bun test
```

緑で、観察できる変化は何もありません。テストの下でのリファクタリングとはこういうものです。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: validate posts with messages and shape them with a resource"
```

## 5. CRUD の残りを仕様化する

編集、更新、削除、そして 10 件ごとのページネーション。テストファイルを置き換えます。

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'

describe('PostController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('lists posts, newest first', async () => {
    await Post.create({ title: 'First post', body: 'Hello' })
    await Post.create({ title: 'Second post', body: 'Again' })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
  })

  it('paginates ten posts per page', async () => {
    for (let i = 1; i <= 11; i++) {
      await Post.create({ title: `Post ${String(i).padStart(2, '0')}`, body: `Body number ${i}` })
    }

    const firstPage = await http.get('/posts').assertOk()
    await firstPage.assertBodyContains('Post 11')
    await firstPage.assertBodyContains('Post 02')
    expect(await firstPage.text()).not.toContain('Post 01')

    const secondPage = await http.get('/posts?page=2').assertOk()
    await secondPage.assertBodyContains('Post 01')
    expect(await secondPage.text()).not.toContain('Post 02')
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('serves the form for a new post', async () => {
    await http.get('/posts/create').assertOk()
  })

  it('stores a post and redirects to it', async () => {
    await http.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
  })

  it('rejects an empty post with a message per field', async () => {
    await http
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })

  it('serves the edit form with the post in it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    const response = await http.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('updates a post and redirects to it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await http.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await http
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post and redirects to the list', async () => {
    const post = await Post.create({ title: 'Doomed', body: 'Gone soon' })

    await http.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })
})
```

```bash run expect-fail
bun test
```

赤が 5 つ。委ねる前にもう一度読んでください。編集ページは投稿を運ぶこと、更新と削除は読者が期待する場所へリダイレクトすること、不正な更新は不正な作成と同じ形で失敗すること、11 件目の投稿は 2 ページ目に落ちること。これでスライスの仕様は完全です。

## 6. 委ねる

エージェントに頼みます。

> Complete the posts CRUD. Add `edit`, `update` and `destroy` actions to `PostController` using route model binding like `show`, and register `GET /posts/:id/edit` (`posts.edit`), `PUT /posts/:id` (`posts.update`, with `body: PostPayloadSchema`) and `DELETE /posts/:id` (`posts.destroy`). Add `resources/js/pages/posts/Edit.tsx` as a form like `New.tsx` that submits with `form.put`, and give `Show.tsx` an Edit link and a Delete button. Paginate `index` at ten posts per page with `Post.paginate` and the `paginate` helper, validating `?page=` with a `ListPostsQuerySchema` in the validator, and render the page links in `Index.tsx`. Use `PostResource` for every post sent to a page. `tests/PostController.test.ts` describes all of it; make it pass.

ここまでで最大のスライスなので、この章のハーネス要素にふさわしい場面です。`.claude/agents/code-review.md` の **`code-review` subagent** です。subagent は独自の brief と独自のコンテキストを持つエージェントで、メインのエージェントが呼び出します。この subagent の brief は Guren のコードレビューです。すべての変更系ルートにバリデーションがあるか、すべてのレコードの前にリソースがあるか、ルートの順序、`audit` と `check` が見るものとそれらには見えないいくつかのこと。エージェントが完了を報告したら、自分で rubric を確かめる前にこう頼んでください。

> Use the code-review subagent to review the uncommitted changes.

返ってきたものを、下の自分の rubric と並べて読んでください。固定された brief を持つ第二の読者は、作業の渦中にいる第一の読者とは違うものを捕まえますし、費用は一文だけです。第 8 章ではその brief を自分で書きます。

**手元にエージェントが無い場合は、** 6 ファイルです。バリデーターはクエリのスキーマを得ます。

```ts file=app/Http/Validators/PostValidator.ts fallback
import { z } from 'zod'

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})
```

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { ListPostsQuerySchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }
}
```

```ts file=routes/web.ts fallback
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.get('/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    posts.put('/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    posts.delete('/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```tsx file=resources/js/pages/posts/Index.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function PostsIndex({ data, pagination }: Props) {
  return (
    <>
      <Head title="Posts" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
              <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
              Posts
            </h1>
            <Link href={route('posts.create')} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              New post
            </Link>
          </div>
          {data.length === 0 && <p className="text-g-text-2">No posts yet.</p>}
          <div className="space-y-4">
            {data.map((post) => (
              <article key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card">
                <Link href={route('posts.show', { id: post.id })} className="text-xl font-bold text-g-heading transition hover:text-g-accent-text">
                  {post.title}
                </Link>
                <p className="mt-2 text-sm text-g-text-2">{post.body}</p>
              </article>
            ))}
          </div>
          {pagination?.links?.pages && pagination.links.pages.length > 1 && (
            <nav className="flex gap-2 font-mono text-sm">
              {pagination.links.pages.map((page) => (
                <Link key={page.page} href={page.url ?? '#'} className="rounded-g-ctl border border-g-line px-3 py-1 text-g-text-2 transition hover:border-g-line-strong hover:text-g-heading">
                  {page.page}
                </Link>
              ))}
            </nav>
          )}
        </div>
      </main>
    </>
  )
}
```

```tsx file=resources/js/pages/posts/Show.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
}

export default function PostShow({ post }: Props) {
  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">{post.createdAt}</p>
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          <div className="flex items-center gap-4">
            <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
              Edit
            </Link>
            <Link
              href={route('posts.destroy', { id: post.id })}
              method="delete"
              as="button"
              onBefore={() => window.confirm('Delete this post?')}
              className="rounded-g-ctl border border-g-danger-chip px-3 py-1 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint"
            >
              Delete
            </Link>
          </div>
        </div>
      </main>
    </>
  )
}
```

```tsx file=resources/js/pages/posts/Edit.tsx fallback
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

type PostForm = RouteBody<ApiRoutes, 'posts.update'>

interface Props {
  post: PostResourceData
}

export default function EditPost({ post }: Props) {
  const form = useForm<PostForm>({ title: post.title, body: post.body })

  return (
    <>
      <Head title={`Edit: ${post.title}`} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="text-3xl font-bold text-g-heading">Edit post</h1>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              form.put(route('posts.update', { id: post.id }))
            }}
          >
            <div>
              <input
                value={form.data.title}
                onChange={(event) => form.setData('title', event.target.value)}
                placeholder="Title"
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea
                value={form.data.body}
                onChange={(event) => form.setData('body', event.target.value)}
                placeholder="Body"
                rows={8}
                className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
              />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <button type="submit" className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Save
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

再生成して仕様を走らせます。

```bash run
bun run codegen
```

```bash run
bun test
```

rubric は次のとおりで、subagent の指摘と並べて読んでください。

- `update` と `destroy` は `this.model(Post)` で投稿を解決し、`update` は `store` と同じ `PostPayloadSchema` で検証している。両方のルートに `bind` があり、`update` には `body` もある。
- `index` は `?page=` を `validateQuery` とスキーマで検証している。素の `Number(query.page)` は指摘対象。
- ページに届くすべての投稿が `PostResource` を通っている。編集ページのフォーム型は `RouteBody<ApiRoutes, 'posts.update'>`。
- `Show.tsx` の削除は確認付きの `method="delete"` リンクで、削除する `GET` ルートではない。
- 11 件のテストがすべて緑。

**チェックポイント:** [http://localhost:3333/posts/create](http://localhost:3333/posts/create) で投稿を 12 件作り(フォームに付き合える範囲で少なくても構いません)、2 ページ目が現れるのを見てください。1 件編集し、1 件削除します。

```bash run
bunx guren gate
```

```bash run
bunx guren audit
```

今度は警告が 3 つです。`POST`、`PUT`、`DELETE /posts` に認証チェックがありません。相変わらず正しく、相変わらず意図的で、相変わらず第 6 章です。

```bash run
git add -A
git commit -m "feat: complete the posts CRUD with pagination"
```

## いまいる場所

- 人が読めるメッセージ付きのバリデーターファイル。ルートに束縛され、コントローラーが読み、フォームを型付けしている。
- 投稿がどう見えるかを決めるリソースと、それに追随する `Data.Post` 型。
- 11 件のテストで仕様化し、エージェントが作り、subagent とあなたがレビューした、フル CRUD とページネーション。
- 意図的に抱えている audit の警告 3 件。

## よくあるつまずき

- **`RouteBody<ApiRoutes, 'posts.store'>` が `never` になる。** ルートに `body:` 契約が無いか、足してから codegen が走っていません。`routes/web.ts` を確認してから `bun run codegen` を実行してください。
- **422 のテストは通るのにブラウザにメッセージが出ない。** ページは `form.errors.title` をレンダリングしています。フィールド名がスキーマのキーと正確に一致しているか確認してください。Inertia はサーバーが返したキーのエラーだけを埋めます。
- **`Post.update` が `id` について文句を言う。** `update` は最初に `where` オブジェクト、次にデータを取ります。`Post.update({ id }, data)` です。バリデーション済みデータに `id` が含まれることはなく、含まれても `fillable` が落とします。
- **2 ページ目に何も出ない。** `perPage` が 10 でないか、`orderBy` が無くて挿入順になっており、どの投稿がどこに落ちるかというテストの期待が成り立っていません。
- **Delete ボタンが 404 へ遷移する。** `Link` には `method="delete"` が要ります。無いとブラウザは destroy の URL に `GET` を発行し、それはルートではありません。

## 次へ

[第 5 章: ユーザーとパスワード](./05-users-and-passwords.md) では、users テーブルにモデルを与え、パスワードをハッシュし、登録・ログイン・ログアウトを手で組みます。
