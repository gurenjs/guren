# アーキテクチャ

Guren は Laravel の設計思想を TypeScript 上で再構成し、Bun・Hono・Inertia.js・React・Drizzle ORM を束ねたフルスタック MVC フレームワークです。ここではルーティングからレスポンス生成までの流れと主要コンポーネントを説明します。

## ハイレベルな流れ
1. **ルーティング**: `routes/web.ts` に registrar を export し、app-local な `Router` にルートを定義。
2. **コントローラー**: `Controller` を継承し、Hono の `Context` を利用。
3. **モデル**: `defineModel(table)` で Drizzle スキーマからモデルを導出。
4. **ビュー**: `resources/js/pages/` の React コンポーネントを Inertia 経由で描画。
5. **アプリ起動**: `createApp({ routes, providers })` がルートとサービスを束ね、Bun/Hono サーバーを開始。

## プロジェクト構成
- `app/Http/Controllers/`: コントローラーを配置。
- `app/Models/`: Drizzle バックエンドのモデル (`Model<T>`) を配置。
- `config/`: アプリやデータベースの設定ファイル。
- `db/`: スキーマ定義、マイグレーション、シーダー。
- `resources/js/pages/`: Inertia で描画される React ページ。
- `routes/`: ルート宣言（`routes/web.ts`）。
- `src/`: アプリのブートストラップ（`src/main.ts`, `src/app.ts`）。

## 命名規約
- 単一のクラスや型をエクスポートするファイル（コントローラー、モデル、HTTP アプリなど）は `PascalCase.ts` で、ファイル名をエクスポートに揃えます。
- 関数やユーティリティを集めるモジュールは `kebab-case.ts`（例: `dev-assets.ts`, `inertia-assets.ts`）で、クラス中心のモジュールと区別します。
- ディレクトリ内ではどちらかに統一します。例: `app/Http/Controllers/` や `app/Models/` は新規クラスなら PascalCase、ヘルパー中心のディレクトリは kebab-case を維持します。

## ルーティング
`routes/web.ts` は registrar を export します。

```ts
import { Router } from '@guren/core'
import PostController from '@/app/Http/Controllers/PostController'

export function registerWebRoutes(router: Router): void {
  router.get('/', [PostController, 'index'])
  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index'])
    posts.get('/:id', [PostController, 'show'])
  })
}
```

- 各 `Application` は独立した `Router` を持ち、`app.boot()` 時に Hono にマウントされます。
- コントローラーは `[Class, 'method']` タプルで参照します。`router.resource()` も利用できます。

## コントローラー
コントローラーは `Controller` を継承し、`setContext()` 経由で Hono の `Context` を受け取ります。`this.inertia()` や `this.json()` などのヘルパーでレスポンスを返します。

```ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

export default class PostController extends Controller {
  async index() {
    const result = await Post.paginate({ page: 1, perPage: 15 })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia<PostsIndexProps>(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: paginator,
    })
  }
}
```

- `this.ctx`: Hono のコンテキスト全体。
- `this.request`: 内部の Request へのショートカット。
- `this.inertia(component, props, options)`: Inertia レスポンスを生成。

## モデルと ORM
モデルは `defineModel(table)` を使って Drizzle スキーマに接続します。レイヤーは薄く、簡単な CRUD はヘルパーで、高度なクエリは Drizzle RQB に直接落とせます。

```ts
export type PostRecord = typeof posts.$inferSelect

export class Post extends defineModel(posts) {}
```

- `Model.all()`, `Model.find(id)`, `Model.findOrFail()`, `Model.first()`, `Model.create(data)` など Laravel 風のヘルパーを提供。
- Drizzle の推論により静的ヘルパーが型安全になります（例: `Post.find()` が `PostRecord | null` を返す）。
- `DatabaseProvider`（内部で `bootModels()` を呼び、`DrizzleAdapter.configure(db)` を実行）などのプロバイダーを使うと、全モデルでアダプターが使えるようになります。より細かい制御が必要なら `Model.query(db)` や Drizzle の DB インスタンスを直接利用します。

