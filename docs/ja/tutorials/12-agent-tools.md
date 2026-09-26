# 第 12 章: アプリをエージェントのツールにする

ここまでの 11 章では、人が読むブログを作ってきました。この章では同じアプリを、別の種類の呼び出し元にも開きます。すでに書いたルートを通して投稿を読み、下書きを公開するエージェントです。

新しく API を作るわけではありません。ツールは、すでにあるルートに、名前と、エージェントが読める契約と、呼び出すと何が起きるかの宣言を加えたものです。この宣言を加えると、ルートの扱いが変わります。チェックが厳しくなり、第 7 章では警告しか出せなかった抜けに対して、そのうちの 1 つがついに失敗を返します。

**この章で学ぶこと:**

- ツールを構成する要素: 名前、入力スキーマ、出力の形、注釈
- ページのルートとツール向けのルートで出力の記述方法が違う理由と、取り違えたときに壊れるもの
- 認可の無い、変更を伴うツールをビルドの失敗にするルール
- エージェントとまったく同じ手順で、テストから自分のツールを呼び出す方法
- Guren アプリにある 2 つの MCP エンドポイントと、それぞれの役割

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. ルートを 1 つツールとして宣言する

`posts.show` には、ツールに必要なものが宣言以外すべてそろっています。その宣言を足します。

```ts file=routes/web.ts
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import { PostIdParamSchema, PostImageParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth.post('/posts/:id/publish', { bind: { id: Post }, name: 'posts.publish' }, [PostController, 'publish'])
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ toolName: 'posts_show', description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`.agent()` が受け取るのはツールの説明と注釈だけで、スキーマは受け取りません。エージェントがルートを*呼び出す*のに必要な情報は、すべてルートがすでに持っている契約から取られます。`params`、`query`、`body` は 1 つのフラットな入力オブジェクトにまとめられ、返ってくるものは `resource` か `output` が記述します。この設計では、ツールはルートの別の見え方として扱われ、定義はルートの 1 か所にしかありません。

自分で書く名前は `toolName` だけです。省略すると、ツールはルート名の `posts.show` で公開されます。MCP はドットを許しますが、Claude と OpenAI のツール API は `^[A-Za-z0-9_-]{1,64}$` に合う名前しか受け付けません。Claude Managed Agents のように、この規則を MCP のツールにも当てはめるクライアントは、ドットを含む名前を黙って落とします。`posts_show` なら、どのクライアントからも呼び出せます。ルート名、`route('posts.show')`、URL は変わりません。変わるのはエージェントに見える名前だけで、テストから呼び出すときもこの名前を使います。

ツールのマニフェストは生成コードなので、生成し直します。

```bash run
bun run codegen
```

宣言した内容を確認します。

```bash run
bunx guren tool:list
```

出力は 1 行 7 列です。ツール名、その裏にあるメソッドとパス、各プロトコルに公開されるかどうか、認可に使う ability、注釈が並びます。`posts_show` が `read-only, idempotent` になっているのは `GET` だからで、`guren` は注釈を書かせずに、メソッドから判断しています。

```bash run
bunx guren tool:inspect posts_show
```

```bash manual
posts_show     GET /posts/:id
Route:         posts.show
Description:   Read one post by id, with its author, tags and comments.
Exposure:      mcp=yes webMcp=yes
Annotations:   read-only, idempotent
Authorization: (not statically derivable)

Input
  id: integer

Output
  (no output schema; response declared by PostResource, CommentResource)
