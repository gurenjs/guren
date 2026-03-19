# エラーハンドリング

Guren はグローバルエラーハンドラーからコントローラーレベルの例外キャッチまで、複数層のエラーハンドリングを提供しています。Hono の堅牢なエラーハンドリングプリミティブをベースに、ユーザーへのエラー表示をカスタマイズできます。

## グローバルエラーハンドラー

Hono の `onError` メソッドを使用してグローバルエラーハンドラーを登録：

> 登録は `src/app.ts` で `new Application(...)` の直後、または `boot(hono)` コールバック内で行います。`app.boot()` の前に設定してください。

```ts
import { Application } from '@guren/server'
import { HTTPException } from 'hono/http-exception'

const app = new Application()

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

Route.get('/posts/:id', async (ctx) => {
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

try-catch を使用してコントローラー内でエラーを処理：

```ts
import { Controller, formatValidationErrors } from '@guren/server'

export default class PostController extends Controller {
  async store(): Promise<Response> {
    try {
      const payload = await parseRequestPayload(this.ctx)
      const result = PostSchema.safeParse(payload)

      if (!result.success) {
        return this.json({
          error: 'バリデーションに失敗しました',
          errors: formatValidationErrors(result.error),
        }, { status: 422 })
      }

      const post = await Post.create(result.data)
      return this.redirect(`/posts/${post.id}`)

    } catch (error) {
      console.error('投稿の作成に失敗しました:', error)

      // Inertia リクエストにはエラーページを返す
      return this.inertia('posts/New', {
        errors: { message: '予期しないエラーが発生しました。' },
      }, { status: 500 })
    }
  }
}
```

## バリデーションエラー

`formatValidationErrors` を使用して Zod エラーをフラットなオブジェクトに変換：

```ts
import { formatValidationErrors } from '@guren/server'
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
import { defineMiddleware } from '@guren/server'
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

データベース固有のエラーを処理：

```ts
import { HTTPException } from 'hono/http-exception'

async function findPostOrFail(id: number) {
  const post = await Post.find(id)

  if (!post) {
    throw new HTTPException(404, { message: '投稿が見つかりません' })
  }

  return post
}

// コントローラーでの使用
async show(): Promise<Response> {
  const post = await findPostOrFail(Number(this.request.param('id')))
  return this.inertia('posts/Show', { post })
}
```

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

## ベストプラクティス

1. **非同期エラーは必ずキャッチする** - 未処理の Promise rejection はサーバーをクラッシュさせる可能性がある
2. **コンテキスト付きでログを記録** - リクエスト ID、ユーザー ID、関連データを含める
3. **適切なステータスコードを使用** - クライアントエラーは 4xx、サーバーエラーは 5xx
4. **機密データを公開しない** - 本番環境ではスタックトレースや内部詳細を隠す
5. **ユーザーフレンドリーなメッセージを提供** - 技術的なエラーは分かりやすいメッセージに変換
6. **エラーを監視** - 本番環境ではエラー追跡サービスを使用
