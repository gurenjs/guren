# 第 12 章: アプリをエージェントのツールにする

ここまでの 11 章は、人のためのブログを作る話でした。この章では、同じアプリを別の種類の呼び出し元に開きます。すでにあなたが書いたルートを通して、投稿を読み、下書きを公開するエージェントです。

ここに 2 つ目の API はひとつも出てきません。ツールとは、すでにあなたが作ったルートに、名前と、エージェントが読める契約と、それを呼ぶと何が起きるのかという主張を加えたものです。面白いのは、その主張をした途端にそのルートに起きることです。チェックが厳しくなり、そのうちのひとつが、第 7 章では警告することしかできなかったギャップでついに失敗します。

**この章で学ぶこと:**

- ツールが何でできているのか: 名前、入力スキーマ、出力の形、注釈
- ページのルートとツール前提のルートが、出力を別々のやり方で記述する理由と、入れ替えると何が壊れるのか
- 「認可の無い、変更を伴うツール」をビルドの失敗に変えるルール
- 自分のツールを、エージェントとまったく同じやり方でテストから呼び出す方法
- Guren アプリにある 2 つの MCP エンドポイントと、どちらがどちらなのか

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. ルートをひとつ、宣言する

`posts.show` は、宣言以外はツールに必要なものをすでに全部持っています。それを足します。

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
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`.agent()` が受け取るのはツールの説明と注釈であって、スキーマではありません。エージェントがそのルートを*呼ぶ*ために必要なものはすべて、ルートがすでに持っている契約から来ます。`params`、`query`、`body` はひとつのフラットな入力オブジェクトになり、`resource` か `output` が何が返ってくるかを記述します。それがこの設計です。ツールとはルートのビューであって、ルートの 2 つ目の定義ではありません。

ツールのマニフェストは生成コードなので、生成し直します。

```bash run
bun run codegen
```

では、何を宣言したのかを見てみます。

```bash run
bunx guren tool:list
```

1 行、7 列です。ツール名、その背後にあるメソッドとパス、それぞれのプロトコル面に現れるかどうか、それを認可するアビリティ、そして注釈。`posts.show` が `read-only, idempotent` なのは `GET` だからで、`guren` はそれをあなたに書かせるのではなくメソッドから解決しました。

```bash run
bunx guren tool:inspect posts.show
```

```bash manual
posts.show     GET /posts/:id
Description:   Read one post by id, with its author, tags and comments.
Exposure:      mcp=yes webMcp=yes
Annotations:   read-only, idempotent
Authorization: (not statically derivable)

Input
  id: integer

Output
  (no output schema; response declared by PostResource, CommentResource)
```

`id: string` ではなく `id: integer` なのは、`PostIdParamSchema` がそれを coerce するからです。あのスキーマは第 9 章でコントローラーのために書いたものですが、いまやツールの引数リストも兼ねています。契約をアクションの中だけでなくルートに置くことの理由は、まるごとこれです。

## 2. ツールを仕様化する

