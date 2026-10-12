# エラーハンドリング

リクエストの中で投げられた例外は、どこで投げられても `ExceptionHandler` に届き、報告するかどうかとクライアントに何を返すかがそこで決まります。カスタマイズはサービスプロバイダーから行い、その場で立て直したいエラーだけをコントローラーの `try`/`catch` で扱います。返す内容は、開発環境と本番環境で変わります。

## ExceptionHandler

リクエストの中で投げられた例外を報告するかどうかと、クライアントに何を返すかは、`ExceptionHandler` が決めます。アプリは起動時にこれを 1 つ作り、Hono の `onError` に登録します。カスタマイズはサービスプロバイダーの `boot()` で行い、コンテナからそのインスタンスを受け取ります。

```ts
// app/Providers/ExceptionServiceProvider.ts
import { ServiceProvider } from '@guren/core'
import type { ExceptionHandler } from '@guren/core'

class PaymentDeclinedError extends Error {
  constructor(readonly reason: string) {
    super('Payment declined')
  }
}

export class ExceptionServiceProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const handler = this.container.make<ExceptionHandler>('exception.handler')

    // エラー追跡サービスに送らない、想定内の失敗
    handler.dontReport(PaymentDeclinedError)

    // それ以外のすべての例外で実行される
    handler.report((error) => {
      console.error('[report]', error)
    })

    // 特定の例外クラスにだけ独自のレスポンスを返し、それ以外は既定の描画のまま
    handler.render(PaymentDeclinedError, (error, ctx) =>
      ctx.json({ message: error.message, reason: error.reason }, 402),
    )
  }
}
```

このプロバイダーは `createApp({ providers: [ExceptionServiceProvider] })` で登録します。

| メソッド | 役割 |
|---|---|
| `report(callback)` | レポーターを追加します。`dontReport()` で除外していない例外ごとに、すべてのレポーターが実行されます。例外を投げたレポーターはログに記録され、ほかのレポーターはそのまま実行されます |
| `dontReport(ErrorClass)` | そのクラスの例外ではレポーターを実行しません |
| `render(ErrorClass, renderer)` | そのクラスの例外に独自のレスポンスを返します。登録した順に試し、最初に一致したものを使います |

例外クラスとの一致は、`instanceof` かクラス名で判定します。そのため、同じパッケージが重複してインストールされていても一致します。レポーターを 1 つも登録していなければ、5xx の例外はコンソールに出力されるので、本番の失敗が記録されずに終わることはありません。

## Hono の `onError` を置き換える

Hono の `onError` には、アプリの起動中に `ExceptionHandler` が登録されます。この登録は `boot(hono)` コールバックのあとに行われます。そのため、`app.boot()` より前に `app.hono.onError()` で設定したハンドラーは置き換えられてしまうので、カスタマイズは上の `ExceptionHandler` で行ってください。

`onError` を完全に自分で扱いたい場合は、`ErrorServiceProvider` のサブクラスを登録します。アプリは組み込みのプロバイダーの代わりに、そのサブクラスを使います。

```ts
// app/Providers/AppErrorServiceProvider.ts
import { ErrorServiceProvider } from '@guren/core'
import type { Hono } from 'hono'

export class AppErrorServiceProvider extends ErrorServiceProvider {
  boot(): void {
    const hono = this.container.make<Hono>('hono')
    hono.onError((error, ctx) => {
      const isDev = process.env.NODE_ENV !== 'production'
      return ctx.json({ error: isDev ? error.message : 'Internal Server Error' }, 500)
    })
  }
}
```

この方法では、`HttpException` や `ModelNotFoundException` のステータスを含め、`ExceptionHandler` の処理がすべて使われなくなります。必要がなければ `render()` を使ってください。

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
    const post = await Post.create(data, { set: { authorId: user.id } })
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