## Inertia.js とビュー
- React ページは `resources/js/pages/` 配下に置き、コンポーネント名で参照します。
- サーバーは `data-page` 属性を通して Inertia ペイロードを HTML に埋め込みます。
- クライアントは CDN ESM から React/Inertia を読み込み、初期ページをハイドレートします。

## サービスプロバイダ

Guren v0.3 では全プロバイダが `ServiceProvider` を継承する統一パターンに移行しました。`this.container` 経由でサービスコンテナにアクセスできます。

```ts
import { ServiceProvider } from '@guren/core'

export default class AppServiceProvider extends ServiceProvider {
  register(): void {
    // サービスの登録
    this.container.singleton('myService', () => new MyService())
  }

  boot(): void {
    // 初期化処理
    const service = this.container.make<MyService>('myService')
    service.init()
  }
}
```

> **グローバルミドルウェアは `register()` で追加してください。** ルートは
> `register()` と `boot()` の**間**にマウントされ、Hono はマッチしたルートより
> 前に登録されたミドルウェアしか適用しません — `boot()` からの `app.use()` は
> ルートに対して実行されません。リソースの読み込みが必要な場合は両フックとも
> `async` にできます:
>
> ```ts
> export default class I18nProvider extends ServiceProvider {
>   async register(): Promise<void> {
>     const i18n = createI18n({ locale: 'ja', fallbackLocale: 'en', path: './lang' })
>     await i18n.loadLocales(['en', 'ja'])
>     setI18n(i18n)
>
>     const app = this.container.make<Application>('app')
>     app.use('*', localeMiddleware) // boot() ではなく register() で
>   }
> }
> ```

### ファサード

頻繁に使うサービスにはファサードが用意されています。コンテナから遅延解決されるため、import するだけで利用可能です。

```ts
import { createFacades } from '@guren/core'

const { Cache, Events, Log, Mail, Queue } = createFacades(app.container)
```

## アプリケーションのブート
生成済みプロジェクトの `src/main.ts` は以下の手順を示します。

1. `routes/web.ts` から registrar を export する。
2. `const app = createApp({ routes: registerWebRoutes, providers: [DatabaseProvider, ...] })` のように生成し、サービスを早期登録。
3. `await app.boot()` でルートをマウントし、プロバイダーのブートフックを実行し、ミドルウェアを準備。
4. `await app.listen()`（または Bun では `app.listen()`）で HTTP サーバーを開始。戻り値は実際にバインドしたアドレス `{ port, hostname, url }` です。`port: 0` を指定すると OS が空きポートを選び、本番以外ではポートが使用中の場合に次のポートへ移動するため、要求したポートと一致するとは限りません。ポート番号は要求値ではなく戻り値から読み取ってください。

   ```ts
   const { url, port } = await app.listen({ port: 3333 })
   console.log(`listening on ${url}`) // 実際にバインドされたポート
   ```

   ポート移動をやめて `EADDRINUSE` で即座に失敗させたい場合は `portFallback: false` を渡すか、`GUREN_STRICT_PORT=1` を設定します。

この流れは Bun のネイティブモジュールで動作し、`bun run dev` で起動されます。

## データベーススキーマ
- Drizzle のスキーマ定義は `db/schema.ts` に配置。
- `config/database.ts` がコンテナ起動時にテーブルを用意します。
- マイグレーションランナーは設計中で、将来的に Drizzle SQL マイグレーションを統合する予定です。

## リクエストライフサイクル
1. Hono が HTTP リクエストを受信。
2. `Router` がマッチするハンドラを解決。
3. コントローラーが実行され、モデル経由で DB にアクセス。
4. `this.inertia()` がビューへデータを渡し、Inertia レスポンスを組み立て。
5. クライアントは初回に React をハイドレートし、以降の遷移は Inertia の SPA トランジションで行われます。

## ロードマップ（ハイライト）
- テンプレート生成用 CLI（`bunx guren create <name>`）
- 統合マイグレーションランナー
- 認証スキャフォールドとポリシーサポート
- Vite による高度なフロントエンドビルドオプション

内部の詳細をさらに知りたい場合は、[CLI リファレンス](./cli.md) や生成プロジェクト内のインラインドキュメントも参照してください。