ツールは、モデルのクライアントもネットワークも無しでテストできます。`TestApp` はサーバーが使うのと同じ導出を公開しますし、呼び出しはほかのすべてのテストリクエストと同じ `fetch` を通って出ていきます。

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
    expect(names).toContain('posts.index')
    expect(names).toContain('posts.show')

    const result = await http.agent().call('posts.show', { id: post.id }).assertOk()
    expect(result.text).toContain('On tools')
  })

  it('publishes through a tool, and answers with the post', async () => {
    const asAda = await http.actingAs(ada).withCsrf()

    const published = await asAda.agent().call('posts.publish', { id: post.id }).assertOk()

    expect(published.structuredContent?.post).toMatchObject({ id: post.id, title: 'On tools' })
    const fresh = await Post.findOrFail(post.id)
    expect(fresh.publishedAt).not.toBeNull()
  })

  it('refuses to publish someone else\'s post', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    await asGrace.agent().call('posts.publish', { id: post.id }).assertStatus(403)

    const fresh = await Post.findOrFail(post.id)
    expect(fresh.publishedAt).toBeNull()
  })
})
```

最後のテストは 2 度読む価値のあるものです。第 7 章で書いたのと同じ 403 に、HTTP リクエストではなくツール呼び出しから到達しており、通る理由も同じです。ルートが走るからポリシーが走るのです。ツール呼び出しは裏口ではありません。本物のミドルウェアチェーンを通る本物のリクエストであり、あなたが書いたガードはひとつ残らずその前に立っています。

```bash run expect-fail
bun test
```

赤です。`posts.publish` と `posts.index` はまだツールではありません。

## 3. 変更を伴うツール

宣言するルートは 2 つ、そして必要なものはそれぞれ違います。

`posts.index` はもうひとつのページのルートなので、`posts.show` と同じ扱いになります。エージェントがページングを知れるように `query` の契約を、形を宣伝できるように `resource` のヒントを。

`posts.publish` は違いますし、その違いこそがここでの教材です。ブラウザにはリダイレクトで応答します。フォームにはまさしく正しく、エージェントには無用です。リダイレクトは投稿を運びません。そこでアクションは 2 通りの応答を覚え、ルートはエージェントに JSON 版を約束します。

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

アクションはひとつ、相手は 2 種類、ポリシーはひとつ。認可も更新もイベントも分岐より上にあり、違うのは最後の 1 行だけです。既存のアクションがツールになるときは、いつでもこの形に手を伸ばしてください。この章が 2 つ目のコントローラーを作らないのはそのためです。

ではルートです。

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
      .agent({ description: 'Publish a draft post. Only the post\'s author may call it.' })
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
    .agent({ description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`posts.publish` には契約が 3 つ、そのどれもが構造材です。`params` はエージェントが送る id に型を付けます。空のオブジェクトである `body` は、「このアクションはペイロードを取らない」とツールが言うための方法です。これが無いと、エージェントには何を送ればよいか見えない、とチェックが警告します。`output` は約束であり、そして実際に走るのはこれです。合致しない 2xx のレスポンスは、呼び出し元に届く代わりに 500 になり、名前を挙げていないフィールドは削ぎ落とされます。ページのルートは代わりに `resource` を使います。こちらは型レベルだけのものです。ブラウザに Inertia のページを返すルートに `output` スキーマを置くと、そのページを検証しようとしてしまうからです。

```bash run
bun run codegen
```

```bash run
bun test
```

緑です。

```bash run
bunx guren tool:list
```

ツールは 3 つ。`posts.publish` は `destructive` で、その `Auth` 列のどこにも `publish` はありません。アビリティはアクションの中で決まるからです。`-` と表示される列は「静的には導出できない」の意味であって、「認可されていない」ではありません。

## 4. ついに失敗するチェック

ここまでのものをコミットしてください。次の手順が、それを意図的に壊すからです。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: expose reading and publishing as agent tools"
```

第 7 章は、居心地の悪い調子で終わりました。ポリシーを書き、それから、ポリシーの呼び出しがまったく無いルートでも `guren audit` が緑のままだと知りました。audit が問うのは、変更を伴うルートが*ユーザーを*要求するかどうかであって、*どの*ユーザーかを決めているかどうかではないからです。あなたと「誰でも編集できるブログ」との間に立っていたのは、テストだけでした。

ルートをツールだと宣言すると、それが変わります。`publish` から認可を取り除いてください。

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

何が変わって何が変わっていないかを読んでください。`guren audit` はこのルートを相変わらず通します。`auth` グループの中にあるのでユーザーは要求されており、audit が問うたのはそれだけです。ルートのテストなら捕まえますし、それはあなたが書いたテストです。チェックが加えるのは、テストを 1 件も走らせずに*ビルド*が拒むようになる、という点です。変更を伴うツールは、別の種類の約束だからです。それは、あなたが決して会うことのない呼び出し元に差し出されたアクションであり、「認証済みの何者か」は人ではありません。

戻してください。

```bash run
git checkout -- app/Http/Controllers/PostController.ts
```

```bash run
bunx guren check --ci
```

