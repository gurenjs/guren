# 認証アプリを作る

このガイドでは、ユーザー登録・ログイン・保護されたルートを備えたアプリケーションを構築します。空のディレクトリから認証フロー完成まで、10分以内で完了できます。

> [!NOTE]
> これはタスク指向のガイドです。セッション、ガード、ユーザープロバイダーの詳細は[認証ガイド](./authentication.md)を参照してください。

## 前提条件

- **Bun 1.1 以降**
- **Docker Desktop (Compose v2)** — Postgres 用

## 1. プロジェクトを作成する

```bash
bunx create-guren-app my-auth-app --mode ssr
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
- `routes/web.ts` に接続された認証ルート

## 3. データベースを起動する

```bash
docker compose up -d
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

生成されるコントローラーは Zod でバリデーションを行い、認証ガードに処理を委譲します:

```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  remember: z.boolean().optional(),
})

export class LoginController extends Controller {
  async show() {
    return this.inertia(pages.auth.Login)
  }

  async login() {
    const { email, password, remember } = await this.validateBody(LoginSchema)
    const ok = await this.auth.attempt({ email, password }, remember)

    if (!ok) {
      return this.back().withErrors({ email: '認証情報が正しくありません。' })
    }

    return this.redirect('/dashboard')
  }

  async logout() {
    await this.auth.logout()
    return this.redirect('/login')
  }
}
```

### 認証ミドルウェア

ジェネレーターが登録する `auth` エイリアスを使って、ルートグループを保護します:

```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  // 公開ルート
  router.get('/login', [LoginController, 'show']).name('login.show')
  router.post('/login', [LoginController, 'login']).name('login')
  router.post('/logout', [LoginController, 'logout']).name('logout')

  // 保護されたルート
  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index']).name('dashboard')
  })
}
```

### 保護されたページ

保護されたコントローラー内では `this.auth` で現在のユーザーにアクセスできます:

```typescript
export class DashboardController extends Controller {
  async index() {
    const user = await this.auth.userOrFail()
    return this.inertia(pages.dashboard.Index, { user })
  }
}
```

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
