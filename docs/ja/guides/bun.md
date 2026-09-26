# Bun でフルスタック

Bun にはランタイム、パッケージマネージャ、バンドラ、テストランナーが入っていて、開発サーバーで HTML ページと API ルートを一緒に配信できます。ただしフルスタックフレームワークは含まれておらず、Bun の公式ドキュメントにもそう書かれています。このページは「Bun のフルスタックフレームワーク」を探している人に向けて、Bun、Hono、Elysia がそれぞれどこまで受け持つのか、組み立てが必要な部分として何が残るのかを整理します。そのうえで、Guren がその残りをどう埋めるかを説明します。Guren のアプリは Bun で開発しながら、Node.js、Vercel、Cloudflare Workers にもデプロイできます。

## Bun が担うもの

Bun のフルスタック開発サーバー(Bun 1.2.3 以降)は、HTML の import をルートの入口として受け取り、そこから参照されるスクリプトとスタイルをバンドルします。`Bun.serve()` は `routes` オブジェクトで API ルートに応答し、開発時はホットリロードが効きます。ランタイム側には、サーバーが初日から使う部品がそろっています。`Bun.serve()`、`bun:sqlite`、`Bun.password`、`Bun.file()`、`bun test`、`bun install` です。

同じドキュメントには、開発サーバーに含まれないものも書かれています。サーバーサイドレンダリングは組み込まれておらず、API ルートの自動検出もありません。機能自体も作業中と明記されています。プロジェクトの配置、リクエストからデータベースまでの経路、ユーザーのログイン方法は、Bun 側では決まりません。決めるのは利用者で、それらをつなぐコードも利用者が書きます。

## Hono と Elysia が担うもの

どちらも優れたフレームワークですが、それぞれ自分をバックエンド向けのフレームワークだと説明しています。

| | Hono | Elysia |
|---|---|---|
| 公式の説明 | Web 標準の上に作られた、あらゆる JavaScript ランタイム向けの Web フレームワーク | Bun でバックエンドサーバーを作るための、扱いやすい Web フレームワーク |
| 含まれるもの | ルーター、ミドルウェア、バリデータ、サーバー描画用の JSX | ルーター、スキーマ検証、Eden による end-to-end 型、OpenAPI 生成 |
| 利用者が用意するもの | ORM、マイグレーション、認証、セッション、ジョブ、メール、フロントエンド連携 | ORM、マイグレーション、認証、セッション、ジョブ、メール、フロントエンド連携 |

作るものが JSON エンドポイント数本だけなら、このページはここまでで十分なので、どちらかを選んでください。Elysia なら、Eden がルートの定義から型付きの TypeScript クライアントを作ってくれます。Hono なら、同じコードが Bun、Node.js、Deno、Workers でそのまま動きます。

## 残るもの

どちらのフレームワークを使っても、フルスタックのアプリケーションを作るなら次の項目は自分で解決する必要があります。項目ごとに依存ライブラリを選び、それをつなぐコードを書いて、テストし、保守していくことになります。

- データベースアクセスとマイグレーション
- パスワード、セッション、OAuth、パスワードリセット、メールアドレス確認
- 失敗したらフィールドごとのエラー付きで 422 を返すバリデーション
- API 層を手書きしなくても、サーバーから型付きのデータを受け取れるフロントエンド
- バックグラウンドジョブ、メール、キャッシュ、イベント
- アプリを起動して応答を検証するテストハーネス
- デプロイ先ごとの本番ビルド

## Guren が足すもの

Guren は、Hono の上に Laravel のような構成を載せたフレームワークです。リクエストはすべて Hono のルーターを通るので、性能は Hono と同じ水準のままです。上に挙げた項目には、それぞれ最初から決まった答えが用意されています。

| 必要なもの | Guren アプリでは |
|---|---|
| HTTP | `router.get('/posts', [PostController, 'index'])`、コントローラ、ミドルウェアグループ |
| データベース | Drizzle ORM と Model API。`Post.where('published', true).get()`、`bun run db:migrate` |
| 認証 | `bunx guren add auth` で登録、ログイン、セッション、パスワード関連のフローを生成し、`bunx guren add oauth` でプロバイダを追加 |
| バリデーション | `this.validateBody(schema)` に Zod スキーマを渡す。検証に失敗すると 422 を返す |
| フロントエンド | React で書く Inertia.js のページ。props の型はコントローラから codegen で生成 |
| ジョブ、メール、キャッシュ、イベント | フレームワークに組み込み済みで、プロバイダを登録すると使える |
| テスト | `@guren/testing` の `TestApp` を使い、`bun test` で実行 |
| コーディングエージェント | `guren context` でプロジェクトの全体像を、`guren check` と `guren audit` で作業結果の機械的な検証をエージェントに渡す |

ルート、コントローラ、型付きページの例です。

```ts
// routes/web.ts
import { Router } from '@guren/core'
import PostController from '@/app/Http/Controllers/PostController'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index'])
  router.post('/posts', [PostController, 'store'])
}
```

```ts
// app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { Post } from '@/app/Models/Post'
import { CreatePostSchema } from '@/app/Http/Validators/PostValidator'
import { pages } from '@/.guren/pages.gen'

export default class PostController extends Controller {
  async index() {
    const posts = await Post.where('published', true).orderBy('createdAt', 'desc').get()
    return this.inertia(pages.posts.Index, { posts })
  }

  async store() {
    const data = await this.validateBody(CreatePostSchema)
    const post = await Post.create(data)
    return this.redirect(`/posts/${post?.id ?? ''}`)
  }
}
```

`pages.posts.Index` の React ページには `Props` インターフェースを宣言しておき、コントローラの `this.inertia()` 呼び出しがそれに合っているかを codegen が照合します。リクエストが通る経路の全体は [First Steps](./first-steps.md) で説明しています。

## Guren アプリの中で Bun が使われる場所

`bunx create-guren-app my-app` で作ったプロジェクトのスクリプトは Bun で動きます。`bun run dev` を実行すると `bun --hot` でサーバーが起動し、テストは `bun test` で実行します。既定のデータベースは `bun:sqlite` を使う SQLite で、PostgreSQL と MySQL も選べます。`createApp({ auth: { hasher: 'argon2' } })` を指定すれば、`Bun.password` を Argon2id のハッシャーとして使えます。

Bun ファーストといっても、Bun でしか動かないわけではありません。既定のパスワードハッシャーは `node:crypto` の scrypt なので、同じコードのまま Node.js でもパスワードを検証できます。デプロイプラグインは、Node.js ランタイムの AWS Lambda、Bun ランタイムの Vercel、D1 を使う Cloudflare Workers に対応しています。それぞれの手順は[デプロイガイド](./deployment.md)を参照してください。

## 別の選択肢が合う場面

- データベースもユーザー管理もない小さな API サービス: 素の Hono か Elysia。Eden の型付きクライアントが欲しいなら Elysia
- React での描画そのものが製品の価値になるコンテンツサイトやストアフロント: Next.js
- すでに Laravel や Rails を使っていて、移る理由がないチーム: 今のままで構いません

それぞれの比較は [Why Guren](./why-guren.md) でさらに詳しく扱っています。

## 次のステップ

- [Getting Started](./getting-started.md): アプリを生成して起動する
- [Guren チュートリアル](../tutorials/00-overview.md): ユーザー、認可、アップロード、メールを備えたブログを作る
- [デプロイ](./deployment.md): Bun サーバー、コンテナ、Lambda、Vercel、Workers
