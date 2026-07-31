# CSRF 保護

CSRF（Cross-Site Request Forgery）保護は、悪意のあるウェブサイトが認証済みユーザーの代わりにフォームを送信することを防ぎます。Guren はセッションとシームレスに統合する組み込みの CSRF ミドルウェアを提供しています。

## セットアップ

アプリケーションにミドルウェアを追加して CSRF 保護を有効にします。

```ts
// src/app.ts
import { createApp, createSessionMiddleware, createCsrfMiddleware } from '@guren/core'

const app = createApp()

// 任意 — トークンは永続化済みのセッションに紐づきます
app.use('*', createSessionMiddleware())
app.use('*', createCsrfMiddleware())
```

ミドルウェアは自動的に以下を行います。
- セッションごとにトークンを生成（ゲストにはステートレスな double-submit トークン）
- 状態を変更するリクエスト（POST、PUT、PATCH、DELETE）でトークンを検証
- 安全なメソッド（GET、HEAD、OPTIONS）は検証なしで許可

## フォームにトークンを含める

ネイティブの `<form method="post">` はトークンを `_token` フィールドとして含める必要が
あります。含めないと Guren が 403 で拒否します。Inertia アプリなら `useForm()` と
`<Link method="post">` が自動で送信します（[Inertia.js との統合](#inertiajs-との統合)を参照）。

`csrfField()` ヘルパーを使用して hidden input フィールドを生成します。

```ts
// コントローラー内
import { Controller, getCsrfToken, csrfField } from '@guren/core'
import { pages } from '@/.guren/pages.gen'

export default class FormController extends Controller {
  create() {
    const token = getCsrfToken(this.ctx)
    // テンプレート/ビューに渡す
    return this.inertia(pages.forms.Create, { csrfToken: token })
  }
}
```

フロントエンドのフォーム（React の例）です。

```tsx
function CreateForm({ csrfToken }: { csrfToken: string }) {
  return (
    <form method="POST" action="/posts">
      <input type="hidden" name="_token" value={csrfToken} />
      {/* フォームフィールド */}
      <button type="submit">作成</button>
    </form>
  )
}
```

または hidden フィールドを直接生成することもできます。

```ts
const hiddenField = csrfField(ctx)
// 出力: <input type="hidden" name="_token" value="..." />
```

## AJAX リクエスト

JavaScript/AJAX リクエストの場合、ヘッダーにトークンを含めます。

```ts
// ミドルウェアが JavaScript から読める XSRF-TOKEN Cookie を設定します
const csrfToken = decodeURIComponent(
  document.cookie.match(/(?:^|;\s*)XSRF-TOKEN=([^;]*)/)?.[1] ?? '',
)

fetch('/api/posts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-XSRF-TOKEN': csrfToken,
  },
  body: JSON.stringify({ title: 'Hello' }),
})
```

Axios（つまり Inertia.js）はこれを自動で行うため、上記のコードが必要なのは素の
`fetch` を使う場合だけです。

ミドルウェアは次の 3 か所からこの順にトークンを受け取ります。

1. `X-CSRF-TOKEN` ヘッダー
2. `XSRF-TOKEN` Cookie から読み取られた `X-XSRF-TOKEN` ヘッダー
3. urlencoded・multipart・JSON いずれかのリクエストボディの `_token` フィールド

これらの名前は変更できません。Cookie を無効化する場合（後述の `cookie: false`）は、
`getCsrfToken(ctx)` でトークンをページへ渡し、`X-CSRF-TOKEN` ヘッダーで送信してください。
ただしこれはセッション認証済みのフローに限ります。ゲストのトークンは Cookie と照合して
検証されるため、Cookie なしでは成立しません。

## 設定オプション

```ts
createCsrfMiddleware({
  // CSRF 検証から除外するルート
  exclude: ['/api/webhooks/*', '/api/public/*'],

  // カスタムエラーハンドラー
  onError: (ctx) => {
    return ctx.json({ error: '無効な CSRF トークン' }, 403)
  },
})
```

残りのオプションは通常変更する必要がありません。

| オプション | デフォルト | 用途 |
|--------|---------|------|
| `methods` | `['POST', 'PUT', 'PATCH', 'DELETE']` | トークンを要求する HTTP メソッド |
| `cookie` | `true` | 安全なリクエストと成功した更新系リクエストで `XSRF-TOKEN` Cookie を発行する |
| `cookieOptions` | `{ path: '/', sameSite: 'Lax' }` | Cookie 属性。`secure` は `NODE_ENV` が `production` のとき、および `process` が無いランタイムで有効 |

## ルートの除外

一部のルート（Webhook エンドポイントなど）は CSRF 検証をスキップする必要があります。

```ts
createCsrfMiddleware({
  exclude: [
    '/api/webhooks/stripe',
    '/api/webhooks/github',
    '/api/public/*', // ワイルドカードパターン対応
  ],
})
```

## 手動トークン検証

カスタム検証ロジックには `verifyCsrfToken()` を使用します。

```ts
import { verifyCsrfToken, getCsrfToken } from '@guren/core'
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.post('/custom', async (ctx) => {
    const token = ctx.req.header('X-Custom-Token')

    if (!verifyCsrfToken(ctx, token)) {
      return ctx.json({ error: '無効なトークン' }, 403)
    }

    return ctx.json({ ok: true })
  })
}
```

## トークンの再生成

セッションに紐づくトークンはセッション ID に追随するため、以下の場合に変わります。
- セッションが最初に永続化されたとき（作成直後のセッションはまだトークンの拠り所になりません）
- `session.regenerate()` が呼び出されたとき（ログイン後に推奨）

ゲストのトークンはセッション ID を持たず、セッションが生まれるまで再利用されます。

```ts
// ログイン成功後
const session = getSessionFromContext(ctx)
await session.regenerate()
// 新しい CSRF トークンが自動的に生成される
```

## セキュリティベストプラクティス

1. **常に HTTPS を使用** - HTTP ではトークンが傍受される可能性あり
2. **ログイン後に再生成** - セッション固定攻撃を防止
3. **URL にトークンを公開しない** - POST ボディまたはヘッダーを使用
4. **セキュアな Cookie フラグを設定** - セッション Cookie はセッションミドルウェアが処理し、`XSRF-TOKEN` Cookie は `cookieOptions` に従います

## Inertia.js との統合

Inertia.js を使用する場合、CSRF は Cookie を通じて自動的に処理されます。Axios/fetch の設定に credentials を含めてください。

```ts
// resources/js/app.tsx
axios.defaults.withCredentials = true
```

Inertia は自動的に `XSRF-TOKEN` Cookie を読み取り、リクエストに含めます。

### ネイティブフォームではなく Inertia 経由で送信する

対象となるのは、Inertia が Axios 経由で送るリクエストだけです。ネイティブの
`<form method="post">` は通常のブラウザ遷移として送信され、`X-XSRF-TOKEN` ヘッダーが
付きません。そのため、フォーム自身が `_token` hidden フィールドを持っていない限り
Guren は 403 で拒否します。

Inertia のページでは `useForm()` を使ってください。

```tsx
import { useForm } from '@inertiajs/react'

function LogoutButton() {
  const { post, processing } = useForm()

  return (
    <button type="button" onClick={() => post('/logout')} disabled={processing}>
      ログアウト
    </button>
  )
}
```

単純なアクションリンクなら `<Link href="/logout" method="post" as="button">` でも構い
ません。ネイティブフォームは、意図的にフルページ遷移をさせたい場合にだけ使ってください。
