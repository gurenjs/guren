# 認証ガイド

Guren には Laravel 由来の認証スタックが同梱され、セッションミドルウェアと ORM の上に構築されています。TypeScript/Bun に馴染む形でガードとユーザープロバイダーを提供します。

## 基本概念

- **AuthManager**: ガードとユーザープロバイダーのレジストリ。アプリケーションインスタンスの `app.auth` またはサービスプロバイダー内の `context.auth` から利用。
- **ガード**: リクエストを認証するランタイムオブジェクト。既定の `SessionGuard` はセッションにユーザー ID を保持し、任意で「ログイン情報を保持する」トークンも扱います。
- **ユーザープロバイダー**: ガードがユーザーを読み込み・検証するためのデータアクセス層。`ModelUserProvider` は Guren の `Model` 抽象に対応し、Drizzle のテーブルを認証に使えます。
- **Auth コンテキスト**: リクエスト単位のファサードで、`auth.check()`, `auth.user()`, `auth.login()` などのヘルパーを提供。`AuthServiceProvider` が自動でアタッチし、コントローラーでは `this.auth`、ミドルウェアでは `attachAuthContext` 経由で利用できます。
- **OAuthManager**: ソーシャルログイン向けヘルパー。OAuth state 管理、コード交換、プロファイル取得を扱います。

## CLI でクイックスタート

新規アプリでは自動インストール機能付きのスキャフォルダーを実行します（セッションミドルウェアはデフォルトで自動付与されます）。

```bash
bunx guren make:auth --install
```

このコマンドはコントローラー、Inertia ページ、レイアウト、`AuthProvider`、ユーザーモデル、SQL マイグレーション、デモシーダーを生成します。`--install` フラグにより自動的に:

1. `Application` の providers 配列に `AuthProvider` を登録
2. 開発環境用の設定で `createSessionMiddleware` を追加（本番では `cookieSecure: true`）
3. `routes/web.ts` で `registerAuthRoutes(router)` を接続
4. `db/schema.ts` にパスワードや remember トークンのカラムを追加

スキャフォルド後は以下を実行するだけです。

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

`http://localhost:3000/login` にアクセスし、`demo@example.com` / `secret` でログインできます。

## OAuth / ソーシャルログイン

Wave 4 で、GitHub / Google / Discord 向けの OAuth プリセットを追加しました。

### OAuth スキャフォールド

```bash
bunx guren add oauth
```

以下が生成されます。

- `app/Providers/OAuthProvider.ts`
- `app/Http/Controllers/Auth/OAuthController.ts`
- `routes/oauth.ts`

さらに `src/app.ts` に `CoreOAuthServiceProvider` と `OAuthProvider` が自動登録されます。

### プロバイダー資格情報の設定

```bash
OAUTH_GITHUB_CLIENT_ID=...
OAUTH_GITHUB_CLIENT_SECRET=...
OAUTH_GITHUB_REDIRECT_URI=https://your-app.test/auth/github/callback
```

`GOOGLE` / `DISCORD` も同様の環境変数名で設定できます。

### ルートフロー

```ts
router.get('/auth/:provider', [OAuthController, 'redirectToProvider'])
router.get('/auth/:provider/callback', [OAuthController, 'callback'])
```

`redirectToProvider` は state を生成してプロバイダー同意画面へリダイレクトします。  
`callback` は state を検証し、authorization code を token に交換してプロフィールを取得します。

### ログイン後リダイレクト(`redirectTo`)

フロー開始時に `redirectTo` を渡すと、コールバック後にサニタイズ済みの値として受け取れます。スキャフォールドされた `OAuthController`(`this.oauth()` でマネージャーを解決)では:

```ts
// /auth/github?redirectTo=/settings
async redirectToProvider(): Promise<Response> {
  const { url } = await this.oauth().authorize('github', {
    redirectTo: this.request.query('redirectTo'),
  })
  return this.redirect(url)
}

async callback(): Promise<Response> {
  const { profile, redirectTo } = await this.oauth().handleCallback('github', { code, state })
  // ...ユーザーをログインさせる...
  return this.redirect(redirectTo ?? '/')
}
```

