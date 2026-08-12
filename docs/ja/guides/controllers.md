# コントローラーガイド

コントローラーは、受信した HTTP リクエストを処理し、モデルを通じてデータを取得し、Inertia や JSON ペイロードでレスポンスを返す役割を担います。すべてのコントローラーは `app/Http/Controllers/` に配置し、フレームワークの `Controller` 基底クラスを継承します。このガイドでは、コントローラーと `routes/web.ts` で定義されるルートとの接続方法も説明します。

## ルーティングの基本
ルートは `routes/web.ts` で registrar を export して登録します。コントローラーをインポートして、HTTP メソッドとパスにマッピングしましょう。

```ts
// routes/web.ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  router.get('/', [PostsController, 'index'])
  router.get('/posts/:id', [PostsController, 'show'])
  router.post('/posts', [PostsController, 'store'])
}
```

- 各ルートはパスと `[コントローラークラス, 'メソッド名']` のタプルを受け取ります。
- `router.group('/posts', (posts) => { ... })` でプレフィックスとミドルウェアを共有できます。
- `src/app.ts` で `createApp({ routes: registerWebRoutes })` に渡すことで、起動時にルートが登録されます。

より複雑な構成の場合は、追加のルートファイル（例: `routes/api.ts`）を作成し、同様に `src/app.ts` で合成できます。

グループ、ミドルウェア、インラインハンドラーの詳細は[ルーティングガイド](./routing.md)をご覧ください。

## コントローラーの作成
CLI を使ってコントローラーファイルをスキャフォールドできます。

```bash
bunx guren make:controller PostsController
```

ジェネレーターは `PostsController.ts` を `app/Http/Controllers/` に配置し、最小限のクラス定義を生成します。手動で作成することもできます。その場合は、`Controller` を継承するクラスをデフォルトエクスポートしてください。

```ts
// app/Http/Controllers/PostsController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { Post } from '@/app/Models/Post'
import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
import { ListPostsQuerySchema, PostIdParamSchema } from '@/app/Http/Validators/PostValidator'
import { pages } from '@/.guren/pages.gen'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostsController extends Controller {
  async index() {
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

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }
}
```

## 依存性注入

コントローラーは `static inject` を使ったコンストラクタベースの依存性注入をサポートしています。コントローラーが必要とするコンテナキーを宣言すると、Guren がインスタンス化時に自動的に解決します。

```ts
import { Controller } from '@guren/core'
import type { CacheManager } from '@guren/core'
import type { EventManager } from '@guren/core'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  static inject = ['cache', 'events'] as const

  constructor(
    private cache: CacheManager,
    private events: EventManager,
  ) {
    super()
  }

  async index() {
    const cached = await this.cache.get('posts:index')
    if (cached) return this.json(cached)

    const posts = await Post.all()
    await this.cache.put('posts:index', posts, 300)
    return this.json(posts)
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    this.events.dispatch(new PostCreated(post))
    return this.created({ post })
  }
}
```

`inject` の `as const` アサーションにより型安全性が確保されます。配列内の各文字列は、サービスコンテナに登録されたキーに対応します。

## ルート登録
コントローラーは `routes/web.ts` の registrar からルートに接続します。

```ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostsController, 'index'])
  router.post('/posts', [PostsController, 'store'])
}
```

`[Controller, 'method']` タプルは、Guren にどのクラスをインスタンス化し、どのメソッドを呼び出すかを指示します。メソッドは非同期にできます。

## リクエストへのアクセス
- `this.ctx` で Hono コンテキスト全体にアクセスできます。ヘッダーやレスポンスヘルパーも含まれます。
- `this.request` で基底の `Request` オブジェクトを取得できます。

### 入力ヘルパー

コントローラーには、リクエスト入力を読み取るための便利なメソッドが用意されています。

```ts
// 単一の入力値を読み取る（JSON ボディまたはフォームデータから）
const title = await this.input('title')

// クエリパラメータを読み取る（デフォルト値を指定可能）
const page = this.query('page', '1')

// schema-first の標準入力
const data = await this.validateBody(StorePostSchema)

// フィールドがリクエストに存在するか確認する
if (await this.has('email')) {
  // ...
}
```

これらのヘルパーは JSON とフォームエンコードの両方のリクエストボディで動作します。ボディを読み取るメソッド（`input`、`only`、`except`、`has`）はリクエストボディを非同期でパースするため `await` が必要です。`query` メソッドは URL クエリパラメータから読み取るため同期的です。

## レスポンスの返却