```

`Route` の行が出ているのは、ツール名とルート名が別になったためです。`id: string` ではなく `id: integer` になっているのは、`PostIdParamSchema` が文字列を数値に変換(coerce)するからです。このスキーマは第 9 章でコントローラーのために書いたものですが、いまではツールの引数リストも兼ねています。契約をアクションの中だけでなくルートに置いておくと、このように使い回せます。

## 2. ツールのテストを先に書く

ツールのテストには、モデルのクライアントもネットワークも要りません。`TestApp` はサーバーと同じ導出結果を公開していて、呼び出しはほかのテストリクエストと同じ `fetch` を通ります。

```ts file=tests/AgentTools.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post, type PostRecord } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('agent tools', () => {
  let http: TestApp
  let ada: UserRecord
  let grace: UserRecord
  let post: PostRecord

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    post = await Post.forceCreate({ title: 'On tools', body: 'A body', authorId: ada.id })
  })

  it('exposes the reading tools to anyone', async () => {
    const names = (await http.agent().tools()).map((tool) => tool.toolName)
    expect(names).toContain('posts_index')
    expect(names).toContain('posts_show')

    const result = await http.agent().call('posts_show', { id: post.id }).assertOk()
    expect(result.text).toContain('On tools')
  })

  it('publishes through a tool, and answers with the post', async () => {
    const asAda = await http.actingAs(ada).withCsrf()

    const published = await asAda.agent().call('posts_publish', { id: post.id }).assertOk()

    expect(published.structuredContent?.post).toMatchObject({ id: post.id, title: 'On tools' })
    const fresh = await Post.findOrFail(post.id)
    expect(fresh.publishedAt).not.toBeNull()
  })

  it('refuses to publish someone else\'s post', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    await asGrace.agent().call('posts_publish', { id: post.id }).assertStatus(403)

    const fresh = await Post.findOrFail(post.id)
    expect(fresh.publishedAt).toBeNull()
  })
})
```

最後のテストは特にじっくり読んでください。第 7 章で書いたのと同じ 403 に、HTTP リクエストの代わりにツール呼び出しから到達していて、通る理由も同じです。ルートが実行されるので、ポリシーも実行されます。ツール呼び出しは本物のミドルウェアチェーンを通る本物のリクエストで、抜け道にはなりません。これまでに書いたガードは、すべてツール呼び出しの手前でも働きます。

```bash run expect-fail
bun test
```

テストは失敗します。`posts.publish` と `posts.index` がまだツールになっていないからです。

## 3. 変更を伴うツール

宣言するルートは 2 つで、それぞれ必要なものが違います。

`posts.index` も `posts.show` と同じページのルートなので、扱いも同じです。ページングをエージェントに伝える `query` の契約と、返す形を示す `resource` のヒントを付けます。

`posts.publish` は事情が異なり、この違いから学べることがあります。ブラウザにはリダイレクトで応答していて、フォームにはそれで正しいのですが、エージェントには役に立ちません。リダイレクトには投稿の内容が含まれないからです。そこでアクションが 2 通りの応答を返せるようにし、ルートではエージェントに JSON 版を返すと約束します。

```ts file=app/Http/Validators/PostValidator.ts
import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const PostImageParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  attachment: z.string().min(1),
})

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
  tags: z
    .string()
    .default('')
    .transform((value) => [...new Set(value.split(',').map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))]),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})

/** The action takes no payload; the empty object is what an agent is told to send. */
export const PublishPayloadSchema = z.object({})

/**
 * What `posts.publish` answers a tool call with. An `output` schema is enforced:
 * a 2xx body that does not match it becomes a 500 rather than reaching the
 * caller, and keys it does not name are stripped from the response.
 */
export const PublishResponseSchema = z.object({
  post: z.object({
    id: z.number(),
    title: z.string(),
    publishedAt: z.string().nullable(),
    author: z.object({ id: z.number(), name: z.string() }).nullable(),
    tags: z.array(z.string()),
  }),
})
```

アクションはリクエストを見て応答を選びます。

```ts file=app/Http/Controllers/PostController.ts
import { Controller, ValidationException, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
import { PostPublished } from '../../Events/PostPublished.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostImageParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function syncTags(postId: number, names: string[]): Promise<void> {
  await PostTag.delete({ postId })
  for (const name of names) {
    const tag = (await Tag.first({ name })) ?? (await Tag.create({ name }))
    await PostTag.forceCreate({ postId, tagId: tag.id })
  }
}

