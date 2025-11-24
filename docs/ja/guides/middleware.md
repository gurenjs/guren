# ミドルウェアガイド

Guren のルートとアプリケーションは Hono のミドルウェアモデルを共有しつつ、よく使うケースで Laravel 風の書き心地を提供します。`Application` インスタンスにグローバル登録する方法と、ルート DSL で個別に付与する方法があります。

## グローバルミドルウェア

```ts
// src/app.ts
import { Application, defineMiddleware } from '@guren/core'

const requestTimer = defineMiddleware(async (ctx, next) => {
  const started = performance.now()
  await next()
  const duration = Math.round(performance.now() - started)
  console.log(`${ctx.req.method} ${ctx.req.path} -> ${ctx.res.status} (${duration}ms)`)
})

const app = new Application()
app.use('*', requestTimer)
```

グローバルミドルウェアはルートがマウントされる前に実行されます。プロバイダーは `register()` フック内で `context.app.use()` を使ってミドルウェアを登録できます。

## ルートミドルウェア

```ts
import { Route } from '@guren/core'
import DashboardController from '@/app/Http/Controllers/DashboardController'
import { requireAuthenticated } from '@/app/Http/middleware/auth'

Route.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
```

ルートミドルウェアは対象のエンドポイント（またはグループ内の全エンドポイント）だけに適用されます。

## ビルトインヘルパー

### `defineMiddleware`
Hono ミドルウェアを Guren の型期待値で注釈するユーティリティ。

### `createSessionMiddleware`
セッションオブジェクトをリクエストコンテキストへ付与するファクトリ。既定ではメモリストア（`MemorySessionStore`）を使い、署名付きクッキーで永続化します。

```ts
import { createSessionMiddleware } from '@guren/core'

app.use('*', createSessionMiddleware())
```

各リクエストは `ctx.get('guren:session')` または `getSessionFromContext(ctx)` でセッションにアクセスできます。

### 認証ガード

`requireAuthenticated` と `requireGuest` は、事前に認証コンテキストがパイプラインへアタッチされていることを前提とした薄いラッパーです。`attachAuthContext` と組み合わせてガード実装を保存します。

```ts
import { attachAuthContext, requireAuthenticated } from '@guren/core'

app.use('*', attachAuthContext(() => authManager.createGuard('web')))
Route.get('/settings', [SettingsController, 'index'], requireAuthenticated({ redirectTo: '/login' }))
```

認証モジュールは今後強化されますが、現状でもこの契約を使ってカスタムガードを配線できます。