`redirectTo` はフローの入口と出口の両方でオープンリダイレクト対策の検証を通ります。デフォルトで通過するのはアプリ相対パス(`/settings`)のみで、プロトコル相対URL(`//evil.com`)、バックスラッシュ変種、http(s) 以外のスキーム、許可リスト外のホストは破棄され、`redirectTo` は `undefined` になってフォールバックが適用されます。

特定の外部ホストを許可する場合(ワイルドカード対応)は、マネージャーが解決される前に許可リスト付きでバインドします — スキャフォールドアプリでは `app/Providers/OAuthProvider.ts` の `register()` 冒頭で:

```ts
this.container.singleton('oauth', () =>
  createOAuthManager({
    stateConfig: { allowedRedirectHosts: ['accounts.example.com', '*.example.org'] },
  }),
)
```

> **Note:** `createRedirectSafetyMiddleware`(オプトイン)は独自の `allowedHosts` オプションで `Location` ヘッダーを検証します。併用する場合は両方の許可リストを揃えてください — ずれていると、許可したはずの外部リダイレクトがミドルウェアに `/` へ書き換えられます。

### 手動セットアップ

手動で設定したい場合や、部分的に設定済みの環境では `--install` フラグを省略します。

```bash
bunx guren make:auth
```

その後、手動で:
1. `src/app.ts` に `AuthProvider` を登録
2. ミドルウェアスタックに `createSessionMiddleware` を追加（`AuthServiceProvider` がデフォルトで自動追加。不要ならオプトアウト）
3. `routes/web.ts` から `registerAuthRoutes(router)` を呼ぶ

`--install` フラグは安全かつ冪等です – 既存の設定を重複させません。

## セッションの有効化

ガードはセッションに依存します。デフォルトでは `AuthServiceProvider` が `createSessionMiddleware` を自動で付与します。無効化やカスタマイズは `createApp()` にオプションを渡します。

```ts
import { createApp } from '@guren/core'

const app = createApp({
  auth: {
    autoSession: true, // 無効化したい場合は false
    sessionOptions: {
      cookieSecure: process.env.NODE_ENV === 'production',
    },
  },
})
```

細かく制御したい場合は、`src/app.ts` で明示的に登録してください。

```ts
import { createApp, createSessionMiddleware } from '@guren/core'

const app = createApp()
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

認証を設定する最もシンプルな方法は `auth.useModel()` ヘルパーを使用することで、`ModelUserProvider` と `SessionGuard` を一度に登録できます。

```ts
import { ServiceProvider } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
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

カスタムプロバイダーやガードが必要な高度なケースでは、手動で設定できます。

```ts
import { ServiceProvider } from '@guren/core'
import { ModelUserProvider, SessionGuard } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')

    // プロバイダーを登録
    auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    }))

    // カスタムガードを登録
    auth.registerGuard('web', ({ session, manager }) => {
      const provider = manager.getProvider('users')
      return new SessionGuard({ provider, session })
    })

    auth.setDefaultGuard('web')
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

## コントローラーとルート

コントローラーは `auth` ヘルパーを持っています。

```ts
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()       // ユーザーまたは null を返す
    return this.inertia(pages.dashboard.Index, { user }, { url: this.request.path })
  }

  async store() {
    const user = await this.auth.userOrFail()  // 未認証なら 401 をスロー
    // user は non-null が保証される
    await Post.create({ authorId: user.id, ...data })
    return this.redirect('/posts')
  }
}
```

バリデーションには `this.validateBody()` / `this.validateQuery()` / `this.validateParams()` を Zod スキーマと共に使います。`FormRequest` は互換用途に限定してください。

Inertia の全ページでログインユーザーを共有したい場合は、アプリ起動時に共有 props を登録します。

```ts
// config/inertia.ts
import { setInertiaSharedProps, AUTH_CONTEXT_KEY, type AuthContext } from '@guren/core'

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return { auth: { user: await auth?.user() } }
})
```

このように `auth.user()` を共有する方法はデフォルトで安全です。レコードは認証レイヤーを出る前にサニタイズされるため、パスワードハッシュがブラウザに届くことはありません（後述の「サニタイズされたユーザーレコード」を参照）。

`InertiaSharedProps` を拡張し、React 側でも型付けしてください（詳細はコントローラーガイドを参照）。

> `setInertiaSharedProps` はリゾルバー全体を置き換えます。auth・i18n・flash
> など複数箇所から共有 props を提供する場合は、既存の props にマージする
> `shareInertiaProps` を使ってください:
>
> ```ts
> import { shareInertiaProps } from '@guren/core'
>
> shareInertiaProps((ctx) => ({ i18n: { locale: detectLocale(ctx) } }))
> ```

ルートミドルウェアを使うと保護が簡単です。

```ts
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import LoginController from '@/app/Http/Controllers/Auth/LoginController'
import DashboardController from '@/app/Http/Controllers/DashboardController'

