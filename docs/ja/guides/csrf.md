# CSRF 保護

CSRF（Cross-Site Request Forgery）保護は、悪意のあるウェブサイトが認証済みユーザーの代わりにフォームを送信することを防ぎます。Guren はセッションとシームレスに統合する組み込みの CSRF ミドルウェアを提供しています。

## セットアップ

アプリケーションにミドルウェアを追加して CSRF 保護を有効にします。

```ts
// src/app.ts
import { createApp, createSessionMiddleware, createCsrfMiddleware } from '@guren/core'

const app = createApp()

// CSRF にはセッションミドルウェアが必要
app.use('*', createSessionMiddleware())
app.use('*', createCsrfMiddleware())
```

ミドルウェアは自動的に以下を行います。
- セッションごとに一意のトークンを生成
- 状態を変更するリクエスト（POST、PUT、PATCH、DELETE）でトークンを検証
- 安全なメソッド（GET、HEAD、OPTIONS）は検証なしで許可

## フォームにトークンを含める

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
      <input type="hidden" name="_csrf" value={csrfToken} />
      {/* フォームフィールド */}
      <button type="submit">作成</button>
    </form>
  )
}
```

または hidden フィールドを直接生成することもできます。

```ts
const hiddenField = csrfField(ctx)
// 出力: <input type="hidden" name="_csrf" value="..." />
```

## AJAX リクエスト

JavaScript/AJAX リクエストの場合、ヘッダーにトークンを含めます。

```ts
// meta タグまたは cookie からトークンを取得
const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content

fetch('/api/posts', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
  },
  body: JSON.stringify({ title: 'Hello' }),
})
```

ミドルウェアは `_csrf` フォームフィールドと `X-CSRF-Token` ヘッダーの両方をチェックします。

## 設定オプション

```ts
createCsrfMiddleware({
  // カスタムフォームフィールド名（デフォルト: '_csrf'）
  fieldName: '_token',

  // カスタムヘッダー名（デフォルト: 'X-CSRF-Token'）
  headerName: 'X-XSRF-Token',

  // CSRF 検証から除外するルート
  exclude: ['/api/webhooks/*', '/api/public/*'],

  // カスタムエラーハンドラー
  onError: (ctx) => {
    return ctx.json({ error: '無効な CSRF トークン' }, 403)
  },
})
```

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

トークンはセッションに紐づいており、以下の場合に再生成されます。
- 新しいセッションが作成されたとき
- `session.regenerate()` が呼び出されたとき（ログイン後に推奨）

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
4. **セキュアな Cookie フラグを設定** - セッションミドルウェアが自動的に処理

## Inertia.js との統合

Inertia.js を使用する場合、CSRF は Cookie を通じて自動的に処理されます。Axios/fetch の設定に credentials を含めてください。

```ts
// resources/js/app.tsx
axios.defaults.withCredentials = true
```

Inertia は自動的に `XSRF-TOKEN` Cookie を読み取り、リクエストに含めます。