export default class PostController extends Controller {
  /**
   * A tool call is an ordinary request carrying this header (the agent surface
   * sets it); a browser never does. Every guard still runs either way.
   */
  private isToolCall(): boolean {
    return this.ctx.req.header('X-Guren-Agent-Surface') !== undefined
  }

  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.withPaginate('author', { page, perPage: 10, orderBy: ['id', 'desc'] })
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
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, ['author', 'tags'])
    const [withFiles] = await Post.withAttachments([post], ['cover', 'images'])
    const comments = await Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(withFiles!).toJSON(),
      canManage: await this.can('update', [Post, post]),
      comments: await Promise.all(
        comments.map(async (comment) => ({
          ...new CommentResource(comment).toJSON(),
          canDelete: await this.can('delete', [Comment, comment]),
        })),
      ),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const author = await this.auth.userOrFail<UserRecord>()
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    await syncTags(post.id, tags)
    const cover = await this.file('cover')
    if (cover) {
      await Post.attach(post.id, 'cover', cover)
    }
    for (const file of await this.files('images')) {
      await Post.attach(post.id, 'images', file)
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const withTags = await Post.findWithOrFail(post.id, 'tags')

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(withTags).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    await syncTags(post.id, tags)
    return this.redirect(`/posts/${post.id}`)
  }

  async cover(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const cover = await this.file('cover')
    if (!cover) {
      throw new ValidationException({ cover: ['Choose an image.'] })
    }
    await Post.attach(post.id, 'cover', cover)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroyImage(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const { attachment } = this.validateParams(PostImageParamSchema)
    await Post.detach(post.id, 'images', attachment)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.purgeAttachments(post.id)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
    await this.make('events').emit(new PostPublished(post.id))

    if (this.isToolCall()) {
      const fresh = await Post.findWithOrFail(post.id, ['author', 'tags'])
      return this.json({ post: new PostResource(fresh).toJSON() })
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async unpublish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: null })
    return this.redirect(`/posts/${post.id}`)
  }
}
```

アクションは 1 つ、相手は 2 種類、ポリシーは 1 つです。認可も更新もイベントも分岐より前にあり、違うのは最後の 1 行だけです。既存のアクションをツールにするときは、いつもこの形にしてください。この章で 2 つ目のコントローラーを作らないのも、そのためです。

次はルートです。

```ts file=routes/web.ts
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostImageParamSchema,
  PostPayloadSchema,
  PublishPayloadSchema,
  PublishResponseSchema,
} from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth
      .post('/posts/:id/publish', {
        bind: { id: Post },
        name: 'posts.publish',
        params: PostIdParamSchema,
        body: PublishPayloadSchema,
        output: PublishResponseSchema,
      }, [PostController, 'publish'])
      .agent({ toolName: 'posts_publish', description: 'Publish a draft post. Only the post\'s author may call it.' })
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router
    .get('/posts', { name: 'posts.index', query: ListPostsQuerySchema, resource: { data: [PostResource] } }, [PostController, 'index'])
    .agent({ toolName: 'posts_index', description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ toolName: 'posts_show', description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`posts.publish` には契約が 3 つあり、どれも欠かせません。`params` はエージェントが送る id に型を付けます。空のオブジェクトの `body` は、このアクションがペイロードを取らないことをツールとして示す書き方で、これが無いと、エージェントに何を送ればよいか分からないとチェックが警告します。`output` は約束であり、実行時に実際に検査されます。合致しない 2xx のレスポンスは呼び出し元に届かずに 500 になり、スキーマに無いフィールドは取り除かれます。ページのルートでは代わりに `resource` を使います。こちらは型レベルだけの記述です。ブラウザに Inertia のページを返すルートに `output` スキーマを置くと、そのページまで検証しようとしてしまうからです。

```bash run
bun run codegen
```

```bash run
bun test
```

テストが通ります。

```bash run
bunx guren tool:list
```

ツールは 3 つです。`posts_publish` は `destructive` ですが、`Auth` 列のどこにも `publish` は出てきません。ability をアクションの中で決めているためです。`-` と表示された列は「静的には導出できない」という意味で、「認可されていない」という意味ではありません。

## 4. チェックが初めて失敗する

ここまでの変更をコミットしてください。次の手順で、わざと壊します。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: expose reading and publishing as agent tools"
```

第 7 章は、すっきりしない形で終わりました。ポリシーを書いたのに、ポリシーを一度も呼ばないルートでも `guren audit` が通ってしまうと分かったからです。audit が確かめるのは、変更を伴うルートが*ユーザー*を要求するかどうかまでで、*どの*ユーザーかは見ません。誰でも編集できるブログになるのを防いでいたのは、テストだけでした。

ルートをツールとして宣言すると、この状況が変わります。`publish` から認可を取り除いてください。`unpublish` も同じ ability を確かめているので、この `sed` はそちらの行も消します。下のチェックが報告するのは、2 つのうちツールになっている `publish` だけです。

```bash run
sed -i.bak "/this.authorize('publish'/d" app/Http/Controllers/PostController.ts && rm app/Http/Controllers/PostController.ts.bak
```

```bash run expect-fail
bunx guren check --ci
```

```bash manual
ERROR  [fail] POST /posts/:id/publish agent tool: Authenticated but not authorized: the route
establishes who the caller is, but nothing decides whether that caller may perform this action.
A non-read-only tool hands every authenticated principal — every agent holding any token — the
whole action.
       → Add authorize()/authorizeResource() middleware to the route, or call
await this.authorize(ability, ...) in the action. Mark the tool agent: { readOnlyHint: true }
only if it truly changes nothing — that claim is itself checked against the action's body.

Results: 25 passed, 0 warnings, 1 failures
```

何が変わり、何が変わっていないかを見てください。`guren audit` は相変わらずこのルートを通します。ルートは `auth` グループの中にあってユーザーを要求しており、audit が確かめるのはそこまでだからです。ルートのテストならこの問題を捕まえますし、そのテストはすでに書いてあります。チェックが加わったことで、テストを 1 件も実行しなくても、*ビルド*の段階で拒否されるようになりました。変更を伴うツールは、それまでのルートとは性質の違う約束だからです。顔を合わせることのない呼び出し元に差し出すアクションであり、「認証済みの誰か」が人であるとは限りません。

元に戻してください。

```bash run
git checkout -- app/Http/Controllers/PostController.ts
```

```bash run
bunx guren check --ci
```

再び通るようになりました。この `--ci` はハーネスからも実行されます。`guren gate` が実行するほか、エージェントが作業を終えようとしたときには `Stop` hook が実行します。そのため、ルートをツールとして公開したのにポリシーを忘れたエージェントは、作業を終わったことにできません。


## 5. コメント用ツールのテストを先に書く

投稿を読めるエージェントなら、人と同じルールのもとで、それにコメントを返せてもよいはずです。

```ts file=tests/AgentComments.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Comment } from '../app/Models/Comment.js'
import { Post, type PostRecord } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('comment tools', () => {
  let http: TestApp
  let ada: UserRecord
  let grace: UserRecord
  let post: PostRecord

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    post = await Post.forceCreate({ title: 'On tools', body: 'A body', authorId: ada.id })
  })

  it('writes a comment through a tool and answers with it', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    const result = await asGrace.agent().call('comments_store', { id: post.id, body: 'Read it twice' }).assertOk()

    expect(result.structuredContent?.comment).toMatchObject({ body: 'Read it twice' })
    const stored = await Comment.where('postId', post.id).first()
    expect(stored?.authorId).toBe(grace.id)
  })

  it('validates the comment it is given', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    const result = await asGrace.agent().call('comments_store', { id: post.id, body: '   ' }).assertStatus(422)

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Say something')
  })

  it('refuses to delete someone else\'s comment', async () => {
    const comment = await Comment.forceCreate({ body: 'Mine', postId: post.id, authorId: ada.id })
    const asGrace = await http.actingAs(grace).withCsrf()

    await asGrace.agent().call('comments_destroy', { id: comment.id }).assertStatus(403)

    expect(await Comment.find(comment.id)).not.toBeNull()
  })
})
```

真ん中のテストは覚えておいてください。不正な引数を送ったツール呼び出しは、プロトコルのエラーにはならず、バリデーター自身のメッセージを含むエラー結果として返ってきます。エージェントは、人が受け取るのと同じ内容を、同じスキーマから同じ文言で受け取ります。

```bash run expect-fail
bun test
```

今回は 3 件とも失敗し、偶然通るテストはありません。その理由は知っておくと役に立ちます。`agent().call()` はリクエストを組み立てる前にツールを名前で探すので、まだ公開されていない名前を渡すと、ステータスを返さずに `No agent tool named "comments_destroy"` という例外を投げます。403 を期待している拒否のテストでも、存在しないツールでは拒否まで進めません。

## 6. エージェントに任せる

エージェントに次のプロンプトを送ります。

```text
Expose the comment routes as agent tools. `comments.store` and `comments.destroy` should be callable by an agent as `comments_store` and `comments_destroy`, follow the same pattern `posts.publish` uses (a `toolName`, a `params` schema, a `body` schema where the action takes one, an `output` schema, and a JSON answer for a tool call while the browser keeps its redirect), and keep the policies they already have. `tests/AgentComments.test.ts` describes them; make it pass.
```

このプロンプトは認可に触れていませんが、触れる必要はありません。いまは 2 つの仕組みが見張っているからです。第 8 章の所有権のルールと、`guren check --ci` です。後者は、エージェントがポリシーを呼ばずに `comments.destroy` を公開すれば、ビルドをそのまま失敗させます。diff で `output` スキーマを確認してから、チェックを実行してください。

**手元にエージェントが無い場合は、** バリデーターに契約を 2 つ追加します。

```ts file=app/Http/Validators/CommentValidator.ts fallback
import { z } from 'zod'