export function registerWebRoutes(router: Router): void {
  router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
  router.aliasMiddleware('guest', requireGuest({ redirectTo: '/dashboard' }))

  router.middleware('guest').group((guest) => {
    guest.get('/login', [LoginController, 'show'])
    guest.post('/login', [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy'])
    auth.get('/dashboard', [DashboardController, 'index'])
  })
}
```

## セッションガードのヘルパー

- `auth.check()` — 認証済みなら `true`。
- `auth.user()` — 現在のユーザーレコード（または `null`）。パスワードハッシュ・remember トークン・モデルの `hidden` フィールドは除去されたサニタイズ済みレコードを返します。
- `auth.userOrFail()` — 現在のユーザーを返すか、未認証なら `AuthenticationException`（401）をスロー。ルートが保護されていると分かっている場合に、null チェックを省略できます。
- `auth.login(user, remember?)` — 指定ユーザーでログインし、任意で remember トークンを発行。
- `auth.attempt(credentials, remember?)` — 資格情報を検証し、成功時にログイン。
- `auth.logout()` — セッションと remember トークンをクリア。

## サニタイズされたユーザーレコード

`auth.user()`（および `login()` / `attempt()` 直後にキャッシュされるユーザー）が資格情報を露出することはありません。`ModelUserProvider` は、レコードが認証レイヤーを出る前に、パスワードカラム・remember トークンカラム・モデルの `static hidden` に列挙されたフィールドを除去します。

```ts
export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
  static override hidden = ['passwordHash', 'rememberToken']
}
```

`make:auth` スキャフォルダーは、この `hidden` 宣言を含むユーザーモデルを最初から生成します。

資格情報の検証は内部で生のデータベースレコードに対して行われるため、ログインや remember me の動作には影響しません。サニタイズが変えるのは、`auth.user()` がアプリケーションコードに公開する内容だけです。

カスタムのユーザープロバイダーは、`UserProvider` インターフェースのオプションメソッド `sanitize(user)` を実装することでオプトインできます。`SessionGuard` はユーザーをキャッシュ・返却する前にこのメソッドを呼び出します。

```ts
sanitize(user: AuthUser): AuthUser {
  const { passwordHash, ...safe } = user
  return safe as AuthUser
}
```

## Remember トークン

`SessionGuard` は remember トークンを自動管理します。ユーザープロバイダーが `setRememberToken` / `getRememberToken` を実装していれば動作し、`ModelUserProvider` は `rememberTokenColumn` を指定すると対応します。

## 実例アプリ

ブログの例には以下が含まれます:

- ガード/プロバイダー設定用の `AuthProvider`
- `LoginController` と `DashboardController`
- `resources/js/pages/auth/Login.tsx` と `resources/js/pages/dashboard/Index.tsx` の Inertia ページ
- `users` 用のスキーマ、マイグレーション、シーダー

デモを実行します。

```bash
bun run dev
```

`http://localhost:3000/login` にアクセスし、シード済みの `demo@example.com` / `secret` でログインできます。
