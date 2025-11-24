# ルーティングガイド

Guren は Hono の HTTP サーバー上に Laravel 風のルーティング DSL を提供します。`routes/web.ts` をインポートすると起動時にルートが登録され、パス・HTTP メソッド・コントローラ・任意のミドルウェアを宣言的にまとめられます。

## 基本の使い方
`routes/web.ts` で `Route` とコントローラをインポートして定義します:

```ts
import { Route } from '@guren/server'
import PostsController from '@/app/Http/Controllers/PostsController'

Route.get('/', [PostsController, 'index'])
Route.post('/posts', [PostsController, 'store'])
```

各ルートはパスと以下のいずれかを受け取ります:
- コントローラタプル `[ControllerClass, 'method']`
- インラインハンドラ `(ctx) => new Response('...')`

利用できるメソッドは `Route.get`, `Route.post`, `Route.put`, `Route.patch`, `Route.delete`, 汎用の `Route.on(method, path, handler)` です。

## ルートグループ
共通プレフィックスやミドルウェアをまとめるには `Route.group(prefix, callback)` を使います:

```ts
Route.group('/posts', () => {
  Route.get('/', [PostsController, 'index'])
  Route.get('/:id', [PostsController, 'show'])
})
```

グループはネスト可能です。`/posts` + `/new` は自動で `/posts/new` に連結されます。

## ミドルウェア
ハンドラの後ろに Hono のミドルウェアを渡します:

```ts
import { auth } from '@/app/Http/middleware/auth'

Route.post('/posts', [PostsController, 'store'], auth)
```

ミドルウェアは指定した順に実行されます。同じグループ内でもルートごとに別のミドルウェアを付けられます。グローバル登録やビルトインのヒントは [Middleware Guide](./middleware.md) を参照してください。

## ルートパラメータ
動的セグメントは Hono の構文に従います:

```ts
Route.get('/posts/:id', [PostsController, 'show'])
```

コントローラでは `this.ctx.req.param('id')` で参照します。任意パラメータは `Route.get('/posts/:id?', handler)` のように `?`、ワイルドカードは `*`（例: `/:slug*`）を使います。

## ブート手順
`src/main.ts` でルートファイルをインポートし、アプリ起動前に登録します:

```ts
// src/main.ts
import '@/routes/web'

const app = new Application()
await app.boot()
await app.listen()
```

`routes/web.ts` は副作用だけを持ち、エクスポートは不要です。

## カスタムハンドラ
インラインハンドラを使えばコントローラを経由せず Hono `Context` を直接扱えます:

```ts
Route.get('/health', (ctx) => ctx.json({ ok: true }))
```

ヘルスチェックや Webhook のような軽量エンドポイントに便利です。

## Tips
- `routes/web.ts` は HTTP 定義に集中させ、ビジネスロジックはコントローラやサービスへ移してください。
- 大規模になったら `routes/admin.ts` などに分割し、`src/main.ts` からまとめてインポートします。
- 可能な限り表現力のあるメソッド名（`index`, `show`, `store`, `update`, `destroy`）を使うと、フレームワーク全体のスタイルと揃います。

この DSL を使えば、エントリーポイントを宣言的で読みやすく保ったまま複雑な HTTP 構造を表現できます。
