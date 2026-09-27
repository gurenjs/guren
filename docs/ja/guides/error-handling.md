# エラーハンドリング

Guren のエラー処理は、グローバルエラーハンドラーからコントローラー内での例外のキャッチまで、いくつかの層に分かれています。土台は Hono のエラー処理の仕組みで、ユーザーに見せるエラーは自由にカスタマイズできます。

## グローバルエラーハンドラー

グローバルエラーハンドラーは Hono の `onError` メソッドで登録します。

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

`HTTPException` を投げると、任意の HTTP ステータスコードでレスポンスを返せます。

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

よく使う HTTP 例外を並べておきます。

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

`notFound` を使うと、404 のレスポンスを差し替えられます。

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

`validateBody`/`validateQuery`/`validateParams`、`findOrFail`、`userOrFail` を使えば、エラー処理のほとんどはフレームワークに任せられるので、try-catch を書く必要はありません。

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'
import type { UserRecord } from '@/app/Models/User'

const StorePostSchema = z.object({ title: z.string().min(1), content: z.string().min(10) })
const PostIdSchema = z.object({ id: z.coerce.number().int().positive() })

export default class PostController extends Controller {
  async store(): Promise<Response> {
    const data = await this.validateBody(StorePostSchema)  // 失敗時 422
    const user = await this.auth.userOrFail<UserRecord>()  // 未認証時 401
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdSchema)       // 不正パラメータ時 422
    const post = await Post.findOrFail(id)                  // 見つからない場合 404
    return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
  }
}
```

投げられた例外はすべて `ExceptionHandler` が受け止め、レスポンスに変換します。try-catch は、コントローラーのメソッド内で独自の復旧処理が必要な場合にだけ書いてください。

## バリデーションエラー

`formatValidationErrors` を使うと、Zod のエラーをフラットなオブジェクトに変換できます。

```ts
import { formatValidationErrors } from '@guren/core'
import { z } from 'zod'

const schema = z.object({
  email: z.email(),
  password: z.string().min(8),
})

const result = schema.safeParse(data)

if (!result.success) {
  const errors = formatValidationErrors(result.error)
  // { email: 'メールアドレスの形式が不正です', password: '8文字以上必要です' }
}
```

第 2 引数には、フォールバックのメッセージを渡せます。

```ts
const errors = formatValidationErrors(result.error, '入力内容を確認してください')
```

## エラーミドルウェア

エラー処理をミドルウェアにしておけば、いろいろな場所で使い回せます。

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

Inertia のアプリでは、エラー用のコンポーネントを表示します。

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

エラー用の React コンポーネントは、たとえば次のように書きます。

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

`Model.findOrFail()` を使えば、null チェックを自分で書く必要はありません。レコードが見つからないと、`ModelNotFoundException`（404）が自動で投げられます。

```ts
import { PostResource } from '@/app/Http/Resources/PostResource'
import { pages } from '@/.guren/pages.gen'

// Before — 手動 null チェック
async show(): Promise<Response> {
  const post = await Post.find(Number(this.request.param('id')))
  if (!post) {
    throw new HTTPException(404, { message: '投稿が見つかりません' })
  }
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}

// After — 自動 404
async show(): Promise<Response> {
  const { id } = this.validateParams(PostIdSchema)
  const post = await Post.findOrFail(id)  // ModelNotFoundException（404）をスロー
  return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
}
```

## 組み込み例外クラス

よくある HTTP エラーには、型付きの例外クラスを用意しています。

```ts
import {
  HttpException,
  NotFoundHttpException,
  AuthenticationException,
  AuthorizationException,
  ValidationException,
  MethodNotAllowedException,
  ModelNotFoundException,
} from '@guren/core'

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

`ExceptionHandler` は、`HttpException` のサブクラスに限らず、数値の `statusCode` プロパティを持つエラーならどれでも処理できます。たとえば `@guren/core` が export している `ModelNotFoundException` は `statusCode: 404` を持っているので、設定を足さなくても 404 のレスポンスになります。`statusCode >= 500` のエラーは、本番環境ではメッセージを伏せて "Internal Server Error" に置き換えます。

## 非同期エラーバウンダリ

非同期の処理は、エラーバウンダリで包めます。

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

エラーの出し方は、環境によって変えます。

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

開発環境では、スタックトレースやリクエスト情報を載せた詳しいデバッグページが自動で表示されます。表示するかどうかは、`createApp()` の `debug` オプションで切り替えます。

```ts
import { createApp } from '@guren/core'

const app = createApp({
  debug: process.env.NODE_ENV !== 'production',
})
```

デバッグページには次の情報が載ります。
- エラーメッセージとスタックトレース
- リクエスト情報（メソッド、パス、ヘッダー）
- 登録済みのミドルウェアとルート
- 環境変数（機密情報は自動でマスク）

本番環境では `debug: false`（デフォルト）にして、内部の情報が外に漏れないようにしてください。

## ベストプラクティス

1. **非同期エラーは必ずキャッチする。** 処理されない Promise の rejection は、サーバーを落とすことがあります。
2. **ログには文脈を添える。** リクエスト ID、ユーザー ID、関係するデータを一緒に記録します。
3. **ステータスコードを正しく使い分ける。** クライアント側のエラーは 4xx、サーバー側のエラーは 5xx です。
4. **機密データを見せない。** 本番環境では、スタックトレースや内部の詳細を隠します。
5. **わかりやすいメッセージを返す。** 技術的なエラーは、平易な言葉に言い換えます。
6. **エラーを監視する。** 本番環境では、エラー追跡サービスを使います。
