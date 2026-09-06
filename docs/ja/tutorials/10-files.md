# 第 10 章: ファイル

ブログには画像が要ります。この章では Guren の attachments レイヤーを導入し、公開ディレクトリの外に保存されて署名付き URL 経由で配信されるカバー画像をすべての投稿に与え、それからギャラリーをエージェントに委ねます。その途中で `guren check` は正しくあるべき事柄をひとそろい新しく手にし、「プライベート」を「公開」に変えてしまうあの間違いをそれが捕まえるところを、あなたは目にします。

**この章で学ぶこと:**

- アップロードとはサーバー上で何なのか: multipart ボディの中の `File`、`attachments` テーブルの 1 行、ディスク上のオブジェクト
- アップロードが決して `public/` の下に置かれない理由と、代わりに署名付きの配信ルートが何をするのか
- モデルが attachments をどう宣言するか、そしてそれらを扱う 4 つの呼び出し: `attach`、`withAttachments`、`detach`、`purgeAttachments`
- フォームがファイルを送る方法と、テストがそれを送る方法
- `guren check` が強制する attachment のルールと、そのうちひとつが警告ではなく失敗である理由

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. attachments レイヤー

コマンド 1 本で導入できます。

```bash run
bunx guren add attachments
```

何をしたのかを読んでください。これから保守するのはあなたです。まずストレージレイヤーが導入されました(`app/Providers/StorageProvider.ts`、ディスクは 2 つ、`./storage/app` を根とする `local` と `./public/storage` を根とする `public`)。それから `db/schema.ts` に `attachments` テーブルが追加され、`config/attachments.ts` と `app/Providers/AttachmentsProvider.ts` が書かれ、`src/app.ts` にプロバイダーが登録され、ルート registrar の先頭で `registerAttachmentRoutes` を呼ぶことで配信ルートがマウントされ、`attachments:prune` コンソールコマンドが登録されました。テーブルにはマイグレーションが要ります。

```bash run
bun run db:make create_attachments
```

```bash run
bun run db:migrate
```

手で行う編集が 2 つ。ディスクには commit すべきでないファイルが入ります。

```bash run
printf 'storage/app/\npublic/storage/\n' >> .gitignore
```

そして config には、ジェネレーターが代わりに書けない行がひとつ加わります。あなたのどのモデルが attachments を持つことになるかを、ジェネレーターは知らないからです。prune コマンドは、attachment の持ち主がまだ存在するかを確かめるためにこのマップを必要とします。

```ts file=config/attachments.ts
import { Model, configureAttachments, getContainer } from '@guren/core'
import { attachments } from '../db/schema'
import { Post } from '../app/Models/Post.js'

/**
 * Wires the attachments layer once at boot (AttachmentsProvider imports this
 * module). `Attachment` is the app-local model over the attachments table.
 */
export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => getContainer().make('storage'),
  // Uploads are bytes a stranger chose, so they live on a disk rooted outside
  // public/ and are handed out only through the signed delivery route that
  // registerAttachmentRoutes(router) mounts. Rooting this disk inside public/
  // bypasses all of it; `guren check` fails that shape.
  disk: 'local',
  // 'public' disks build URLs with disk.url(); 'private' ones go through the
  // delivery route below. Undeclared disks count as public.
  disks: { local: 'private', public: 'public' },
  // Presence is the switch: private-disk URLs become signed delivery-route URLs.
  delivery: {},
})

// attachments:prune resolves attachableType through this map to check the owning
// record still exists, so every model declaring attachments belongs here.
Model.morphMap = { Post }
```

このファイルには決定が 3 つあり、それがこの章のセキュリティの中身です。

- **`disk: 'local'`**、根は `./storage/app`。このディレクトリを配信するものは何もありません。`public/` の下のファイルはパスを言い当てた誰にでも届きますが、ここのファイルは、渡すと判断したコードを通してしか届きません。
- **`disks: { local: 'private' }`**。private なディスクの URL はファイルへのパスではありません。ルートへの、署名付きで期限のあるリンクです。
- **`delivery: {}`**。そのルートです。オブジェクトをストリーミングし、アップロードを画像かダウンロード以外のものとしてブラウザが扱わないようにするヘッダーを付けます。インラインで表示できる型の許可リスト、`nosniff`、サンドボックス化した CSP。第 14 章では同じルートがオブジェクトストレージへのリダイレクトに変わりますが、ページが使う URL は変わりません。