export const CommentIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1, 'Say something').max(2000, 'Comments are 2000 characters or fewer'),
})

const CommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  createdAt: z.string(),
  author: z.object({ id: z.number(), name: z.string() }).nullable(),
})

export const CommentResponseSchema = z.object({ comment: CommentSchema })

export const CommentDeletedSchema = z.object({ deleted: z.number() })
```

```ts file=app/Http/Controllers/CommentController.ts fallback
import { Controller } from '@guren/core'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPosted } from '../../Events/CommentPosted.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

export default class CommentController extends Controller {
  private isToolCall(): boolean {
    return this.ctx.req.header('X-Guren-Agent-Surface') !== undefined
  }

  async store(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('create', Comment)
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(CommentPayloadSchema)
    const comment = await Comment.forceCreate({ ...data, postId: post.id, authorId: author.id })
    await this.make('events').emit(new CommentPosted(comment.id))

    if (this.isToolCall()) {
      const fresh = await Comment.findWithOrFail(comment.id, 'author')
      return this.json({ comment: new CommentResource(fresh).toJSON() })
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    await Comment.delete({ id: comment.id })

    if (this.isToolCall()) {
      return this.json({ deleted: comment.id })
    }
    return this.redirect(`/posts/${comment.postId}`)
  }
}
```

```ts file=routes/web.ts fallback
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostImageParamSchema,
  PostPayloadSchema,
  PublishPayloadSchema,
  PublishResponseSchema,
} from '../app/Http/Validators/PostValidator.js'
import {
  CommentDeletedSchema,
  CommentIdParamSchema,
  CommentPayloadSchema,
  CommentResponseSchema,
} from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth
      .post('/posts/:id/publish', {
        bind: { id: Post },
        name: 'posts.publish',
        params: PostIdParamSchema,
        body: PublishPayloadSchema,
        output: PublishResponseSchema,
      }, [PostController, 'publish'])
      .agent({ toolName: 'posts_publish', description: 'Publish a draft post. Only the post\'s author may call it.' })
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth
      .post('/posts/:id/comments', {
        bind: { id: Post },
        name: 'comments.store',
        params: PostIdParamSchema,
        body: CommentPayloadSchema,
        output: CommentResponseSchema,
      }, [CommentController, 'store'])
      .agent({ toolName: 'comments_store', description: 'Add a comment to a post, as the calling user.' })
    auth
      .delete('/comments/:id', {
        bind: { id: Comment },
        name: 'comments.destroy',
        params: CommentIdParamSchema,
        output: CommentDeletedSchema,
      }, [CommentController, 'destroy'])
      .agent({ toolName: 'comments_destroy', description: 'Delete one comment. Only its author may call it.' })
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router
    .get('/posts', { name: 'posts.index', query: ListPostsQuerySchema, resource: { data: [PostResource] } }, [PostController, 'index'])
    .agent({ toolName: 'posts_index', description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ toolName: 'posts_show', description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

確認項目は次のとおりです。

- コメントのルートは両方とも `toolName`(`comments_store`、`comments_destroy`)、`params` スキーマ、`output` スキーマを持ち、`comments.store` は `body` の契約を保っている。`guren check --ci` が通る、つまり入力や出力の記述が欠けたツールは 1 つも無い。
- どのアクションも `authorize()` の呼び出しを残していて、JSON の分岐はその*あと*にある。エージェント向けの応答がポリシーより前にあると、そのポリシーはブラウザからのリクエストにしか効きません。
- ブラウザでは今までどおりリダイレクトする。ブラウザでコメントを投稿すると、投稿のページに戻る。
- エージェントのテスト 6 件が通る。`Say something` を含む 422 と、他人のコメントに対する 403 もここに含まれる。

```bash run
bunx guren tool:list
```

ツールは 5 つになりました。読み取りが 2 つ、何かを変更するものが 3 つで、どのツールにも、フレームワークから見える ability か、アクションが強制するポリシーが付いています。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: expose the comment routes as agent tools"
```

## 7. 2 つのエンドポイントの違い

アプリにはもうツールがあります。それを実際のエージェントに渡すには、プラグインを 1 つ入れるだけです。

```bash manual
bunx guren plugin @guren/plugin-mcp
```

```ts manual
// src/app.ts
import { mcpPlugin } from '@guren/plugin-mcp'
import { DatabaseApiTokenStore } from '@guren/core'
import { apiTokens } from '../db/schema.js'

const app = createApp({
  routes: registerWebRoutes,
  providers: [AuthProvider, /* … */ mcpPlugin()],
})

// The endpoint verifies bearer tokens against this store, and a token's
// scopes decide which of your tools it may call.
app.auth.useTokens(new DatabaseApiTokenStore(apiTokens))
```

このコマンドで `/mcp` がマウントされます。本番で動く実際のエンドポイントで、`tools/list` には宣言したツールを返し、各呼び出しはアプリのミドルウェアを通る通常のリクエストとして実行します。bearer トークン、トークンごとのツールのスコープ、レート制限で保護されていて、トークンストアが必要になり、そのためのテーブルも要ります。これは第 14 章で、本番公開に向けたほかの作業と一緒に扱います。

エディターがすでに接続しているエンドポイントと混同しないでください。`GUREN_MCP=1` を指定すると、開発時に限って `/_guren/mcp` がマウントされ、ループバックインターフェース以外からの呼び出しはすべて拒否されます。そのツールは `guren_check`、`guren_gate`、`guren_get_context` などで、*プロジェクト*に対して働く、アプリを書くエージェントのためのものです。プラグインのツールは*アプリケーション*に属し、アプリを使うエージェントのためのものです。プロトコルは同じで、向きが逆です。前者は第 8 章のハーネスですでに設定済みです。

プラグインを入れる前は `/mcp` のルートがありませんが、POST すると 404 ではなく 403 の `CSRF token mismatch` が返ります。CSRF の検証はルーティングより前に実行されるので、トークンを持たないリクエストには、存在しないパスでも同じ応答が返ります。

## ここまでの状態

- 5 つのルートがツールとしても使えます。どのルートにも、エージェントが読む入力スキーマと、頼りにできる出力の形があります。
- ブラウザとエージェントに対して最後の 1 行だけ違う応答を返し、それ以外はまったく同じ処理をするアクションが 1 つあります。
- 認可のない変更系のツールがあるとビルドが失敗します。第 7 章ではテストでしか塞げなかった穴です。
- テストスイートからツールを呼び出しています。その呼び出しも、ほかのリクエストと同じミドルウェア、ポリシー、バリデーターを通ります。

## よくあるつまずき

- **`guren check` がマニフェストが無いと報告する。** `.agent()` を宣言すると、`.guren/agents.gen.ts` がアプリの一部になります。`bun run codegen` を実行してください。
- **ツール名が `^[A-Za-z0-9_-]{1,64}$` に合わないと `guren check` が警告する。** ルートに `.agent()` はあるものの `toolName` が無いため、ツールがドットを含むルート名のまま公開されています。この章のツールと同じように、アンダースコアでつないだ `toolName` を付けてください。この警告は参考扱い(`advisory`)なので `guren gate` は通りますが、ツールを落とすクライアントの側も何も知らせてくれません。
- **エージェントに何を送ればよいか見えない、とツールが警告する。** `POST`、`PUT`、`PATCH` のツールには、ペイロードを取らないものでも `body` スキーマが必要です。その場合は `z.object({})` と書くのが正確です。
- **ツール呼び出しが `Response validation failed` の 500 になる。** `output` スキーマと、アクションが返す JSON が食い違っています。スキーマは 2xx のレスポンスに対して強制されるもので、それがこのスキーマの役目です。間違っているほうを直してください。
- **ツール呼び出しが `HTTP 302 (Location: …)` を返す。** アクションがリダイレクトしたため、エージェントが読める内容がありません。`publish` と同じように JSON の分岐を加えてください。
- **スキーマを足したら Inertia のページが壊れた。** ページのルートに `output` スキーマを置くと、ページの JSON まで検証されます。ページのルートは、型レベルだけの `resource` で自身を記述してください。
- **ツール呼び出しが 419 か CSRF のエラーになる。** `actingAs()` でユーザーを設定したアプリを `withCsrf()` で組み立ててから、`agent()` を呼んでください。テストの中のツール呼び出しも、ほかと同じく cookie セッションを使うリクエストです。

## 演習

1. `posts.publish` に `agent: { readOnlyHint: true }` を足して、`bunx guren check --ci` を実行してください。指摘を読んだら、ヒントを消してください。間違った注釈が、ポリシーの欠落と同じくらい重く扱われるのはなぜでしょうか。
2. どの投稿にも無い id を指定して、`TestApp.agent()` から `posts_show` を呼んでください。エージェントは何を受け取りますか。同じ URL にブラウザでアクセスした場合と比べ、その差のうちどこがフレームワークによるもので、どこがアプリのコードによるものかを答えてください。

<details>
<summary>演習 1: ヒントと答えの例</summary>

ヒントは `routes/web.ts` にあるルートの `.agent()` 呼び出しに書きます。

```ts
.agent({ toolName: 'posts_publish', description: 'Publish a draft post. Only the post\'s author may call it.', readOnlyHint: true })
```

`guren check --ci` は `posts.publish` のツールで失敗します。ルートは `readOnlyHint: true` を宣言しているのに、アクションがレコードを書き換えているからです。チェックは `publish` の本体を読んで `Post.forceUpdate` を見つけ、advisory ではない警告を出します。`--ci` が失敗するにはそれで十分です。この注釈がポリシーと同じくらい重く扱われるのは、2 つの役目を持つからです。クライアントはこれを「人の確認なしに呼んでよい」と読みます。また、第 4 節で見た認可のルールからツールを外すのもこの注釈です。`authorize` を呼んでいないルートに間違った注釈を付けると、あの失敗が出なくなります。そのため、注釈自体もポリシーと同じ基準で確かめられます。

</details>

<details>
<summary>演習 2: ヒントと答えの例</summary>

エージェント側は `Accept: application/json` を送り、`show` は `Post.findWithOrFail` で投稿を読み込みます。結果を確かめるテストの例です。

```ts
const result = await http.agent().call('posts_show', { id: 999 })
expect(result.isError).toBe(true)
expect(result.status).toBe(404)
console.log(result.text)
```

エージェントが受け取るのはエラーの結果です。`isError` が true、ステータスは 404 で、テキストはエラーレスポンスの JSON 本文です。その `message` は `Post not found for id=999` になります。`bun test` ではハンドラーが詳細を出すので、本文には `exception` と `stack` も入ります。`bun run preview` で HTML を求めるブラウザには、同じメッセージの素の HTML の 404 ページが返ります。本番以外では、ブラウザにも同じ JSON が返ります。

フレームワークによる部分は、404 というステータス(`findWithOrFail` が投げる例外が持っています)、リクエストの `Accept` ヘッダーによる JSON と HTML の切り替え、本番以外での詳細の表示、4xx や 5xx の応答を MCP のエラー結果に変換する処理です。アプリのコードによる部分は、`show` で `findWithOrFail` を使っていること(`find` で探して応答を自分で決める書き方もあります)と、投稿が見つからないときに専用のページを用意するかどうかです。

</details>

## 次へ

[第 13 章: 古びないドキュメント](./13-documented.md) では、アプリに自分自身を説明させます。生成される ER 図とドメインのビュー、エージェントがエンティティに触れる前に読むドキュメント、そしてどちらかがコードと食い違ったときに失敗するゲートを扱います。
