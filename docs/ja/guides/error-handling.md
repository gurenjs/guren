# エラーハンドリング

Guren はグローバルエラーハンドラーからコントローラーレベルの例外キャッチまで、複数層のエラーハンドリングを提供しています。Hono の堅牢なエラーハンドリングプリミティブをベースに、ユーザーへのエラー表示をカスタマイズできます。

## グローバルエラーハンドラー

Hono の `onError` メソッドを使用してグローバルエラーハンドラーを登録：

> 登録は `src/app.ts` で `createApp(...)` の直後、または `boot(hono)` コールバック内で行います。`app.boot()` の前に設定してください。

```ts
import { createApp } from '@guren/core'
import { HTTPException } from 'hono/http-exception'

const app = createApp()

app.hono.onError((error, ctx) => {
  console.error('未処理のエラー:', error)

  // HTTP 例外を処理
  if (error instanceof HTTPException) {
    return ctx.json({
      error: error.message,
      status: error.status,
    }, error.status)
  }

  // その他のエラーを処理
  const isDev = process.env.NODE_ENV !== 'production'

  return ctx.json({
    error: isDev ? error.message : 'Internal Server Error',
    ...(isDev && { stack: error.stack }),
  }, 500)
})
```

## HTTP 例外

`HTTPException` をスローして特定の HTTP ステータスコードを返す：

```ts
import { HTTPException } from 'hono/http-exception'
import { Router } from '@guren/core'

const router = new Router()

router.get('/posts/:id', async (ctx) => {
  const post = await Post.find(ctx.req.param('id'))

  if (!post) {
    throw new HTTPException(404, { message: '投稿が見つかりません' })
  }

  return ctx.json({ post })
})
```

よく使う HTTP 例外：

```ts
// 400 Bad Request
throw new HTTPException(400, { message: '無効なリクエストデータ' })

// 401 Unauthorized
throw new HTTPException(401, { message: '認証が必要です' })

// 403 Forbidden
throw new HTTPException(403, { message: 'アクセスが拒否されました' })

// 404 Not Found
throw new HTTPException(404, { message: 'リソースが見つかりません' })

// 422 Unprocessable Entity
throw new HTTPException(422, { message: 'バリデーションに失敗しました' })

// 429 Too Many Requests
throw new HTTPException(429, { message: 'レート制限を超えました' })

// 500 Internal Server Error
throw new HTTPException(500, { message: 'サーバーエラー' })
```

## Not Found ハンドラー

404 レスポンスをカスタマイズ：

```ts
app.hono.notFound((ctx) => {
  // API リクエストには JSON を返す
  if (ctx.req.header('Accept')?.includes('application/json')) {
    return ctx.json({ error: '見つかりません' }, 404)
  }

  // ブラウザリクエストには HTML を返す
  return ctx.html('<h1>ページが見つかりません</h1>', 404)
})
```

## コントローラーでのエラーハンドリング

`validateBody`/`validateQuery`/`validateParams`、`findOrFail`、`userOrFail` を使えば、ほとんどのエラーハンドリングは自動です — try-catch は不要です：

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'
import { PostResource } from '@/app/Http/Resources/PostResource'
import { appPages } from '@/resources/js/pages/contracts'

const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PostIdSchema = z.object({ id: z.coerce.number().int().positive() })

export default class PostController extends Controller {
  async store(): Promise<Response> {
    const data = await this.validateBody(StorePostSchema)  // 失敗時 422
    const user = await this.auth.userOrFail()              // 未認証時 401
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdSchema)       // 不正パラメータ時 422
    const post = await Post.findOrFail(id)                  // 見つからない場合 404
    return this.inertia(appPages.posts.show, { post: new PostResource(post).toJSON() })
  }
}
```

`ExceptionHandler` がスローされた例外をすべてキャッチし自動でレンダリングします。try-catch は特定のコントローラーメソッド内でカスタムエラーリカバリが必要な場合のみ使用してください。

## バリデーションエラー

`formatValidationErrors` を使用して Zod エラーをフラットなオブジェクトに変換：

```ts
import { formatValidationErrors } from '@guren/core'
import { z } from 'zod'

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
})

const result = schema.safeParse(data)

if (!result.success) {
  const errors = formatValidationErrors(result.error)
  // { email: 'メールアドレスの形式が不正です', password: '8文字以上必要です' }
}
```

フォールバックメッセージ付き：

```ts
const errors = formatValidationErrors(result.error, '入力内容を確認してください')
```

## エラーミドルウェア

再利用可能なエラーハンドリングミドルウェアを作成：

```ts
import { defineMiddleware } from '@guren/core'
import { HTTPException } from 'hono/http-exception'

export const errorHandler = defineMiddleware(async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error // HTTP 例外はグローバルハンドラーに任せる
    }

    // 予期しないエラーをログ出力
    console.error('予期しないエラー:', error)

    // 汎用エラーレスポンスを返す
    return ctx.json({
      error: '問題が発生しました',
    }, 500)
  }
})

