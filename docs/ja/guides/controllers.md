# コントローラーガイド

コントローラーは HTTP リクエストを受け取り、モデルを通してデータを取得して、Inertia のページや JSON でレスポンスを返します。コントローラーはすべて `app/Http/Controllers/` に置き、フレームワークの `Controller` 基底クラスを継承します。このガイドでは、`routes/web.ts` で定義したルートとコントローラーをつなぐ方法も説明します。

## ルーティングの基本
ルートは、`routes/web.ts` から export した registrar の中で登録します。コントローラーを import し、HTTP メソッドとパスに割り当ててください。

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

- 各ルートには、パスと `[コントローラークラス, 'メソッド名']` のタプルを渡します。
- `router.group('/posts', (posts) => { ... })` を使うと、複数のルートでプレフィックスとミドルウェアを共有できます。
- registrar を `src/app.ts` で `createApp({ routes: registerWebRoutes })` に渡すと、起動時にルートが登録されます。

構成が複雑になってきたら、`routes/api.ts` のようにルートファイルを増やし、同じように `src/app.ts` でまとめて登録できます。

グループ、ミドルウェア、インラインハンドラーの詳細は[ルーティングガイド](./routing.md)を参照してください。

## コントローラーの作成
コントローラーのファイルは CLI で雛形生成できます。

```bash
bunx guren make:controller PostsController
```

このコマンドを実行すると、最小限のクラス定義を書いた `PostsController.ts` が `app/Http/Controllers/` にできます。手で作っても構いません。その場合は、`Controller` を継承したクラスを default export してください。

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

コントローラーでは、`static inject` を使ってコンストラクタに依存を注入できます。必要なサービスのコンテナキーを宣言しておくと、Guren がコントローラーを生成するときに自動で解決して渡します。

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

`inject` に `as const` を付けると、型の情報が失われません。配列の各文字列は、サービスコンテナに登録したキーに対応します。

## ルート登録
コントローラーとルートは、`routes/web.ts` の registrar の中で結び付けます。

```ts
import { Router } from '@guren/core'
import PostsController from '@/app/Http/Controllers/PostsController'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostsController, 'index'])
  router.post('/posts', [PostsController, 'store'])
}
```

`[Controller, 'method']` のタプルで、リクエストごとにどのクラスを生成してどのメソッドを呼ぶかが決まります。メソッドは非同期でも構いません。

## リクエストへのアクセス
- `this.ctx` で Hono のコンテキスト全体を扱えます。ヘッダーやレスポンスのヘルパーもここから使えます。
- `this.request` で元の `Request` オブジェクトを取得できます。

### 入力ヘルパー

コントローラーには、リクエストの入力を読むためのメソッドが用意されています。

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

これらのヘルパーは、JSON とフォームエンコードのどちらのリクエストボディでも使えます。ボディを読むメソッド（`input`、`only`、`except`、`has`）はリクエストボディを非同期でパースするので、`await` が必要です。`query` メソッドは URL のクエリパラメータを読むだけなので、同期的に値を返します。

## レスポンスの返却

| ヘルパー | 用途 |
|--------|---------|
| `this.inertia(component, props, options?)` | `resources/js/pages/<component>.tsx` で Inertia ページを描画します。`Promise<Response>` を返すので、コントローラーのアクションは `async` にして、戻り値をそのまま `return` してください。 |
| `this.view(component, props, options?)` | `app/View/` のコンポーネントを、サーバーで描画した HTML として返します。公開ページや閲覧が中心のページに向いています。詳細は[サーバーレンダリングビュー](./views.md)を参照してください。 |
| `this.json(data, init?)` | ステータス 200 で JSON を返します。 |
| `this.created(data)` | ステータス 201 で JSON を返します。 |
| `this.accepted(data)` | ステータス 202 で JSON を返します。 |
| `this.noContent()` | 空の 204 レスポンスを返します。 |
| `this.redirect(url, status?)` | 別の URL へリダイレクトします（ステータスの既定値は 302）。 |

