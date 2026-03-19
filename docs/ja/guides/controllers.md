# コントローラーガイド

コントローラーは、受信した HTTP リクエストを処理し、モデルを通じてデータを取得し、Inertia や JSON ペイロードでレスポンスを返す役割を担います。すべてのコントローラーは `app/Http/Controllers/` に配置し、フレームワークの `Controller` 基底クラスを継承します。このガイドでは、コントローラーと `routes/web.ts` で定義されるルートとの接続方法も説明します。

## ルーティングの基本
ルートは `routes/web.ts` で Laravel ライクな DSL を使って登録します。コントローラーをインポートして、HTTP メソッドとパスにマッピングしましょう。

```ts
// routes/web.ts
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/', [PostsController, 'index'])
Route.get('/posts/:id', [PostsController, 'show'])
Route.post('/posts', [PostsController, 'store'])
```

- 各ルートはパスと `[コントローラークラス, 'メソッド名']` のタプルを受け取ります。
- `Route.group('/posts', () => { ... })` でプレフィックスとミドルウェアを共有できます。
- `src/main.ts` で `routes/web.ts` をインポートすることで、起動時にルートが一度だけ登録されます（副作用インポート）。

より複雑な構成の場合は、追加のルートファイル（例: `routes/api.ts`）を作成し、同様に `src/main.ts` からインポートできます。

グループ、ミドルウェア、インラインハンドラーの詳細は[ルーティングガイド](./routing.md)をご覧ください。

## コントローラーの作成
CLI を使ってコントローラーファイルをスキャフォールドできます。

```bash
bunx guren make:controller PostsController
```

ジェネレーターは `PostsController.ts` を `app/Http/Controllers/` に配置し、最小限のクラス定義を生成します。手動で作成することもできます。その場合は、`Controller` を継承するクラスをデフォルトエクスポートしてください。

```ts
// app/Http/Controllers/PostsController.ts
import { Controller } from '@guren/server'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('posts/Index', { posts })
  }
}
```

## 依存性注入

コントローラーは `static inject` を使ったコンストラクタベースの依存性注入をサポートしています。コントローラーが必要とするコンテナキーを宣言すると、Guren がインスタンス化時に自動的に解決します。

```ts
import { Controller } from '@guren/server'
import type { CacheManager } from '@guren/server'
import type { EventManager } from '@guren/server'
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
    const cached = await this.cache.get('posts:all')
    if (cached) return this.json(cached)

    const posts = await Post.all()
    await this.cache.put('posts:all', posts, 300)
    return this.inertia('posts/Index', { posts })
  }

  async store() {
    const data = await this.validate(StorePostRequest)
    const post = await Post.create(data)
    this.events.dispatch(new PostCreated(post))
    return this.created({ post })
  }
}
```

`inject` の `as const` アサーションにより型安全性が確保されます。配列内の各文字列は、サービスコンテナに登録されたキーに対応します。

## ルート登録
コントローラーは `routes/web.ts` で Laravel スタイルの DSL を使ってルートに接続します。

```ts
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/posts', [PostsController, 'index'])
Route.post('/posts', [PostsController, 'store'])
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

// リクエストボディから特定のフィールドのみ取得する
const data = await this.only('title', 'content', 'status')

// 指定したフィールドを除いたすべてのフィールドを取得する
const data = await this.except('_token', '_method')

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

### レスポンスヘルパーの例

```ts
export default class PostsController extends Controller {
  async store() {
    const data = await this.validate(StorePostRequest)
    const post = await Post.create(data)
    return this.created({ post })
  }

