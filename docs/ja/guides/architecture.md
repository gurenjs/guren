# アーキテクチャ

Guren は Laravel の設計思想を TypeScript 上で再構成し、Bun・Hono・Inertia.js・React・Drizzle ORM を束ねたフルスタック MVC フレームワークです。ここではルーティングからレスポンス生成までの流れと主要コンポーネントを説明します。

## ハイレベルな流れ
1. **ルーティング**: `routes/web.ts` に `Route` DSL でルートを定義。
2. **コントローラ**: `Controller` を継承し、Hono の `Context` を利用。
3. **モデル**: `Model<TRecord>` を継承し、Drizzle スキーマを `static table` に紐付け。
4. **ビュー**: `resources/js/pages/` の React コンポーネントを Inertia 経由で描画。
5. **アプリ起動**: `Application` がルートとモデルを初期化し、Bun/Hono サーバーを開始。

## プロジェクト構成
- `app/Http/Controllers/`: コントローラを配置。
- `app/Models/`: Drizzle バックエンドのモデル (`Model<T>`) を配置。
- `config/`: アプリやデータベースの設定ファイル。
- `db/`: スキーマ定義、マイグレーション、シーダー。
- `resources/js/pages/`: Inertia で描画される React ページ。
- `routes/`: ルート宣言（`routes/web.ts`）。
- `src/`: アプリのブートストラップ（`src/main.ts`, `src/app.ts`）。

## 命名規約
- 単一のクラスや型をエクスポートするファイル（コントローラ、モデル、HTTP アプリなど）は `PascalCase.ts` で、ファイル名をエクスポートに揃えます。
- 関数やユーティリティを集めるモジュールは `kebab-case.ts`（例: `dev-assets.ts`, `inertia-assets.ts`）で、クラス中心のモジュールと区別します。
- ディレクトリ内ではどちらかに統一します。例: `packages/server/src/http/` は新規クラスなら PascalCase、アセットミドルウェアや CLI ユーティリティのようにヘルパー中心のディレクトリは kebab-case を維持します。

## ルーティング
`routes/web.ts` は Laravel 風の DSL を使います:

```ts
import PostController from '@/Http/Controllers/PostController'

Route.get('/', [PostController, 'index'])
Route.group('/posts', () => {
  Route.get('/', [PostController, 'index'])
  Route.get('/:id', [PostController, 'show'])
})
```

- ルートは静的レジストリに保持され、`app.boot()` 時に Hono にマウントされます。
- コントローラは `[Class, 'method']` タプルで参照します。`Route.resource()` のようなヘルパーは今後追加予定です。

## コントローラ
コントローラは `Controller` を継承し、`setContext()` 経由で Hono の `Context` を受け取ります。`this.inertia()` や `this.json()` などのヘルパーでレスポンスを返します。

```ts
export default class PostController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('posts/Index', { posts })
  }
}
```

- `this.ctx`: Hono のコンテキスト全体。
- `this.request`: 内部の Request へのショートカット。
- `this.inertia(component, props, options)`: Inertia レスポンスを生成。

## モデルと ORM
モデルは `Model<TRecord>` を継承し、`static table` で Drizzle スキーマに接続します。レイヤーは薄く、簡単な CRUD はヘルパーで、高度なクエリは Drizzle RQB に直接落とせます。

```ts
export type PostRecord = typeof posts.$inferSelect

export class Post extends Model<PostRecord> {
  static override table = posts
  static override readonly recordType = {} as PostRecord
}
```

- `Model.all()`, `Model.find(id)`, `Model.findOrFail()`, `Model.first()`, `Model.create(data)` など Laravel 風のヘルパーを提供。
- `recordType` により静的ヘルパーが型安全になります（例: `Post.find()` が `PostRecord | null` を返す）。
- `DatabaseProvider`（内部で `bootModels()` を呼び、`DrizzleAdapter.configure(db)` を実行）などのプロバイダーを使うと、全モデルでアダプターが使えるようになります。より細かい制御が必要なら `Model.query(db)` や Drizzle の DB インスタンスを直接利用します。

## Inertia.js とビュー
- React ページは `resources/js/pages/` 配下に置き、コンポーネント名で参照します。
- サーバーは `data-page` 属性を通して Inertia ペイロードを HTML に埋め込みます。
- クライアントは CDN ESM から React/Inertia を読み込み、初期ページをハイドレートします。

## アプリケーションのブート
生成済みプロジェクトの `src/main.ts` は以下の手順を示します:

1. ルートを副作用で読み込む（例: `import '@/routes/web'`）。
2. `const app = new Application({ providers: [DatabaseProvider, ...] })` のように生成し、サービスを早期登録。
3. `await app.boot()` でルートをマウントし、プロバイダーのブートフックを実行し、ミドルウェアを準備。
4. `await app.listen()`（または Bun では `app.listen()`）で HTTP サーバーを開始。

この流れは Bun のネイティブモジュールで動作し、`bun run dev` で起動されます。

## データベーススキーマ
- Drizzle のスキーマ定義は `db/schema.ts` に配置。
- `config/database.ts` がコンテナ起動時にテーブルを用意します。
- マイグレーションランナーは設計中で、将来的に Drizzle SQL マイグレーションを統合する予定です。

## リクエストライフサイクル
1. Hono が HTTP リクエストを受信。
2. `Route` レジストリがマッチするハンドラを解決。
3. コントローラが実行され、モデル経由で DB にアクセス。
4. `this.inertia()` がビューへデータを渡し、Inertia レスポンスを組み立て。
5. クライアントは初回に React をハイドレートし、以降の遷移は Inertia の SPA トランジションで行われます。

## ロードマップ（ハイライト）
- テンプレート生成用 CLI（`bunx guren create <name>`）
- 統合マイグレーションランナー
- 認証スキャフォールドとポリシーサポート
- Vite による高度なフロントエンドビルドオプション

内部の詳細をさらに知りたい場合は、[CLI リファレンス](./cli.md) や生成プロジェクト内のインラインドキュメントも参照してください。