`this.inertia()` は、Inertia ページの `url` に、クエリ文字列を含むリクエストパス（例: `/posts?page=2`）を設定します。クライアント側で `usePage().url` が返すのはこの値です。別の値にしたいときだけ、`url` オプションを渡してください。

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

コントローラーの各メソッドからは、これらのヘルパーのどれかを返してください。独自のヘッダーを付けたい場合は、`return this.ctx.newResponse(body, init)` で `Response` を自分で組み立てられます。

## バリデーション

### ルートコントラクト（推奨）

ルートに `params`、`query`、`body` のスキーマを宣言しておくと、アクションが実行される前にフレームワークがリクエストを検証し、失敗すれば 422 を返します。アクションの中で検証をやり直す必要はなく、パース済みの値を読むだけで済みます。

```ts
// routes/web.ts
router.post('/posts', { name: 'posts.store', body: StorePostSchema }, [PostsController, 'store'])

// app/Http/Controllers/PostsController.ts
export default class PostsController extends Controller {
  async store() {
    const { body } = this.validated('posts.store') // 検証済み
    const post = await Post.create(body)
    return this.redirect(`/posts/${post.id}`)
  }
}
```

`this.validated(routeName)` は、スキーマでパースした `{ params, query, body }` を返します。`guren codegen` を実行した後は、ルートコントラクトをもとに型が付きます。詳しくは[検証済み入力の読み取り](./routing.md#検証済み入力の読み取り)を参照してください。

### Zod スキーマヘルパー

コントラクトの無いルートでは、コントローラーの中で `validateBody`、`validateQuery`、`validateParams` を使うのがいちばん簡単です。これらは `safeParse()` メソッドを持つスキーマ（Zod、Valibot など）なら何でも受け取り、検証に失敗すると `ValidationException`（422）を投げます。

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'
import { Post } from '@/app/Models/Post'
import type { UserRecord } from '@/app/Models/User'

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
    const user = await this.auth.userOrFail<UserRecord>()     // 401 をスロー
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

| ヘルパー | 入力元 | 非同期 |
|--------|--------|--------|
| `this.validateBody(schema)` | リクエストボディ（JSON / フォーム） | はい |
| `this.validateQuery(schema)` | URL クエリパラメータ | いいえ |
| `this.validateParams(schema)` | ルートパラメータ（`:id` など） | いいえ |

3 つとも、失敗すると `ValidationException`（HTTP 422）を投げます。この例外は `ExceptionHandler` が自動でレスポンスに変換します。

### FormRequest 互換レイヤー

新しく書くコードでは、スキーマを先に定義する書き方をおすすめします。`FormRequest` を使うのは、既存コードを移行するときや、クラスで認可を書きたいときだけにしてください。

```ts
async store() {
  const data = await new StorePostRequest().handle(this.ctx)
  // `data` は StorePostRequest に基づいて完全に型付けされています
  const post = await Post.create(data)
  return this.redirect('/posts')
}
```

バリデーションに失敗すると、エラーの詳細を含む 422 レスポンスが自動で返ります。`authorize()` メソッドが `false` を返した場合は、403 レスポンスが返ります。

FormRequest クラスとバリデーションルールの書き方は、[バリデーションガイド](./validation.md)を参照してください。新しく実装するときは、ルートコントラクトと `this.validated()` を使い、コントラクトの無いルートでは `validateBody()` / `validateQuery()` / `validateParams()` を使ってください。

## メソッド間でのデータ共有
コントローラーはリクエストごとに生成されるので、あるメソッドでインスタンスのフィールドに値を入れ、別のヘルパーメソッドでそれを使い回せます。ログイン中のユーザー情報のように全ページで使うデータは、Inertia の共有プロパティかミドルウェアで渡すことを検討してください。

## Inertia 共有プロパティ
`shareInertiaProps()` を使うと、アプリケーション全体で使うデータをすべての Inertia レスポンスに含められます。呼び出す場所は、サービスプロバイダー（`bunx guren make:provider` で生成）の `boot()` が適しています。

```ts
// app/Providers/AppInfoProvider.ts
import { ServiceProvider, shareInertiaProps } from '@guren/core'

export default class AppInfoProvider extends ServiceProvider {
  boot(): void {
    shareInertiaProps(() => ({
      appVersion: process.env.APP_VERSION || 'dev',
    }), this.container)
  }
}
```

> [!NOTE]
> `createApp({ i18n })` でアプリを作っていれば、リクエストのロケールと翻訳カタログは自動で共有されます（[i18nガイド](./i18n.md)を参照してください）。ここでロケールの検出処理を書く必要はありません。

渡した props は、先に登録されたリゾルバーの props に重ねてマージされます。そのため、複数のプロバイダーがそれぞれ共有 props を追加しても、互いの値を消してしまうことはありません。

`this.container` を渡すと、その props はそのアプリケーションの中だけで使われます。省略するとプロセス全体で共有されるので、同じプロセスで起動した 2 つ目のアプリケーション（テストスイートや、起動済みのまま再利用されるサーバーレス環境）にも渡ってしまいます。

> [!NOTE]
> ログイン中のユーザー（`auth.user`）は、`bunx guren add auth` が生成する `AuthProvider` がすでに共有しています。自分で登録し直す必要はありません（詳細は[認証ガイド](./authentication.md)を参照してください）。

export されている `InertiaSharedProps` インターフェースを拡張しておくと、コントローラーでも React ページでも共有プロパティに型が付きます。

```ts
// types/inertia.d.ts
import type { UserRecord } from '@/app/Models/User'

declare module '@guren/core' {
  interface InertiaSharedProps {
    auth: { user: UserRecord | null }
  }
}
```

コンポーネントの props の型が必要なときは、`InferInertiaProps<ReturnType<Controller['action']>>` を使うと、アクションが渡す props と共有プロパティの両方を含む型が得られます。

## コントローラーのテスト
- `TestApp` を使うと、アサーションをメソッドチェーンでつなげて HTTP レベルのテストを書けます。

```ts
import { TestApp } from '@guren/testing'

const app = await TestApp.create()
await app.get('/posts').assertOk().assertJsonCount(3, 'data')
await app.post('/posts', { title: 'New' }).assertStatus(201)
await app.actingAs(user).get('/dashboard').assertStatus(200)
```

- ユニットテストでは、必要な依存を用意し、`setContext(ctx)` を呼んでから、コントローラーのメソッドを直接実行できます。
- エンドツーエンドで確かめたい場合は、起動中のアプリケーションに `fetch` や好みの HTTP クライアントでリクエストを送り、レスポンスを検証してください。

ビジネスロジックをモデルやサービスに任せれば、コントローラーは小さく保てます。コントローラーは、アプリケーションの各部分を呼び出してつなぐ層として扱ってください。

## Model ヘルパー vs Drizzle RQB（並列比較）

データアクセスの書き方はどちらも使えます。手早く CRUD を書くならモデルヘルパーを使い、結合や集計、ドライバー固有の機能が必要になったら Drizzle のリレーショナルクエリビルダーに切り替えてください。

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

SSR バンドルがあれば、Guren はページを自動でサーバー側で描画します。`ssr` オプションを渡すと、この動作をレスポンスごとに無効にしたり、変更したりできます。

```ts
return this.inertia(pages.posts.Index, props, {
  ssr: {
    enabled: false, // このレスポンスではクライアントサイドレンダリングを強制
  },
})
```

さらに細かく制御したい場合は、`ssr.render` に独自のレンダラーを指定できます。レンダラーはページのペイロードを受け取るので、`renderInertiaServer()` などのユーティリティに処理を任せられます。