また緑です。この章のハーネスのてこは、この `--ci` です。`guren gate` が実行するものであり、エージェントが終わったと言ったときに `Stop` hook が実行するものです。ルートをツールとして公開しておいてポリシーを忘れたエージェントは、その仕事を終わったことにできません。


## 5. コメントのツールを仕様化する

投稿を読めるエージェントには、それに答えられてしかるべきです。人が受けるのと同じルールのもとで。

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

    const result = await asGrace.agent().call('comments.store', { id: post.id, body: 'Read it twice' }).assertOk()

    expect(result.structuredContent?.comment).toMatchObject({ body: 'Read it twice' })
    const stored = await Comment.where('postId', post.id).first()
    expect(stored?.authorId).toBe(grace.id)
  })

  it('validates the comment it is given', async () => {
    const asGrace = await http.actingAs(grace).withCsrf()

    const result = await asGrace.agent().call('comments.store', { id: post.id, body: '   ' }).assertStatus(422)

    expect(result.isError).toBe(true)
    expect(result.text).toContain('Say something')
  })

  it('refuses to delete someone else\'s comment', async () => {
    const comment = await Comment.forceCreate({ body: 'Mine', postId: post.id, authorId: ada.id })
    const asGrace = await http.actingAs(grace).withCsrf()

    await asGrace.agent().call('comments.destroy', { id: comment.id }).assertStatus(403)

    expect(await Comment.find(comment.id)).not.toBeNull()
  })
})
```

真ん中のテストが、取っておく価値のあるものです。よくない引数を送ったツール呼び出しは、プロトコルの障害ではなく、バリデーター自身のメッセージを運ぶエラー結果として返ってきます。エージェントには、人が告げられるのと同じことが、同じ言葉で、同じスキーマによって告げられます。

```bash run expect-fail
bun test
```

赤が 2 件、たまたま通っているものが 1 件。

## 6. 委ねる

> Expose the comment routes as agent tools. `comments.store` and `comments.destroy` should be callable by an agent, follow the same pattern `posts.publish` uses (a `params` schema, a `body` schema where the action takes one, an `output` schema, and a JSON answer for a tool call while the browser keeps its redirect), and keep the policies they already have. `tests/AgentComments.test.ts` describes them; make it pass.

このプロンプトは認可に触れていませんし、その必要もありません。いまや見張っているものが 2 つあります。第 8 章の所有権の rule と、`guren check --ci` です。後者は、エージェントがポリシーの呼び出し無しに `comments.destroy` を公開したら、ビルドをきっぱり失敗させます。diff の中の `output` スキーマを確かめてから、チェックを実行してください。

**手元にエージェントが無い場合は、** バリデーターが契約を 2 つ手に入れます。

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
      .agent({ description: 'Publish a draft post. Only the post\'s author may call it.' })
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
      .agent({ description: 'Add a comment to a post, as the calling user.' })
    auth
      .delete('/comments/:id', {
        bind: { id: Comment },
        name: 'comments.destroy',
        params: CommentIdParamSchema,
        output: CommentDeletedSchema,
      }, [CommentController, 'destroy'])
      .agent({ description: 'Delete one comment. Only its author may call it.' })
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router
    .get('/posts', { name: 'posts.index', query: ListPostsQuerySchema, resource: { data: [PostResource] } }, [PostController, 'index'])
    .agent({ description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
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

rubric は次のとおりです。

- コメントのルートは両方とも `params` スキーマと `output` スキーマを持ち、`comments.store` は `body` の契約を保っている。`guren check --ci` が緑で、つまり入力や出力の記述を欠いたツールがひとつも無い。
- どのアクションも `authorize()` の呼び出しを保っており、JSON の分岐はその*あと*にある。ポリシーより上にエージェント向けの応答があれば、それはブラウザにしか走らないポリシーです。
- ブラウザは相変わらずリダイレクトする。ブラウザでコメントを投稿すれば、投稿のページに戻ってくる。
- エージェントのテスト 5 件が通る。`Say something` を運ぶ 422 と、他人のコメントに対する 403 を含めて。

```bash run
bunx guren tool:list
```

ツールは 5 つ。読むものが 2 つ、何かを変えるものが 3 つ。そのそれぞれに、フレームワークに見えたアビリティか、アクションが強制するポリシーが付いています。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: expose the comment routes as agent tools"
```