ルートファイルは配信ルートで始まるようになりました。呼び出しがどこに入ったかを目で確かめ、そのまま残しておけるように、ファイルを置き換えます。

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
import { PostIdParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
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
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`config/attachments.ts` は `Post` を import していますが、`Post` はまだ attachment を何も宣言していません。それが次のステップです。

## 2. カバー画像を仕様化する

テストには画像が要ります。1 ピクセルの PNG で十分で、ファイルの中に置いておけるほど小さくて済みます。

```ts file=tests/PostAttachments.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
)

function image(name: string): File {
  return new File([PNG], name, { type: 'image/png' })
}

describe('post attachments', () => {
  let http: TestApp
  let ada: UserRecord
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('stores a cover with a post and serves it through a signed URL', async () => {
    const form = new FormData()
    form.append('title', 'With a cover')
    form.append('body', 'Look at this')
    form.append('tags', '')
    form.append('cover', image('cover.png'))

    await asAda.post('/posts', form).assertRedirect()

    const post = await Post.where('title', 'With a cover').first()
    const [loaded] = await Post.withAttachments([post!], ['cover'])
    expect(loaded!.cover?.contentType).toBe('image/png')
    expect(loaded!.cover?.url).toContain('/attachments/')
    expect(loaded!.cover?.url).toContain('signature=')

    const response = await http.get(`/posts/${post!.id}`).assertOk()
    await response.assertBodyContains('/attachments/')
  })

  it('replaces the cover, and lets only the author do it', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    const asGrace = await http.actingAs(grace).withCsrf()
    const post = await Post.forceCreate({ title: 'Recover', body: 'Body', authorId: ada.id })
    await Post.attach(post.id, 'cover', image('first.png'))

    const attempt = new FormData()
    attempt.append('cover', image('second.png'))
    await asGrace.post(`/posts/${post.id}/cover`, attempt).assertForbidden()

    const replacement = new FormData()
    replacement.append('cover', image('second.png'))
    await asAda.post(`/posts/${post.id}/cover`, replacement).assertRedirect(`/posts/${post.id}`)

    const [loaded] = await Post.withAttachments([post], ['cover'])
    expect(loaded!.cover?.name).toBe('second.png')
  })

  it('removes the files when the post is deleted', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Body', authorId: ada.id })
    const attachment = await Post.attach(post.id, 'cover', image('cover.png'))
    expect(existsSync(`storage/app/${attachment.path}`)).toBe(true)

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(existsSync(`storage/app/${attachment.path}`)).toBe(false)
  })
})
```

このファイルで読む価値のあるところが 3 つ。アップロードは `File` を含む `FormData` で、`TestApp` はそれを見つけると multipart として送ります。JSON のボディではファイルを運べません。URL は、ただ存在することではなく署名されていることをアサートしています。署名の無い URL は、ディスクが公開されていることを意味するからです。そして最後のテストは、attachment の行が記録するオブジェクトキーを通してディスクそのものを検査します。投稿を削除したら、そのファイルを残していってはいけません。そしてそれは、データベースへのどんなアサーションからも分かりません。

```bash run expect-fail
bun test
```

赤、しかも 3 つのテストがどれも走る前に落ちます。`Post.withAttachments` が関数ではないからで、`Post` はまだ attachable ではないのです。

## 3. カバー画像を手で書く

モデルはクラスを包むことでコレクションを宣言します。`image: 'require'` は、画像でないファイルは名前や type ヘッダーが何を主張していようと、attach の時点でバリデーションメッセージとともに拒否されるという意味です。

```ts file=app/Models/Post.ts
import { Attachable, defineModel, hasOneAttached, type BelongsToRecord, type BelongsToManyRecord, type HasManyRecord } from '@guren/core'
import { posts, postTags } from '../../db/schema.js'
import type { UserRecord } from './User.js'
import type { CommentRecord } from './Comment.js'
import type { TagRecord } from './Tag.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends Attachable(defineModel(posts, { fillable: ['title', 'body'] }), {
  cover: hasOneAttached({ image: 'require' }),
}) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
    tags: BelongsToManyRecord<TagRecord>
  } = { author: null, comments: [], tags: [] }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
Post.belongsToMany('tags', () => import('./Tag.js').then((m) => m.Tag), postTags, 'postId', 'tagId')
```

`Attachable` は `Post` に static を 4 つ足します。`attach(id, collection, file)`、`detach(id, collection, attachmentId?)`、`withAttachments(records, names)`、`purgeAttachments(id)` です。テーブルやディスクの話はここには一切出てきません。config が一度だけ決めました。

リソースはカバー画像を `AttachmentData` として運びます。id、名前、コンテンツタイプ、サイズ、寸法、そしてページが使うべき URL です。その URL が署名付きのルートなのか CDN のパスなのかは config の仕事であって、リソースの仕事ではありません。

```ts file=app/Http/Resources/PostResource.ts
import { Resource, type AttachmentData } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import type { TagRecord } from '../../Models/Tag.js'

export type PostWithRelations = PostRecord & {
  author?: UserRecord | null
  tags?: TagRecord[]
  cover?: AttachmentData | null
}

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
  publishedAt: string | null
  author: { id: number; name: string } | null
  tags: string[]
  cover: AttachmentData | null
}

export class PostResource extends Resource<PostWithRelations, PostResourceData> {
  toArray(): PostResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      publishedAt: this.resource.publishedAt,
      author: author ? { id: author.id, name: author.name } : null,
      tags: (this.resource.tags ?? []).map((tag) => tag.name),
      cover: this.resource.cover ?? null,
    }
  }
}
```

コントローラーです。`store` はカバー画像が送られていれば attach し、`show` はそれを読み込み、`destroy` は行より先にファイルを purge し、新しい `cover` アクションがそれを差し替えます。`this.file('cover')` は multipart のフィールドを読み、無いか空なら `null` を返します。

```ts file=app/Http/Controllers/PostController.ts
import { Controller, ValidationException, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function syncTags(postId: number, names: string[]): Promise<void> {
  await PostTag.delete({ postId })
  for (const name of names) {
    const tag = (await Tag.first({ name })) ?? (await Tag.create({ name }))
    await PostTag.forceCreate({ postId, tagId: tag.id })
  }
}

export default class PostController extends Controller {
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
    const [withCover] = await Post.withAttachments([post], ['cover'])
    const comments = await Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(withCover!).toJSON(),
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

この章を支える細部が 2 つ。`hasOneAttached` のコレクションに対する `Post.attach(post.id, 'cover', cover)` は**差し替え**です。古いファイルは削除され、新しいものが保存され、行はひとつ。そして `purgeAttachments` は `delete` より前に来ます。attachments テーブルは `posts` への外部キーを持たないので(ポリモーフィックで、すべてのモデルにひとつのテーブル)、何も cascade しません。purge せずに削除された投稿は、ディスクに孤児のファイルを、テーブルに孤児の行を残すことになります。`attachments:prune` はあとからそれを見つけるために存在し、3 つ目のテストはそれが起きるのを許しません。

カバー画像を差し替えるルートは `POST` で、`update` の一部ではありません。Inertia のフォームからファイルを `PUT` で運ぶにはメソッドの詐称が要りますが、Guren はそれをしません。ルートを分けたほうが単純ですし、読みやすくもあります。

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
import { PostIdParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
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
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

フォームです。Inertia の `useForm` は、データが `File` を持った瞬間に自分で multipart のリクエストへ切り替えます。足すのは input と、フォームの型のフィールドがもうひとつだけです。バリデーターがそれを知らないので、ルートの契約もそれを知りません。

```tsx file=resources/js/pages/posts/New.tsx
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

// Inertia switches the request to FormData as soon as the data holds a File.
type PostForm = RouteBody<ApiRoutes, 'posts.store'> & { cover: File | null }

const inputClass =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '', tags: '', cover: null })

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
              <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="Title" className={inputClass} />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="Body" rows={8} className={inputClass} />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <div>
              <input value={form.data.tags} onChange={(event) => form.setData('tags', event.target.value)} placeholder="Tags, comma-separated" className={inputClass} />
              {form.errors.tags && <p className="mt-1 text-sm text-g-danger">{form.errors.tags}</p>}
            </div>
            <div>
              <label className="block text-sm text-g-text-2">
                Cover image
                <input type="file" accept="image/*" onChange={(event) => form.setData('cover', event.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
              </label>
              {form.errors.cover && <p className="mt-1 text-sm text-g-danger">{form.errors.cover}</p>}
            </div>
            <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Publish
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

そしてページがカバー画像を表示します。著者には、それを差し替える小さなフォームが付きます。

```tsx file=resources/js/pages/posts/Show.tsx
import { Head, Link, useForm, usePage } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import { route } from '@/.guren/routes.gen'

type CommentForm = RouteBody<ApiRoutes, 'comments.store'>

interface Props {
  post: PostResourceData
  canManage: boolean
  comments: (CommentResourceData & { canDelete: boolean })[]
}

export default function PostShow({ post, canManage, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const signedIn = Boolean(props.auth?.user)
  const form = useForm<CommentForm>({ body: '' })
  const coverForm = useForm<{ cover: File | null }>({ cover: null })

  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          {post.cover && (
            <img src={post.cover.url} alt="" width={post.cover.width ?? undefined} height={post.cover.height ?? undefined} className="w-full rounded-g-card border border-g-line object-cover" />
          )}
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.publishedAt ? `Published ${post.publishedAt}` : 'Draft'}
          </p>
          {post.tags.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span key={tag} className="rounded-g-ctl border border-g-line px-2 py-0.5 font-mono text-xs text-g-text-2">
                  #{tag}
                </span>
              ))}
            </p>
          )}
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          {canManage && (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                  Edit
                </Link>
                {post.publishedAt ? (
                  <Link href={route('posts.unpublish', { id: post.id })} method="post" as="button" className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted">
                    Unpublish
                  </Link>
                ) : (
                  <Link href={route('posts.publish', { id: post.id })} method="post" as="button" className="rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                    Publish
                  </Link>
                )}
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
              <form
                className="flex items-center gap-3 text-sm"
                onSubmit={(event) => {
                  event.preventDefault()
                  coverForm.post(route('posts.cover', { id: post.id }), { onSuccess: () => coverForm.reset() })
                }}
              >
                <input type="file" accept="image/*" onChange={(event) => coverForm.setData('cover', event.target.files?.[0] ?? null)} className="text-sm" />
                <button type="submit" disabled={coverForm.processing || !coverForm.data.cover} className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted">
                  {post.cover ? 'Replace cover' : 'Add cover'}
                </button>
                {coverForm.errors.cover && <span className="text-g-danger">{coverForm.errors.cover}</span>}
              </form>
            </div>
          )}

          <section className="space-y-4 border-t border-g-line pt-6">
            <h2 className="text-xl font-bold text-g-heading">Comments</h2>
            {comments.length === 0 && <p className="text-g-text-2">No comments yet.</p>}
            {comments.map((comment) => (
              <article key={comment.id} className="rounded-g-card border border-g-line bg-g-panel p-4">
                <p className="whitespace-pre-wrap">{comment.body}</p>
                <p className="mt-2 flex items-center gap-3 font-mono text-xs text-g-text-2">
                  <span>{comment.author?.name ?? 'unknown'} · {comment.createdAt}</span>
                  {comment.canDelete && (
                    <Link href={route('comments.destroy', { id: comment.id })} method="delete" as="button" className="text-g-danger hover:underline">
                      Delete
                    </Link>
                  )}
                </p>
              </article>
            ))}
            {signedIn ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  form.post(route('comments.store', { id: post.id }), { onSuccess: () => form.reset() })
                }}
              >
                <textarea
                  value={form.data.body}
                  onChange={(event) => form.setData('body', event.target.value)}
                  placeholder="Add a comment"
                  rows={3}
                  className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
                />
                {form.errors.body && <p className="text-sm text-g-danger">{form.errors.body}</p>}
                <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Comment
                </button>
              </form>
            ) : (
              <p className="text-sm text-g-text-2">
                <Link href={route('login')} className="text-g-accent-text hover:underline">Sign in</Link> to comment.
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

緑です。**チェックポイント:** 画像付きの投稿を書いてください。画像を新しいタブで開いて URL を見ます。`/attachments/<id>/<name>?expires=…&signature=…`。6 分待ってそのタブを再読み込みすると 404 です。リンクの期限が切れました。ページは次のレンダリングで新しいものを発行します。ここで「プライベート」が意味しているのはそれです。

## 4. `guren check` がファイルについて知っていること

```bash run
bunx guren check
```

並んだ行のうち 4 つが新顔で、どれも通っています。モデルが attachments を宣言していて `configureAttachments()` が存在すること。config がスキーマの export するテーブルを結びつけていること。配信が有効で `registerAttachmentRoutes()` がマウントされていること。そしてディスク `local` の根が `public/` の外にあること。どれも、ランタイムで遅く静かに失敗するがゆえに `check` が捕まえるために作られた間違いです。最後のものは、長いメッセージを伴う失敗です。`public/` の中に根を持つディスクは、配信ルートがどう設定されていようと、すべてのアップロードを署名も期限も無い URL で取得できるようにしてしまいます。ファイルに届くのにルートを通る必要がまったく無いからです。それが、ファイルがサーバーにあることと、ファイルがウェブにあることの違いです。

この章のハーネスのてこは、そのチェックです。`PostToolUse` フックはモデルや config ファイルを編集するたびにそれを走らせるので、ディスクを `public` に「単純化」したエージェントは、次の一歩に進む前に同じ言葉でそれを聞かされます。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: give posts a cover image on a private disk"
```

## 5. ギャラリーを仕様化する

画像は複数あり、著者はそのどれでも取り除けます。attachments のテストに追加します。

```ts file=tests/PostAttachments.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
)

function image(name: string): File {
  return new File([PNG], name, { type: 'image/png' })
}

describe('post attachments', () => {
  let http: TestApp
  let ada: UserRecord
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('stores a cover with a post and serves it through a signed URL', async () => {
    const form = new FormData()
    form.append('title', 'With a cover')
    form.append('body', 'Look at this')
    form.append('tags', '')
    form.append('cover', image('cover.png'))

    await asAda.post('/posts', form).assertRedirect()

    const post = await Post.where('title', 'With a cover').first()
    const [loaded] = await Post.withAttachments([post!], ['cover'])
    expect(loaded!.cover?.contentType).toBe('image/png')
    expect(loaded!.cover?.url).toContain('/attachments/')
    expect(loaded!.cover?.url).toContain('signature=')

    const response = await http.get(`/posts/${post!.id}`).assertOk()
    await response.assertBodyContains('/attachments/')
  })

  it('replaces the cover, and lets only the author do it', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    const asGrace = await http.actingAs(grace).withCsrf()
    const post = await Post.forceCreate({ title: 'Recover', body: 'Body', authorId: ada.id })
    await Post.attach(post.id, 'cover', image('first.png'))

    const attempt = new FormData()
    attempt.append('cover', image('second.png'))
    await asGrace.post(`/posts/${post.id}/cover`, attempt).assertForbidden()

    const replacement = new FormData()
    replacement.append('cover', image('second.png'))
    await asAda.post(`/posts/${post.id}/cover`, replacement).assertRedirect(`/posts/${post.id}`)

    const [loaded] = await Post.withAttachments([post], ['cover'])
    expect(loaded!.cover?.name).toBe('second.png')
  })

  it('removes the files when the post is deleted', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Body', authorId: ada.id })
    const attachment = await Post.attach(post.id, 'cover', image('cover.png'))
    expect(existsSync(`storage/app/${attachment.path}`)).toBe(true)

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(existsSync(`storage/app/${attachment.path}`)).toBe(false)
  })

  it('stores gallery images with a post', async () => {
    const form = new FormData()
    form.append('title', 'Gallery')
    form.append('body', 'Pictures')
    form.append('tags', '')
    form.append('images', image('one.png'))
    form.append('images', image('two.png'))

    await asAda.post('/posts', form).assertRedirect()

    const post = await Post.where('title', 'Gallery').first()
    const [loaded] = await Post.withAttachments([post!], ['images'])
    expect(loaded!.images.map((img) => img.name).sort()).toEqual(['one.png', 'two.png'])
  })

  it('lets the author remove one gallery image, and nobody else', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    const asGrace = await http.actingAs(grace).withCsrf()
    const post = await Post.forceCreate({ title: 'Gallery', body: 'Pictures', authorId: ada.id })
    const first = await Post.attach(post.id, 'images', image('one.png'))
    await Post.attach(post.id, 'images', image('two.png'))

    await asGrace.delete(`/posts/${post.id}/images/${first.id}`).assertForbidden()

    await asAda.delete(`/posts/${post.id}/images/${first.id}`).assertRedirect(`/posts/${post.id}`)

    const [loaded] = await Post.withAttachments([post], ['images'])
    expect(loaded!.images.map((img) => img.name)).toEqual(['two.png'])
    expect(existsSync(`storage/app/${first.path}`)).toBe(false)
  })
})
```

```bash run expect-fail
bun test
```

赤が 2 件。`images` は `Post` が宣言しているコレクションではありません。

## 6. 委ねる

エージェントにこう頼みます。

> Add a gallery to posts: a `hasManyAttached` collection named `images` (images only) on `Post`. The new-post form accepts several files under `images`, `store` attaches each one, the post page shows them, and `DELETE /posts/:id/images/:attachment`, named `posts.images.destroy`, removes one image for the post's author. Load the gallery with `withAttachments` and expose it through `PostResource`. `tests/PostAttachments.test.ts` describes it; make it pass.

これはカバー画像と同じ形の、ひとつ上の階層です。`this.file('cover')` の代わりに `this.files('images')`、nullable の代わりに配列、差し替える `attach` の代わりに attachment の id を渡す `detach`。rubric で面白いのは削除ルートです。URL の id で attachment を探し、*かつ*この投稿のコレクションの中だけを探さなければなりません。そうすることで、他人の投稿の有効な attachment id は拒否されます。`detach(post.id, 'images', attachmentId)` はまさにそれを行います。attachment の id だけで自前の削除を書いたなら、そうはなりません。

**手元にエージェントが無い場合は、** モデルにコレクションがひとつ増えます。

```ts file=app/Models/Post.ts fallback
import { Attachable, defineModel, hasManyAttached, hasOneAttached, type BelongsToRecord, type BelongsToManyRecord, type HasManyRecord } from '@guren/core'
import { posts, postTags } from '../../db/schema.js'
import type { UserRecord } from './User.js'
import type { CommentRecord } from './Comment.js'
import type { TagRecord } from './Tag.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends Attachable(defineModel(posts, { fillable: ['title', 'body'] }), {
  cover: hasOneAttached({ image: 'require' }),
  images: hasManyAttached({ image: 'require' }),
}) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
    tags: BelongsToManyRecord<TagRecord>
  } = { author: null, comments: [], tags: [] }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
Post.belongsToMany('tags', () => import('./Tag.js').then((m) => m.Tag), postTags, 'postId', 'tagId')
```

```ts file=app/Http/Validators/PostValidator.ts fallback
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
```

```ts file=app/Http/Resources/PostResource.ts fallback
import { Resource, type AttachmentData } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import type { TagRecord } from '../../Models/Tag.js'

export type PostWithRelations = PostRecord & {
  author?: UserRecord | null
  tags?: TagRecord[]
  cover?: AttachmentData | null
  images?: AttachmentData[]
}

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
  publishedAt: string | null
  author: { id: number; name: string } | null
  tags: string[]
  cover: AttachmentData | null
  images: AttachmentData[]
}

export class PostResource extends Resource<PostWithRelations, PostResourceData> {
  toArray(): PostResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      publishedAt: this.resource.publishedAt,
      author: author ? { id: author.id, name: author.name } : null,
      tags: (this.resource.tags ?? []).map((tag) => tag.name),
      cover: this.resource.cover ?? null,
      images: this.resource.images ?? [],
    }
  }
}
```

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, ValidationException, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
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
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

フォームはひとつの名前で複数のファイルを受け取ります。

```tsx file=resources/js/pages/posts/New.tsx fallback
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

// Inertia switches the request to FormData as soon as the data holds a File.
type PostForm = RouteBody<ApiRoutes, 'posts.store'> & { cover: File | null; images: File[] }

const inputClass =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '', tags: '', cover: null, images: [] })

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
              <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="Title" className={inputClass} />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="Body" rows={8} className={inputClass} />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <div>
              <input value={form.data.tags} onChange={(event) => form.setData('tags', event.target.value)} placeholder="Tags, comma-separated" className={inputClass} />
              {form.errors.tags && <p className="mt-1 text-sm text-g-danger">{form.errors.tags}</p>}
            </div>
            <div>
              <label className="block text-sm text-g-text-2">
                Cover image
                <input type="file" accept="image/*" onChange={(event) => form.setData('cover', event.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
              </label>
              {form.errors.cover && <p className="mt-1 text-sm text-g-danger">{form.errors.cover}</p>}
            </div>
            <div>
              <label className="block text-sm text-g-text-2">
                Gallery
                <input type="file" accept="image/*" multiple onChange={(event) => form.setData('images', Array.from(event.target.files ?? []))} className="mt-1 block w-full text-sm" />
              </label>
              {form.errors.images && <p className="mt-1 text-sm text-g-danger">{form.errors.images}</p>}
            </div>
            <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Publish
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

そしてページがギャラリーを表示します。著者には画像ごとに削除ボタンが付きます。

```tsx file=resources/js/pages/posts/Show.tsx fallback
import { Head, Link, useForm, usePage } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import { route } from '@/.guren/routes.gen'

type CommentForm = RouteBody<ApiRoutes, 'comments.store'>

interface Props {
  post: PostResourceData
  canManage: boolean
  comments: (CommentResourceData & { canDelete: boolean })[]
}

export default function PostShow({ post, canManage, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const signedIn = Boolean(props.auth?.user)
  const form = useForm<CommentForm>({ body: '' })
  const coverForm = useForm<{ cover: File | null }>({ cover: null })

  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          {post.cover && (
            <img src={post.cover.url} alt="" width={post.cover.width ?? undefined} height={post.cover.height ?? undefined} className="w-full rounded-g-card border border-g-line object-cover" />
          )}
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.publishedAt ? `Published ${post.publishedAt}` : 'Draft'}
          </p>
          {post.tags.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span key={tag} className="rounded-g-ctl border border-g-line px-2 py-0.5 font-mono text-xs text-g-text-2">
                  #{tag}
                </span>
              ))}
            </p>
          )}
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          {post.images.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {post.images.map((imageItem) => (
                <figure key={imageItem.id} className="space-y-1">
                  <img src={imageItem.url} alt="" className="aspect-square w-full rounded-g-card border border-g-line object-cover" />
                  {canManage && (
                    <Link href={route('posts.images.destroy', { id: post.id, attachment: imageItem.id })} method="delete" as="button" className="font-mono text-xs text-g-danger hover:underline">
                      Remove
                    </Link>
                  )}
                </figure>
              ))}
            </div>
          )}
          {canManage && (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                  Edit
                </Link>
                {post.publishedAt ? (
                  <Link href={route('posts.unpublish', { id: post.id })} method="post" as="button" className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted">
                    Unpublish
                  </Link>
                ) : (
                  <Link href={route('posts.publish', { id: post.id })} method="post" as="button" className="rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                    Publish
                  </Link>
                )}
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
              <form
                className="flex items-center gap-3 text-sm"
                onSubmit={(event) => {
                  event.preventDefault()
                  coverForm.post(route('posts.cover', { id: post.id }), { onSuccess: () => coverForm.reset() })
                }}
              >
                <input type="file" accept="image/*" onChange={(event) => coverForm.setData('cover', event.target.files?.[0] ?? null)} className="text-sm" />
                <button type="submit" disabled={coverForm.processing || !coverForm.data.cover} className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted">
                  {post.cover ? 'Replace cover' : 'Add cover'}
                </button>
                {coverForm.errors.cover && <span className="text-g-danger">{coverForm.errors.cover}</span>}
              </form>
            </div>
          )}

          <section className="space-y-4 border-t border-g-line pt-6">
            <h2 className="text-xl font-bold text-g-heading">Comments</h2>
            {comments.length === 0 && <p className="text-g-text-2">No comments yet.</p>}
            {comments.map((comment) => (
              <article key={comment.id} className="rounded-g-card border border-g-line bg-g-panel p-4">
                <p className="whitespace-pre-wrap">{comment.body}</p>
                <p className="mt-2 flex items-center gap-3 font-mono text-xs text-g-text-2">
                  <span>{comment.author?.name ?? 'unknown'} · {comment.createdAt}</span>
                  {comment.canDelete && (
                    <Link href={route('comments.destroy', { id: comment.id })} method="delete" as="button" className="text-g-danger hover:underline">
                      Delete
                    </Link>
                  )}
                </p>
              </article>
            ))}
            {signedIn ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  form.post(route('comments.store', { id: post.id }), { onSuccess: () => form.reset() })
                }}
              >
                <textarea
                  value={form.data.body}
                  onChange={(event) => form.setData('body', event.target.value)}
                  placeholder="Add a comment"
                  rows={3}
                  className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
                />
                {form.errors.body && <p className="text-sm text-g-danger">{form.errors.body}</p>}
                <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Comment
                </button>
              </form>
            ) : (
              <p className="text-sm text-g-text-2">
                <Link href={route('login')} className="text-g-accent-text hover:underline">Sign in</Link> to comment.
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

rubric は次のとおりです。

- `images` が `hasManyAttached({ image: 'require' })` で宣言され、モデルのほかの宣言は変わっていない。
- `store` が `this.files('images')` のファイルをすべて attach し、`destroyImage` が投稿にスコープされた `detach(post.id, 'images', attachmentId)` で 1 枚を取り除く。投稿へのほかのすべての変更と同じ `authorize('update', ...)` を通したあとに。
- `show` が `cover` と `images` を 1 回の `withAttachments` 呼び出しで読み込み、リソースがギャラリーを `AttachmentData[]` として公開する。
- 削除ルートが、投稿には `bind` を、attachment の id には `params` スキーマを持ち、`auth` グループの中にある。
- attachment のテスト 5 件が緑で、`guren check` は attachment の 4 つのルールを相変わらず通す。

**チェックポイント:** 画像が 3 枚ある投稿と、あなたが取り除いた 4 枚目。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add a gallery to posts"
```

## いまいる場所

- 署名付きのルートの向こう、private なディスクの上に置かれた attachments レイヤー。テーブルと config と prune コマンドを伴う。
- 投稿ごとのカバー画像。フォームからアップロードされ、専用のルートで差し替えられ、投稿とともに purge される。
- 委ねて作ったギャラリー。投稿にスコープされた、画像ごとの削除を伴う。
- `guren check` の中の attachment のルール 4 つと、ディスクのルールが警告ではなく失敗である理由。

## よくあるつまずき

- **`guren check` が「Attachable model wiring」で失敗する。** モデルが `Attachable` を mixin しているのに、`config/`、`src/`、`app/` のどこにも `configureAttachments()` の呼び出しがありません。mixin はレイヤーを初回利用時に解決するので、このチェックが無ければ最初のアップロードで失敗していたはずです。`bunx guren add attachments` が欠けている半分を導入します。
- **ブラウザで画像の URL が 404 になる。** 署名付き URL の期限が切れています(既定では 5 分)。ページを再読み込みすれば新しいものが得られます。レンダリングし直したページでも 404 なら、`registerAttachmentRoutes` がマウントされていません。
- **編集フォームからアップロードしても何も起きない。** ファイルを伴う `form.put()` にはメソッドの詐称が要りますが、フレームワークはそれをしません。`posts.cover` がそうしているように、ファイルには `POST` のルートを使ってください。
- **「The file must be an image.」** `image: 'require'` は拡張子ではなくバイト列を検査します。名前を変えただけのテキストファイルは拒否され、`.jpg` という名前の本物の PNG は受け入れられます。
- **投稿を削除しても `storage/app/attachments` にファイルが残る。** `delete` の前に `purgeAttachments` が呼ばれていません。attachments テーブルには、代わりに purge してくれる外部キーがありません。`bunx guren attachments:prune` が残り物を見つけます。

## 次へ

[第 11 章: イベントとメール](./11-events-and-mail.md) では、誰かがコメントしたときに著者へ知らせます。イベント、リスナー、キューに入るジョブ、そしてメール本体です。コメントした全員への一斉送信はエージェントに委ねます。
