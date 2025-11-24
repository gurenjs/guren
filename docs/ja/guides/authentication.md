# 認証ガイド

Guren には Laravel 由来の認証スタックが同梱され、セッションミドルウェアと ORM の上に構築されています。TypeScript/Bun に馴染む形でガードとユーザープロバイダーを提供します。

## 基本概念

- **AuthManager**: ガードとユーザープロバイダーのレジストリ。アプリケーションインスタンスの `app.auth` またはサービスプロバイダー内の `context.auth` から利用。
- **ガード**: リクエストを認証するランタイムオブジェクト。既定の `SessionGuard` はセッションにユーザー ID を保持し、任意で「ログイン情報を保持する」トークンも扱います。
- **ユーザープロバイダー**: ガードがユーザーを読み込み・検証するためのデータアクセス層。`ModelUserProvider` は Guren の `Model` 抽象に対応し、Drizzle のテーブルを認証に使えます。
- **Auth コンテキスト**: リクエスト単位のファサードで、`auth.check()`, `auth.user()`, `auth.login()` などのヘルパーを提供。`AuthServiceProvider` が自動でアタッチし、コントローラでは `this.auth`、ミドルウェアでは `attachAuthContext` 経由で利用できます。

## CLI でクイックスタート

新規アプリでは自動インストール機能付きのスキャフォルダーを実行します（セッションミドルウェアはデフォルトで自動付与されます）:

```bash
bunx guren make:auth --install
```

このコマンドはコントローラ、Inertia ページ、レイアウト、`AuthProvider`、ユーザーモデル、SQL マイグレーション、デモシーダーを生成します。`--install` フラグにより自動的に:

1. `Application` の providers 配列に `AuthProvider` を登録
2. 開発環境用の設定で `createSessionMiddleware` を追加（本番では `cookieSecure: true`）
3. `routes/web.ts` に認証ルートをインポート
4. `db/schema.ts` にパスワードや remember トークンのカラムを追加

スキャフォルド後は以下を実行するだけです:

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

`http://localhost:3000/login` にアクセスし、`demo@example.com` / `secret` でログインできます。

### 手動セットアップ

手動で設定したい場合や、部分的に設定済みの環境では `--install` フラグを省略します:

```bash
bunx guren make:auth
```

その後、手動で:
1. `src/app.ts` に `AuthProvider` を登録
2. ミドルウェアスタックに `createSessionMiddleware` を追加（`AuthServiceProvider` がデフォルトで自動追加。不要ならオプトアウト）
3. `routes/web.ts` から `./routes/auth` をインポート

`--install` フラグは安全かつ冪等です – 既存の設定を重複させません。

## セッションの有効化

ガードはセッションに依存します。デフォルトでは `AuthServiceProvider` が `createSessionMiddleware` を自動で付与します。無効化やカスタマイズは `Application` にオプションを渡します。

```ts
import { Application } from '@guren/server'

const app = new Application({
  auth: {
    autoSession: true, // 無効化したい場合は false
    sessionOptions: {
      cookieSecure: process.env.NODE_ENV === 'production',
    },
  },
})
```

細かく制御したい場合は、ブート処理の早い段階で明示的に登録してください:

```ts
import { Application, createSessionMiddleware } from '@guren/core'

const app = new Application()
app.use('*', createSessionMiddleware())
```

`cookieSecure` はセッション Cookie に `Secure` 属性を付けるかどうかを制御します。HTTPS のみで送信させる属性で、本番では `true` を推奨します。ローカル開発では `http://localhost` で動かすためデフォルトで `false` になっています。

**Application の auth オプション**
- `autoSession`（デフォルト `true`）: `createSessionMiddleware` を自動で付与します。
- `sessionOptions`（`createSessionMiddleware` にそのまま渡されます）:
  - `cookieName`（デフォルト `guren.session`）
  - `cookieSecure`（本番は `true`、開発は `false` がデフォルト）
  - `cookieSameSite`（デフォルト `Lax`）
  - `cookieHttpOnly`（デフォルト `true`）
  - `cookieMaxAgeSeconds`（任意。指定がなければ `ttlSeconds` を使用）
  - `ttlSeconds`（デフォルト 2 時間）
  - `store`（デフォルトはメモリストア。複数インスタンス構成では独自実装に差し替えてください）

## プロバイダーとガードの設定

### `auth.useModel()` ショートハンドの使用（推奨）

認証を設定する最もシンプルな方法は `auth.useModel()` ヘルパーを使用することで、`ModelUserProvider` と `SessionGuard` を一度に登録できます:

```ts
import type { ApplicationContext, Provider } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }
}
```

このメソッド呼び出しで:
- 指定されたカラムで `ModelUserProvider` を登録
- 適切なセッション処理を備えた `SessionGuard` を作成
- デフォルトガードを 'web' に設定
- `ScryptHasher`（Bun ネイティブの scrypt ベース）をデフォルトで使用

### 手動設定（上級者向け）

カスタムプロバイダーやガードが必要な高度なケースでは、手動で設定できます:

```ts
import type { ApplicationContext, Provider } from '@guren/core'
import { ModelUserProvider, SessionGuard } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    // プロバイダーを登録
    context.auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    }))

    // カスタムガードを登録
    context.auth.registerGuard('web', ({ session, manager }) => {
      const provider = manager.getProvider('users')
      return new SessionGuard({ provider, session })
    })

    context.auth.setDefaultGuard('web')
  }
}
```

後述の `AuthenticatableModel` を併用するとパスワードのハッシュ化と検証ヘルパーが自動で付きます。

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