| ヘルパー | 用途 |
|--------|---------|
| `this.inertia(component, props, options?)` | `resources/js/pages/<component>.tsx` を使って Inertia ページをレンダリングします。`Promise<Response>` を返すため、コントローラーアクションは `async` にして `return` で直接返してください。 |
| `this.json(data, init?)` | ステータス 200 で JSON を返します。 |
| `this.created(data)` | ステータス 201 で JSON を返します。 |
| `this.accepted(data)` | ステータス 202 で JSON を返します。 |
| `this.noContent()` | 空の 204 レスポンスを返します。 |
| `this.redirect(url, status?)` | 別の場所にリダイレクトします（デフォルトステータス 302）。 |

`this.inertia()` は Inertia ページの `url` にクエリ文字列を含むリクエストパス（例: `/posts?page=2`）を設定します。クライアント側の `usePage().url` はこの値を返します。上書きしたい場合のみ `url` オプションを渡してください。

### レスポンスヘルパーの例

```ts
export default class PostsController extends Controller {
  async store() {
    const data = await this.validateBody(StorePostSchema)
    const post = await Post.create(data)
    return this.created({ post })
  }

  async update() {
    const post = await Post.findOrFail(this.ctx.req.param('id'))
    const data = await this.validateBody(StorePostSchema)
    await Post.update(post.id, data)
    return this.accepted({ post: { ...post, ...data } })
  }

  async destroy() {
    await Post.delete({ id: Number(this.ctx.req.param('id')) })
    return this.noContent()
  }
}
```

各コントローラーメソッドからこれらのヘルパーのいずれかを返してください。カスタムヘッダーが必要な場合は、`return this.ctx.newResponse(body, init)` で `Response` を手動作成できます。

## バリデーション

### Zod スキーマヘルパー（推奨）

コントローラー内で `validateBody`、`validateQuery`、`validateParams` を使うのが最もシンプルです。`safeParse()` メソッドを持つ任意のスキーマ（Zod、Valibot など）を受け取り、失敗時に `ValidationException`（422）をスローします。

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'
import { Post } from '@/app/Models/Post'

