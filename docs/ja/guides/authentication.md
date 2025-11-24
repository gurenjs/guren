# 認証ガイド

Guren には Laravel 由来の認証スタックが同梱され、セッションミドルウェアと ORM の上に構築されています。TypeScript/Bun に馴染む形でガードとユーザープロバイダーを提供します。

## 基本概念

- **AuthManager**: ガードとユーザープロバイダーのレジストリ。アプリケーションインスタンスの `app.auth` またはサービスプロバイダー内の `context.auth` から利用。
- **ガード**: リクエストを認証するランタイムオブジェクト。既定の `SessionGuard` はセッションにユーザー ID を保持し、任意で「ログイン情報を保持する」トークンも扱います。
- **ユーザープロバイダー**: ガードがユーザーを読み込み・検証するためのデータアクセス層。`ModelUserProvider` は Guren の `Model` 抽象に対応し、Drizzle のテーブルを認証に使えます。
- **Auth コンテキスト**: リクエスト単位のファサードで、`auth.check()`, `auth.user()`, `auth.login()` などのヘルパーを提供。`AuthServiceProvider` が自動でアタッチし、コントローラでは `this.auth`、ミドルウェアでは `attachAuthContext` 経由で利用できます。

## CLI でクイックスタート

新規アプリではスキャフォルダーを実行します:

```bash
bunx guren make:auth
```

このコマンドはコントローラ、Inertia ページ、レイアウト、`AuthProvider`、ユーザーモデル、SQL マイグレーション、デモシーダーを生成します。実行後は:

1. `AuthProvider`、`createSessionMiddleware`、`attachAuthContext` を `src/app.ts` に登録。
2. `src/main.ts`（または既存のルートブート箇所）で `./routes/auth` をインポート。
3. `bun run db:migrate` の後に `bun run db:seed` を実行。

スキャフォルダーは必要に応じて `db/schema.ts` にパスワードや remember トークンのカラムを追加します。

## セッションの有効化

ガードはセッションに依存します。アプリ起動の早い段階で `createSessionMiddleware` を登録してください:

```ts
import { Application, createSessionMiddleware } from '@guren/core'

const app = new Application()
app.use('*', createSessionMiddleware())
```

## プロバイダーとガードの設定

ユーザープロバイダーと（必要なら）カスタムガードを登録するサービスプロバイダーを用意します。以下は `User` モデル向けに `ModelUserProvider` を配線し、既定の `web` セッションガードを維持する例です。

```ts
import type { ApplicationContext, Provider } from '@guren/core'
import { ModelUserProvider } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    }))
  }
}
```

後述の `AuthenticatableModel` を併用するとパスワードのハッシュ化と検証ヘルパーが自動で付きます。内部では Bun の Argon2id を既定で使用するため、追加依存なしで最新のハッシュ化が得られます。

### 認証可能モデル

`AuthenticatableModel` を継承したモデルはパスワード処理が組み込まれます。`create` や `update` に平文 `password` を渡すと自動でハッシュ化し、`passwordHash` カラム（静的プロパティで変更可）に保存します。平文は保持せず、プロバイダーと同じアルゴリズムで認証を行います。

```ts
import { AuthenticatableModel } from '@guren/core'
import { users } from '@/db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
  // 任意で上書き可能:
  // static override passwordField = 'plainPassword'
  // static override passwordHashField = 'password_digest'
}
```

既定の `AuthServiceProvider` は `users` プロバイダーを使う `web` ガードを自動登録します。追加のガード（例: トークンベース API）が必要なら、`context.auth.registerGuard('api', factory)` を呼び、必要に応じて `context.auth.setDefaultGuard('api')` で既定を差し替えます。

## コントローラとルート

コントローラは `auth` ヘルパーを持ちます:

```ts
export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()
    return this.inertia('dashboard/Index', { user }, { url: this.request.path })
  }
}
```

Zod などのバリデーションを組み込むときは `parseRequestPayload()` と `formatValidationErrors()` を使うとハンドリングを一貫できます。

Inertia の全ページでログインユーザーを共有したい場合は、アプリ起動時に共有 props を登録します:

```ts
// config/inertia.ts
import { setInertiaSharedProps, AUTH_CONTEXT_KEY, type AuthContext } from '@guren/server'

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return { auth: { user: await auth?.user() } }
})
```

`InertiaSharedProps` を拡張し、React 側でも型付けしてください（詳細はコントローラガイドを参照）。

ルートミドルウェアを使うと保護が簡単です:

```ts
import { Route, requireAuthenticated, requireGuest } from '@guren/core'
import LoginController from '@/app/Http/Controllers/Auth/LoginController'

Route.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' }))
```

## セッションガードのヘルパー

- `auth.check()` — 認証済みなら `true`。
- `auth.user()` — 現在のユーザーレコード（または `null`）。
- `auth.login(user, remember?)` — 指定ユーザーでログインし、任意で remember トークンを発行。
- `auth.attempt(credentials, remember?)` — 資格情報を検証し、成功時にログイン。
- `auth.logout()` — セッションと remember トークンをクリア。

## Remember トークン

`SessionGuard` は remember トークンを自動管理します。ユーザープロバイダーが `setRememberToken` / `getRememberToken` を実装していれば動作し、`ModelUserProvider` は `rememberTokenColumn` を指定すると対応します。

## 実例アプリ

ブログの例には以下が含まれます:

- ガード/プロバイダー設定用の `AuthProvider`
- `LoginController` と `DashboardController`
- `resources/js/pages/auth/Login.tsx` と `resources/js/pages/dashboard/Index.tsx` の Inertia ページ
- `users` 用のスキーマ、マイグレーション、シーダー

デモ実行:

```bash
bun run dev
```

`http://localhost:3000/login` にアクセスし、シード済みの `demo@example.com` / `secret` でログインできます。
