# Bun でフルスタック

Bun にはランタイム、パッケージマネージャ、バンドラ、テストランナーが同梱され、開発サーバーは HTML ページと API ルートを並べて配信します。フルスタックフレームワークは同梱されておらず、公式ドキュメントもそう明記しています。このページは「Bun のフルスタックフレームワーク」を探している人向けです。Bun、Hono、Elysia がそれぞれ何を担うか、何が残るか、Guren がその残りをどう埋めるかを整理します。Guren は Bun で開発し、Node.js、Vercel、Cloudflare Workers にもデプロイします。

## Bun が担うもの

Bun のフルスタック開発サーバー(Bun 1.2.3 以降)は、HTML の import をルートの入口として受け取り、そこから参照されるスクリプトとスタイルをバンドルします。`Bun.serve()` は `routes` オブジェクトで API ルートに応答し、開発時はホットリロードが効きます。ランタイム側には、サーバーが初日から使う部品がそろっています。`Bun.serve()`、`bun:sqlite`、`Bun.password`、`Bun.file()`、`bun test`、`bun install` です。

同じドキュメントには、開発サーバーに含まれないものも書かれています。サーバーサイドレンダリングは組み込まれておらず、API ルートの自動検出もありません。機能自体も作業中と明記されています。プロジェクトの配置、リクエストからデータベースまでの経路、ユーザーのログイン方法は、Bun 側では決まりません。決めるのは利用者で、それらをつなぐコードも利用者が書きます。

## Hono と Elysia が担うもの

どちらも優れたフレームワークで、どちらも自らをバックエンド用と説明しています。

| | Hono | Elysia |
|---|---|---|
| 自己紹介 | Web 標準の上に作られた、あらゆる JavaScript ランタイム向けの Web フレームワーク | Bun でバックエンドサーバーを作るための、扱いやすい Web フレームワーク |
| 同梱 | ルーター、ミドルウェア、バリデータ、サーバー描画用の JSX | ルーター、スキーマ検証、Eden による end-to-end 型、OpenAPI 生成 |
| 利用者に任せる範囲 | ORM、マイグレーション、認証、セッション、ジョブ、メール、フロントエンド連携 | ORM、マイグレーション、認証、セッション、ジョブ、メール、フロントエンド連携 |

JSON エンドポイントが数本のサービスなら、ここで止まってどちらかを選んでください。Elysia の Eden はルートに対して型付けされた TypeScript クライアントを生成します。Hono は Bun、Node.js、Deno、Workers で同じコードが動きます。

## 残るもの

どちらのフレームワークの上でも、フルスタックのアプリケーションには同じ問いが残ります。答えの一つひとつが、選ぶ依存関係と、書いて、テストして、保守するつなぎのコードです。

- データベースアクセスとマイグレーション
- パスワード、セッション、OAuth、パスワードリセット、メールアドレス確認
- フィールドごとのエラーを持つ 422 応答に変換されるバリデーション
- 手書きの API 層なしで、サーバーから型付きデータを受け取るフロントエンド
- バックグラウンドジョブ、メール、キャッシュ、イベント
- アプリを起動して応答を検証するテストハーネス
- デプロイ先ごとの本番ビルド

## Guren が足すもの

Guren は Hono の上に載る Laravel 流の層です。すべてのリクエストが Hono のルーターを通るので、性能の階級は変わりません。上の一覧の各行には既定の答えがあります。

| 必要なもの | Guren アプリでは |
|---|---|
| HTTP | `router.get('/posts', [PostController, 'index'])`、コントローラ、ミドルウェアグループ |
| データベース | Drizzle ORM と Model API。`Post.where('published', true).get()`、`bun run db:migrate` |
| 認証 | `bunx guren add auth` が登録、ログイン、セッション、パスワード系のフローを生成。`bunx guren add oauth` でプロバイダを追加 |
| バリデーション | Zod スキーマを渡す `this.validateBody(schema)`。失敗は 422 応答になる |
| フロントエンド | React で書く Inertia.js のページ。ページの props はコントローラから codegen で型付け |
| ジョブ、メール、キャッシュ、イベント | 組み込みのサブシステム。プロバイダで有効化 |
| テスト | `@guren/testing` の `TestApp` を `bun test` で実行 |
| コーディングエージェント | `guren context`、`guren check`、`guren audit` が、プロジェクトの地図と作業の機械検証をエージェントに渡す |

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

`pages.posts.Index` の React ページは `Props` インターフェースを宣言し、codegen がコントローラの `this.inertia()` 呼び出しをそれと照合します。リクエストの経路全体は [First Steps](./first-steps.md) を参照してください。

## Guren アプリの中で Bun が使われる場所

`bunx create-guren-app my-app` が生成するプロジェクトのスクリプトは Bun で動きます。`bun run dev` は `bun --hot` でサーバーを起動し、`bun test` がテストを実行します。既定のデータベースは `bun:sqlite` 経由の SQLite で、PostgreSQL と MySQL も選べます。`createApp({ auth: { hasher: 'argon2' } })` を指定すると、`Bun.password` が Argon2id のハッシャーとして使われます。

Bun ファーストは Bun 専用という意味ではありません。既定のパスワードハッシャーは `node:crypto` の scrypt なので、同じコードが Node.js でも検証に通ります。デプロイプラグインの対象は、Node.js ランタイムの AWS Lambda、Bun ランタイムの Vercel、D1 を使う Cloudflare Workers です。それぞれの手順は[デプロイガイド](./deployment.md)にあります。

## 別の選択肢が合う場面

- データベースもユーザーもない小さな API サービス: 素の Hono か Elysia。Eden の型付きクライアントが欲しければ Elysia
- React の描画そのものが製品であるコンテンツサイトやストアフロント: Next.js
- Laravel や Rails を使っていて、移る理由のないチーム: そのまま

比較の詳細は [Why Guren](./why-guren.md) にあります。

## 次のステップ

- [Getting Started](./getting-started.md): アプリを生成して起動する
- [Guren チュートリアル](../tutorials/00-overview.md): ユーザー、認可、アップロード、メールを備えたブログを作る
- [デプロイ](./deployment.md): Bun サーバー、コンテナ、Lambda、Vercel、Workers