// グローバルに登録
app.use('*', errorHandler)
```

## Inertia エラーページ

Inertia アプリケーションではエラーコンポーネントをレンダリング：

```ts
// Inertia 用グローバルエラーハンドラー
app.hono.onError(async (error, ctx) => {
  const isInertia = ctx.req.header('X-Inertia') === 'true'

  if (isInertia) {
    const status = error instanceof HTTPException ? error.status : 500

    // Inertia エラーページを返す
    return ctx.json({
      component: 'Error',
      props: {
        status,
        message: error.message,
      },
      url: ctx.req.path,
    }, status)
  }

  // 非 Inertia のエラーハンドリング
  return ctx.json({ error: error.message }, 500)
})
```

React エラーコンポーネント：

```tsx
// resources/pages/Error.tsx
export default function Error({ status, message }: { status: number; message: string }) {
  const titles: Record<number, string> = {
    404: 'ページが見つかりません',
    403: 'アクセス禁止',
    500: 'サーバーエラー',
    503: 'サービス利用不可',
  }

  return (
    <div className="error-page">
      <h1>{status}</h1>
      <h2>{titles[status] ?? 'エラー'}</h2>
      <p>{message}</p>
      <a href="/">ホームに戻る</a>
    </div>
  )
}
```

## データベースエラー

`Model.findOrFail()` を使えば、手動の null チェックは不要です。見つからない場合は `ModelNotFoundException`（404）が自動的にスローされます：

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'
import { appPages } from '@/resources/js/pages/contracts'

// Before — 手動 null チェック
async show(): Promise<Response> {
  const post = await Post.find(Number(this.request.param('id')))
  if (!post) {
    throw new HTTPException(404, { message: '投稿が見つかりません' })
  }
  return this.inertia(appPages.posts.show, { post: new PostResource(post).toJSON() })
}

// After — 自動 404
async show(): Promise<Response> {
  const { id } = this.validateParams(PostIdSchema)
  const post = await Post.findOrFail(id)  // ModelNotFoundException（404）をスロー
  return this.inertia(appPages.posts.show, { post: new PostResource(post).toJSON() })
}
```

## 組み込み例外クラス

Guren は一般的な HTTP エラーシナリオ用の型付き例外クラスを提供しています：

```ts
import {
  HttpException,
  NotFoundHttpException,
  AuthenticationException,
  AuthorizationException,
  ValidationException,
  MethodNotAllowedException,
} from '@guren/core'
import { ModelNotFoundException } from '@guren/orm'

// 404 Not Found
throw new NotFoundHttpException('投稿が見つかりません')

// 404 Not Found（Model.findOrFail() が自動的にスロー）
throw new ModelNotFoundException('Post', 42)

// 401 Unauthorized（auth.userOrFail() が自動的にスロー）
throw new AuthenticationException('認証が必要です')

// 422 Unprocessable Entity（validateBody/Query/Params が自動的にスロー）
throw new ValidationException({ title: ['タイトルは必須です'] })

// 403 Forbidden
throw new AuthorizationException('この投稿を編集する権限がありません')
```

### Duck-typed `statusCode`

`ExceptionHandler` は `HttpException` のサブクラスだけでなく、数値の `statusCode` プロパティを持つ任意のエラーに対応します。これにより `ModelNotFoundException`（`@guren/orm` から、`statusCode: 404` を持つ）は追加設定なしで自動的に 404 レスポンスとしてレンダリングされます。`statusCode >= 500` のエラーは本番環境でメッセージが隠されます（"Internal Server Error" に置換）。

## 非同期エラーバウンダリ

非同期操作をエラーバウンダリでラップ：

```ts
async function withErrorBoundary<T>(
  operation: () => Promise<T>,
  fallback: T,
  onError?: (error: unknown) => void
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    onError?.(error)
    return fallback
  }
}

// 使用例
const posts = await withErrorBoundary(
  () => Post.all(),
  [],
  (error) => console.error('投稿の取得に失敗しました:', error)
)
```

## 開発環境 vs 本番環境

環境に応じてエラー出力をカスタマイズ：

```ts
app.hono.onError((error, ctx) => {
  const isDev = process.env.NODE_ENV !== 'production'

  if (isDev) {
    // 開発環境では完全なエラーを表示
    return ctx.json({
      error: error.message,
      stack: error.stack,
      name: error.name,
    }, 500)
  }

  // 本番環境では詳細を隠す
  return ctx.json({
    error: '予期しないエラーが発生しました',
    requestId: ctx.get('requestId'), // リクエスト ID ミドルウェアを使用している場合
  }, 500)
})
```

### デバッグページ

開発環境では、Guren はスタックトレースやリクエスト情報を含む詳細なデバッグページを自動的に表示します。`createApp()` の `debug` オプションで制御できます:

```ts
import { createApp } from '@guren/core'

const app = createApp({
  debug: process.env.NODE_ENV !== 'production',
})
```

デバッグページには以下の情報が含まれます:
- エラーメッセージとスタックトレース
- リクエスト情報（メソッド、パス、ヘッダー）
- 登録済みのミドルウェアとルート
- 環境変数（機密情報は自動でマスク）

本番環境では `debug: false`（デフォルト）を設定し、内部情報の漏洩を防いでください。

## ベストプラクティス

1. **非同期エラーは必ずキャッチする** - 未処理の Promise rejection はサーバーをクラッシュさせる可能性がある
2. **コンテキスト付きでログを記録** - リクエスト ID、ユーザー ID、関連データを含める
3. **適切なステータスコードを使用** - クライアントエラーは 4xx、サーバーエラーは 5xx
4. **機密データを公開しない** - 本番環境ではスタックトレースや内部詳細を隠す
5. **ユーザーフレンドリーなメッセージを提供** - 技術的なエラーは分かりやすいメッセージに変換
6. **エラーを監視** - 本番環境ではエラー追跡サービスを使用