## 7. エンドポイントは 2 つ、どちらがどちらか

あなたのアプリはもうツールを持っています。それを本物のエージェントに渡すのは、プラグイン 1 本です。

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
  providers: [DatabaseProvider, AuthProvider, /* … */ mcpPlugin()],
})

// The endpoint verifies bearer tokens against this store, and a token's
// scopes decide which of your tools it may call.
app.auth.useTokens(new DatabaseApiTokenStore(apiTokens))
```

これが `/mcp` をマウントします。本番で動く本物のエンドポイントで、`tools/list` にはあなたが宣言したツールで答え、呼び出しはどれもあなたのミドルウェアを通る通常のリクエストとして実行します。bearer トークン、トークンごとのツールのスコープ、レート制限で守られており、トークンストアが要り、そのためにはテーブルが要ります。それは第 14 章の仕事です。本番に出るためのほかの作業と一緒に。

あなたのエディターがすでに話しかけているエンドポイントと混同しないでください。`GUREN_MCP=1` は開発時にだけ `/_guren/mcp` をマウントし、ループバックインターフェース上にいない呼び出し元をすべて拒み、そのツールは `guren_check`、`guren_gate`、`guren_get_context` とその仲間たちです。これらが働きかける先は*あなたのプロジェクト*で、アプリを書くエージェントのためのものです。プラグインのツールは*あなたのアプリケーション*のもので、アプリを使うエージェントのためのものです。同じプロトコル、向きは逆。そして前者は、第 8 章のハーネスがあなたの代わりに設定してくれていました。

## いまいる場所

- ツールでもあるルートが 5 つ。そのそれぞれに、エージェントが読む入力スキーマと、頼りにできる出力の形がある。
- ブラウザとエージェントに、最後の 1 行だけ違う応答をし、それ以外はまったく同じことをするアクションがひとつ。
- 認可の無い、変更を伴うツールで失敗するビルド。第 7 章がテストでしか塞げなかった穴。
- テストスイートの中のツール呼び出し。ほかのすべてと同じミドルウェア、ポリシー、バリデーターを通っている。

## よくあるつまずき

- **`guren check` がマニフェストが無いと言う。** `.agent()` を宣言すると `.guren/agents.gen.ts` がアプリの一部になります。`bun run codegen` を実行してください。
- **エージェントには何を送ればよいか見えない、とツールが警告する。** `POST`、`PUT`、`PATCH` のツールにはどれも `body` スキーマが要ります。ペイロードを取らないものであっても同じです。`z.object({})` がそこでの正直な答えです。
- **ツール呼び出しで `Response validation failed` の 500。** `output` スキーマと、アクションが返す JSON が食い違っています。スキーマは 2xx のレスポンスに対して強制されます。それがこのスキーマの主旨です。間違っているほうを直してください。
- **ツール呼び出しが `HTTP 302 (Location: …)` を返す。** アクションがリダイレクトしたので、エージェントに読むものがありません。`publish` がそうしているように、JSON の分岐を与えてください。
- **スキーマを足したら Inertia のページが壊れた。** ページのルートに置いた `output` スキーマは、ページの JSON も検証します。ページのルートは `resource` で自分を記述します。こちらは型レベルだけのものです。
- **ツール呼び出しが 419 か CSRF のエラーになる。** `agent()` を呼ぶ前に、`withCsrf()` で acting のアプリを組み立ててください。テストの中のツール呼び出しも、ほかと同じクッキーセッションのリクエストです。

## 次へ

第 13 章 *システムを文書化する*(準備中)では、アプリに自分自身を記述させます。生成される ER 図とドメインのビュー、エージェントがエンティティに触れる前に読むドキュメント、そしてそのどちらかがコードからずれたときに失敗するゲートです。
