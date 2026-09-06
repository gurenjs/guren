# 認証アプリを作る

このガイドでは、ユーザー登録・ログイン・保護されたルートを備えたアプリケーションを構築します。空のディレクトリから認証フロー完成まで、10分以内で完了できます。

> [!NOTE]
> これはタスク指向のガイドです。セッション、ガード、ユーザープロバイダーの詳細は[認証ガイド](./authentication.md)を参照してください。

## 前提条件

- **Bun 1.1 以降**
- **Docker Desktop (Compose v2)** — Postgres 用

## 1. プロジェクトを作成する

```bash
bunx create-guren-app my-auth-app --mode ssr --db postgres
cd my-auth-app
bun install
```

## 2. 認証機能を追加する

`add auth` ジェネレーターを使うと、コントローラー、Inertia ページ、ユーザーモデル、マイグレーション、セッションミドルウェアが一括で生成されます:

```bash
bunx guren add auth
```

生成されるもの:

- `app/Http/Controllers/Auth/LoginController.ts` と `RegisterController.ts`
- パスワードとリメンバートークンのカラムを持つ `app/Models/User.ts`
- `resources/js/pages/Auth/` 配下の Inertia ページ
- アプリケーションプロバイダーに登録済みの `AuthProvider`
- 開発環境向けのデフォルト設定が適用されたセッションミドルウェア
- `routes/web.ts` のレジストラに接続された `routes/auth.ts`

## 3. データベースを起動する

```bash
bun run db:up
```

マイグレーションを実行して `users` テーブルを作成します:

```bash
bunx guren db:migrate
```

## 4. 型マニフェストを生成する

```bash
bun run codegen
```

ルートとページの型付きマニフェストが生成され、コントローラーとフロントエンドコンポーネントの型安全性が確保されます。

## 5. 開発サーバーを起動する

```bash
bun run dev
```

`http://localhost:3333/register` でアカウントを作成し、`http://localhost:3333/login` でログインできます。

## 6. 主要なコードを理解する

### LoginController

生成されるコントローラーは `LoginSchema`（同時に生成される `app/Http/Validators/LoginValidator.ts` にあります）でバリデーションを行い、認証ガードに処理を委譲します:

```typescript
import { Controller, ValidationException } from '@guren/core'
import { LoginSchema } from '../../Validators/LoginValidator.js'
import { pages } from '@/.guren/pages.gen'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.Login, { email }, { title: 'Login' })
  }

  async store(): Promise<Response> {
    const { email, password, remember } = await this.validateBody(LoginSchema)

    this.auth.session()?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      throw ValidationException.withMessages({ message: 'Invalid credentials.' })
    }

    return this.redirect('/dashboard')
  }

  async destroy(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()
    return this.redirect('/')
  }
}
```

認証に失敗した場合は `ValidationException.withMessages()` を throw します。フレームワークはこれを `errors` を含む 422 として返し、生成されるログインページは `errors.message` を表示します。特定の入力欄にメッセージを紐付けたい場合は、キーにフィールド名を使ってください（`{ email: '...' }`）。

### 認証ミドルウェア

ジェネレーターは `routes/auth.ts` を生成し、ルートレジストラから呼び出すよう配線します。各ルートは自分のガードを個別に持ちます:

```typescript
import { Router, requireAuthenticated, requireGuest } from '@guren/core'

export function registerAuthRoutes(router: Router): void {
  router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')
  router.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('login.store')
  router.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')

  router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('dashboard')
}
```

短い名前でグループ全体を保護したい場合は、自分でエイリアスを登録してください。`aliasMiddleware()` はエイリアス名を型に持つ Router を返すので、戻り値を必ず受け取ります:

```typescript
export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index']).name('dashboard')
  })
}
```

### 保護されたページ

保護されたコントローラー内では `this.auth` で現在のユーザーにアクセスできます:

```typescript
import { Controller } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index(): Promise<Response> {
    const currentUser = await this.auth.user<UserRecord | null>()
    const user = currentUser
      ? { id: currentUser.id, name: currentUser.name, email: currentUser.email }
      : null
    return this.inertia(pages.dashboard.Index, { user }, { title: 'Dashboard' })
  }
}
```

`this.auth.user<T>()` はゲストの場合 `null` を返します。null 分岐ではなく 401 にしたい場合は `this.auth.userOrFail<T>()` を使ってください。

## 7. フローを検証する

1. `/register` にアクセスしてユーザーを作成する
2. `/login` にアクセスして作成した認証情報でログインする
3. `/dashboard` に遷移し、ユーザー名が表示されることを確認する
4. シークレットウィンドウで `/dashboard` にアクセスし、`/login` にリダイレクトされることを確認する
5. ログアウトして、ログインページに戻ることを確認する

## 次のステップ

- [メール認証](./email-verification.md) — 保護されたルートへのアクセス前にメールアドレスの確認を要求する
- [パスワードリセット](./password-reset.md) — ユーザーがアカウントを復旧できるようにする
- [認可](./authorization.md) — ロールベースのアクセス制御を追加する
- [API トークン](./api-tokens.md) — プログラムからのアクセス用トークンを発行する