ミドルウェアでは、後ろのハンドラーが投げた `Error` を捕まえられません。Hono は例外が投げられたその場で `onError`(つまり ExceptionHandler)に渡すので、`next()` を `try { await next() } catch` で囲んでも、その `catch` には届きません。共通のエラー処理はレポーターやレンダラーに書き([ExceptionHandler](#exceptionhandler) を参照)、`try`/`catch` は[コントローラーでのエラーハンドリング](#コントローラーでのエラーハンドリング)のように、直接呼び出すコードに使ってください。

## Inertia エラーページ

Inertia のアプリでは、存在しないレコードへのページ遷移で JSON ではなくエラーページのコンポーネントを表示したいところです。プロバイダーで 2 つの not found 例外にレンダラーを登録し、ブラウザ以外の呼び出し元には JSON を返します。

```ts
// app/Providers/ErrorPageServiceProvider.ts
import { ModelNotFoundException, NotFoundHttpException, ServiceProvider, inertia } from '@guren/core'
import type { ExceptionHandler } from '@guren/core'

export class ErrorPageServiceProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const handler = this.container.make<ExceptionHandler>('exception.handler')

    for (const errorClass of [NotFoundHttpException, ModelNotFoundException]) {
      handler.render<Error>(errorClass, (error, ctx) => {
        const wantsPage = ctx.req.header('X-Inertia') === 'true'
          || (ctx.req.header('accept') ?? '').includes('text/html')
        if (!wantsPage) return ctx.json({ message: error.message }, 404)

        return inertia('Error', { status: 404, message: error.message }, {
          status: 404,
          request: ctx.req.raw,
          container: this.container,
        })
      })
    }
  }
}
```

レンダラーは、特定のクラスに絞って登録してください。`ValidationException`、`AuthenticationException`、`AuthorizationException` はどれも `HttpException` のサブクラスなので、`HttpException` にレンダラーを登録すると、バリデーションのリダイレクトを含め、検証・認証・認可の失敗への応答まで置き換わってしまいます。

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

ExceptionHandler は、環境に応じてすでに返すものを変えているので、たいていのアプリでは何も書く必要はありません。

| | 開発環境(`debug` が有効) | 本番環境 |
|---|---|---|
| 5xx のメッセージ | 例外のメッセージそのまま | `Internal Server Error`(`HttpException` は自分のメッセージのまま) |
| 例外の名前とスタックトレース | JSON の本文に含める | 含めない |
| ブラウザへの 5xx | デバッグページ | 汎用のエラーページ |

`debug` は `NODE_ENV` で決まります。別の基準で決めたいときは、[デバッグ情報](#デバッグ情報)を参照してください。特定のクラスの例外への応答を変えたいときは、レンダラーを登録してください([ExceptionHandler](#exceptionhandler) を参照)。

### デバッグ情報

`NODE_ENV` が `production` でない間、ExceptionHandler はエラーの詳細を返します。

- ブラウザからのリクエストが 5xx で終わると、デバッグページを表示します。例外の名前とメッセージ、スタックトレース、リクエストのメソッド・URL・ヘッダー、`NODE_ENV`・Bun のバージョン・プラットフォームが載ります。ここでのブラウザからのリクエストは、`text/html` を受け付け、Inertia の遷移でも XHR でもないものを指します。
- Inertia の遷移、XHR、JSON を求めるリクエストには、例外の名前とスタックトレースを加えた JSON の本文を返します。
- ブラウザからのリクエストが 4xx で終わったときは、本番環境と同じく、メッセージ入りの通常のエラーページを返します。4xx は呼び出し側の誤りなので、スタックトレースを見ても役に立ちません。

本番環境ではこれらの詳細を省き、`HttpException` 以外の 5xx のメッセージを `Internal Server Error` に置き換え、ブラウザには汎用のエラーページを返します。`HttpException` は本番環境でも自分のメッセージをそのまま返すので、内部の詳細を入れないでください。

詳細を出すかどうかを別の基準で決めたいときは、プロバイダーの `register()` で自分のハンドラーを `exception.handler` に登録します。フレームワークは自分のレンダラーを `boot()` で追加するので、それらも登録したハンドラーに付きます。

```ts
// app/Providers/ExceptionServiceProvider.ts
import { ServiceProvider, createExceptionHandler } from '@guren/core'

export class ExceptionServiceProvider extends ServiceProvider {
  register(): void {
    this.container.instance('exception.handler', createExceptionHandler({
      // NODE_ENV がちょうど 'development' のときだけ詳細を出す
      isDebug: () => process.env.NODE_ENV === 'development',
    }))
  }

  // boot() は上の ExceptionHandler の節と同じ
}
```

`createApp()` には `debug` オプションはなく、判定はこの登録で決まります。

デバッグページには Cookie や `Authorization` を含むリクエストヘッダーがそのまま載ります。他の人がアクセスできるサーバーでは、詳細を出さない設定にしてください。

`debugErrorMiddleware()` は非推奨になり、3.0.0 で削除されます。このミドルウェアの `catch` にはエラーが届かず([エラーミドルウェア](#エラーミドルウェア)を参照)、同じページを ExceptionHandler が表示するようになったので、ミドルウェアから外してください。`bunx guren upgrade --check-only` を実行すると、これを import しているファイルが一覧で出ます。

## ベストプラクティス

1. **非同期エラーは必ずキャッチする。** 処理されない Promise の rejection は、サーバーを落とすことがあります。
2. **ログには文脈を添える。** リクエスト ID、ユーザー ID、関係するデータを一緒に記録します。
3. **ステータスコードを正しく使い分ける。** クライアント側のエラーは 4xx、サーバー側のエラーは 5xx です。
4. **機密データを見せない。** 本番環境では、スタックトレースや内部の詳細を隠します。
5. **わかりやすいメッセージを返す。** 技術的なエラーは、平易な言葉に言い換えます。
6. **エラーを監視する。** 本番環境では、エラー追跡サービスを使います。