const PostIdParamSchema = z.object({ id: z.coerce.number().int().positive() })
const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) })

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema) // 422 をスロー
    const result = await Post.paginate({ page, perPage: 10 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })
    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema) // 422 をスロー
    const post = await Post.findOrFail(id) // 404 をスロー
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }

  async store() {
    const data = await this.validateBody(StorePostSchema)     // 422 をスロー
    const user = await this.auth.userOrFail()                 // 401 をスロー
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

| ヘルパー | 入力元 | 非同期 |
|--------|--------|--------|
| `this.validateBody(schema)` | リクエストボディ（JSON / フォーム） | Yes |
| `this.validateQuery(schema)` | URL クエリパラメータ | No |
| `this.validateParams(schema)` | ルートパラメータ（`:id` など） | No |

いずれも失敗時に `ValidationException`（HTTP 422）をスローし、`ExceptionHandler` が自動でレンダリングします。

### FormRequest 互換レイヤー

新規コードでは schema-first を推奨します。既存コードの移行やクラスベースの認可が必要な場合のみ `FormRequest` を使います。

```ts
async store() {
  const data = await new StorePostRequest().handle(this.ctx)
  // `data` は StorePostRequest に基づいて完全に型付けされています
  const post = await Post.create(data)
  return this.redirect('/posts')
}
```

バリデーションが失敗すると、エラー詳細を含む 422 レスポンスが自動的に返されます。`authorize()` メソッドが `false` を返した場合は、403 レスポンスが返されます。

FormRequest クラスとバリデーションルールの定義については、[バリデーションガイド](./validation.md)をご覧ください。新規実装では `validateBody()` / `validateQuery()` / `validateParams()` を優先してください。

## メソッド間でのデータ共有
コントローラーはリクエストごとにインスタンス化されるため、あるメソッドでインスタンスフィールドを設定して、ヘルパーメソッドで再利用できます。全ページ共通のデータ（例: ユーザー情報）については、Inertia の共有プロパティやミドルウェアの利用を検討してください。

## Inertia 共有プロパティ
`shareInertiaProps()` を使って、すべての Inertia レスポンスにアプリケーション全体のデータを注入できます。サービスプロバイダー（`bunx guren make:provider` で生成）の `boot()` から呼ぶのが定位置です。

```ts
// app/Providers/AppInfoProvider.ts
import { ServiceProvider, shareInertiaProps } from '@guren/core'

export default class AppInfoProvider extends ServiceProvider {
  boot(): void {
    shareInertiaProps(() => ({
      appVersion: process.env.APP_VERSION ?? 'dev',
    }), this.container)
  }
}
```

> [!NOTE]
> リクエストのロケールと翻訳カタログは、`createApp({ i18n })` でアプリを作成していれば自動的に共有されます — [i18nガイド](./i18n.md)を参照してください。ここでロケール検出を手書きする必要はありません。

先に登録されたリゾルバーの props にマージされるので、複数のプロバイダーがそれぞれ共有 props を足しても互いを壊しません。

`this.container` を渡すと、その props はそのアプリケーションだけに閉じます。省略するとプロセス全体で共有されるため、同一プロセスで起動した2つ目のアプリケーション（テストスイートや暖機済みのサーバーレス環境）にも渡ってしまいます。

> [!NOTE]
> 認証ユーザー（`auth.user`）の共有は `bunx guren add auth` が生成する `AuthProvider` が既に登録済みです。自分で登録し直す必要はありません — 詳細は[認証ガイド](./authentication.md)を参照してください。

エクスポートされた `InertiaSharedProps` インターフェースを拡張して、コントローラーと React ページ全体でプロパティの型を維持しましょう。

```ts
// types/inertia.d.ts
import type { UserRecord } from '@/app/Models/User'

declare module '@guren/core' {
  interface InertiaSharedProps {
    auth: { user: UserRecord | null }
  }
}
```

コンポーネントのプロパティ型が必要な場合は、`InferInertiaProps<ReturnType<Controller['action']>>` でアクションプロパティと共有プロパティの両方を含む型を取得できます。

## コントローラーのテスト
- `TestApp` を使うと、Fluent アサーションで表現力豊かな HTTP レベルのテストが書けます。

```ts
import { TestApp } from '@guren/testing'

const app = await TestApp.create()
await app.get('/posts').assertOk().assertJsonCount(3, 'data')
await app.post('/posts', { title: 'New' }).assertStatus(201)
await app.actingAs(user).get('/dashboard').assertStatus(200)
```

- ユニットレベルのテストでは、必要な依存関係を構築し、メソッド呼び出し前に `setContext(ctx)` を呼んでから、コントローラーメソッドを直接実行できます。
- エンドツーエンドのカバレッジには、実行中のアプリケーションに `fetch` またはお好みの HTTP クライアントでアクセスし、レスポンスをアサートしてください。

コントローラーはビジネスロジックをモデルやサービスに委譲することでスリムに保てます。アプリケーションの各部分をつなぎ合わせるオーケストレーション層として扱いましょう。

## Model ヘルパー vs Drizzle RQB（並列比較）

どちらのアクセスパターンもサポートされています。素早い CRUD にはモデルヘルパーを使い、結合・集約・ドライバー固有の機能が必要な場合は Drizzle のリレーショナルクエリビルダーに切り替えてください。

```ts
// モデルファースト: 簡潔で一貫性がある
import { Controller, paginate } from '@guren/core'
import { Post } from '@/app/Models/Post'
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

export default class PostsController extends Controller {
  async index() {
    const result = await Post.paginate({ page: 1, perPage: 10, orderBy: ['publishedAt', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })
    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    })
  }
}
```

```ts
// Drizzle RQB: フルコントロール、型安全性も維持
import { Controller } from '@guren/core'
import { getDatabase } from '@/config/database'
import { posts, users } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'
import { pages } from '@/.guren/pages.gen'

export default class PostsController extends Controller {
  async index() {
    const db = await getDatabase()
    const postsWithAuthor = await db
      .select({
        id: posts.id,
        title: posts.title,
        author: users.name,
      })
      .from(posts)
      .leftJoin(users, eq(posts.authorId, users.id))
      .where(eq(posts.published, true))
      .orderBy(desc(posts.publishedAt))

    return this.inertia(pages.posts.Index, {
      data: postsWithAuthor,
      pagination: {
        meta: {
          currentPage: 1,
          perPage: postsWithAuthor.length,
          total: postsWithAuthor.length,
          lastPage: 1,
          from: postsWithAuthor.length > 0 ? 1 : 0,
          to: postsWithAuthor.length,
          hasMorePages: false,
        },
        links: {
          first: '/posts',
          last: '/posts',
          prev: null,
          next: null,
          pages: [{ label: '1', page: 1, url: '/posts', active: true }],
        },
      },
    })
  }
}
```

### SSR オプション

SSR バンドルが利用可能な場合、Guren はサーバーサイドでページを自動的にレンダリングします。`ssr` オプションを渡すことで、レスポンスごとにこの動作を無効化またはカスタマイズできます。

```ts
return this.inertia(pages.posts.Index, props, {
  ssr: {
    enabled: false, // このレスポンスではクライアントサイドレンダリングを強制
  },
})
```

高度なユースケースでは、`ssr.render` でカスタムレンダラーを指定できます。ページペイロードを受け取り、`renderInertiaServer()` などのユーティリティに処理を委譲できます。