  async update() {
    const post = await Post.findOrFail(this.ctx.req.param('id'))
    const data = await this.validate(UpdatePostRequest)
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

コントローラー内で `validateBody`、`validateQuery`、`validateParams` を使うのが最もシンプルです。`safeParse()` メソッドを持つ任意のスキーマ（Zod、Valibot など）を受け取り、失敗時に `ValidationException`（422）をスローします：

```ts
import { Controller } from '@guren/server'
import { z } from 'zod'
import { Post } from '@/app/Models/Post'

const PostIdParamSchema = z.object({ id: z.coerce.number().int().positive() })
const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PageQuerySchema = z.object({ page: z.coerce.number().int().min(1).default(1) })

export default class PostsController extends Controller {
  async index() {
    const { page } = this.validateQuery(PageQuerySchema)    // 422 をスロー
    const posts = await Post.paginate({ page })
    return this.inertia('posts/Index', { posts })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)    // 422 をスロー
    const post = await Post.findOrFail(id)                    // 404 をスロー
    return this.inertia('posts/Show', { post })
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

### FormRequest クラス

認可ロジックが必要なより複雑なシナリオでは、`FormRequest` クラスを使います：

```ts
async store() {
  const data = await this.validate(StorePostRequest)
  // `data` は StorePostRequest に基づいて完全に型付けされています
  const post = await Post.create(data)
  return this.redirect('/posts')
}
```

バリデーションが失敗すると、エラー詳細を含む 422 レスポンスが自動的に返されます。`authorize()` メソッドが `false` を返した場合は、403 レスポンスが返されます。

FormRequest クラスとバリデーションルールの定義については、[バリデーションガイド](./validation.md)をご覧ください。

## メソッド間でのデータ共有
コントローラーはリクエストごとにインスタンス化されるため、あるメソッドでインスタンスフィールドを設定して、ヘルパーメソッドで再利用できます。全ページ共通のデータ（例: ユーザー情報）については、Inertia の共有プロパティやミドルウェアの利用を検討してください。

## Inertia 共有プロパティ
`setInertiaSharedProps()` を使って、すべての Inertia レスポンスにアプリケーション全体のデータ（認証ユーザーなど）を注入できます。

```ts
// config/inertia.ts
import { setInertiaSharedProps, AUTH_CONTEXT_KEY, type AuthContext } from '@guren/server'

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return { auth: { user: await auth?.user() } }
})
```

エクスポートされた `InertiaSharedProps` インターフェースを拡張して、コントローラーと React ページ全体でプロパティの型を維持しましょう。

```ts
// types/inertia.d.ts
import type { UserRecord } from '@/app/Models/User'

declare module '@guren/server' {
  interface InertiaSharedProps {
    auth: { user: UserRecord | null }
  }
}
```

コンポーネントのプロパティ型が必要な場合は、`InferInertiaProps<ReturnType<Controller['action']>>` でアクションプロパティと共有プロパティの両方を含む型を取得できます。

## コントローラーのテスト
- `TestApp` を使うと、流暢なアサーションで表現力豊かな HTTP レベルのテストが書けます。

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
import { Controller } from '@guren/server'
import { Post } from '@/app/Models/Post'

export default class PostsController extends Controller {
  async index() {
    const posts = await Post.where('status', 'published')
      .orderBy('publishedAt', 'desc')
      .limit(10)
      .get()
    return this.inertia('posts/Index', { posts })
  }
}
```

```ts
// Drizzle RQB: フルコントロール、型安全性も維持
import { Controller } from '@guren/server'
import { getDatabase } from '@/config/database'
import { posts, users } from '@/db/schema'
import { eq, desc } from 'drizzle-orm'

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

    return this.inertia('posts/Index', { posts: postsWithAuthor })
  }
}
```

### SSR オプション

SSR バンドルが利用可能な場合、Guren はサーバーサイドでページを自動的にレンダリングします。`ssr` オプションを渡すことで、レスポンスごとにこの動作を無効化またはカスタマイズできます。

```ts
return this.inertia('posts/Index', props, {
  ssr: {
    enabled: false, // このレスポンスではクライアントサイドレンダリングを強制
  },
})
```

高度なユースケースでは、`ssr.render` でカスタムレンダラーを指定できます。ページペイロードを受け取り、`renderInertiaServer()` などのユーティリティに処理を委譲できます。
