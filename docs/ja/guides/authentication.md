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

このコマンドはログイン・登録・パスワードリセットのコントローラー、Inertia ページ、レイアウト、`AuthProvider`、`MailProvider`、ユーザーモデル、SQL マイグレーション、デモシーダーを生成します。`--install` フラグにより自動的に:

1. `Application` の providers 配列に `AuthProvider` と `MailProvider` を登録
2. 開発環境用の設定で `createSessionMiddleware` を追加（本番では `cookieSecure: true`）
3. `routes/web.ts` で `registerAuthRoutes(router)` を接続
4. `db/schema.ts` にパスワードや remember トークンのカラムを追加

スキャフォルド後は以下を実行するだけです。

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

`http://localhost:3000/login` にアクセスし、`demo@example.com` / `secret` でログインできます。新規アカウントの作成は `/register` から行えます。

登録・パスワードリセット機能を省略してログインのみを生成したい場合は `--minimal` を付けます。

```bash
bunx guren make:auth --install --minimal
```

### パスワードリセット

ログインページの「Forgot your password?」から `ForgotPasswordController` と `ResetPasswordController` によるフローに入ります。内部ではフレームワークの `createPasswordResetToken` / `verifyPasswordResetToken` を使用しています。リセットトークンは生成される `app/Auth/PasswordResetStore.ts`（インメモリストア。本番や複数インスタンス構成では Redis ベースのストアに差し替えてください）に保存され、生成される `config/mail.ts` 経由でメール送信されます。`config/mail.ts` はデフォルトで `log` ドライバを使うため、リセットリンクはコンソールにそのまま出力され、開発環境では設定なしで動作確認できます。実際にメールを送るには `MAIL_DRIVER=smtp`（および `SMTP_*` の環境変数）を設定してください。

### メール確認

`--verify` を付けるとメール確認フローも一緒にスキャフォールドします。

```bash
bunx guren make:auth --install --verify
```

`users` テーブルに `emailVerifiedAt` カラムが追加され、`VerifyEmailController`（「メールを確認してください」の通知表示・再送・トークン確認を担当）と `VerifyEmail` ページが生成されます。登録時に確認メールが送信され、`/dashboard` の代わりに `/verify-email` へリダイレクトされるようになります。また生成される `/dashboard` ルートには `requireVerifiedEmail` が適用され、未確認のユーザーは確認が完了するまで `/verify-email` に戻されます。確認リンクもパスワードリセットと同じインメモリストア・`log` ドライバのメール設定を使うため、開発環境では設定なしで動作確認できます。`--verify` は登録フローの上に構築されるため、デフォルト（非 `--minimal`）の構成が前提です。

### OAuth ログインボタン

`--oauth` にカンマ区切りのプロバイダー名を渡すと、ログインページ(および `--minimal` でない限り登録ページにも)に「Continue with GitHub / Google / Discord」ボタンをスキャフォールドします。

```bash
bunx guren make:auth --install --oauth github,google
```

これにより、プロバイダーごとに `githubId` / `googleId` カラムが `users` テーブルに追加され、各プロバイダーのクライアントID・シークレット・リダイレクトURIがすべて設定されている場合にのみ共有の `OAuthManager` へ登録する `OAuthProvider`(環境変数名は後述の[OAuth / ソーシャルログイン](#oauth-ソーシャルログイン)を参照)と、`redirectToProvider` / `callback` アクションを持つ `OAuthController` が生成されます。コールバックはプロバイダーIDでユーザーを検索し、同じメールアドレスの既存アカウントへの自動紐付けは行わず(そのアカウントは作成時の方法でサインインしてもらいます)、それ以外の場合は**パスワードを持たない**アカウントを作成してからログインさせます。サインアップ時にハッシュ計算は一切発生せず、生成される `users.passwordHash` カラムも nullable のままです。プロバイダーがそのアドレスを未検証と報告している場合(Google の `email_verified`、Discord の `verified`)はアカウント作成を拒否します — メールアドレスが返ってきたことは「プロバイダーが検証済みである」という保証ではなく、未検証のまま作成すると所有していないアドレスを名乗れてしまうためです。既に紐付け済みのアカウントは、後からプロバイダー側の状態が変わっても影響を受けません。`--verify` と異なり `--oauth` は `--minimal` と併用できます。登録スキャフォールドに依存しないためです。

`--verify` を伴わない `--oauth` では、プロフィールのメールアドレスが**読み取り専用**でスキャフォールドされます。`ProfileUpdateSchema` からフィールドが除かれ、`ProfileController.update()` もメールアドレスを受け取らないため、フォームからも直接組み立てたリクエストからも、プロバイダーが保証したアドレスからアカウントを移すことはできません。`--verify` を併用した場合は編集可能なままです。変更後のアドレスは `emailVerifiedAt` がリセットされ、そのアドレス宛のリンクで確認するまで検証済みになりません。なお、どのモードでもアドレスは「主張」されるだけで予約されるわけではありません。登録フォームは形式が正しいメールアドレスをすべて受け付け、`users.email` は一意制約を持つため、すでにそのアドレスを保持しているアカウントがあると、本来の持ち主の初回 OAuth サインインは拒否されます。これが問題になるアプリでは、独自の所有確認を追加してください。

`--oauth` は `OAuthController` / `OAuthProvider` のファイルパスと配線方法を下記の `guren add oauth` と共有しています(コールバックがスタブではなく完成された実装である点のみが異なります)。同じアプリに対して両方を実行しないでください。2回目の実行は(`--force` なしなら)失敗するか、(`--force` ありなら)1回目の生成物を上書きします。

### OAuth のみでサインインする

`--oauth` だけではパスワードログインも同時に生成されます。パスワードログインを完全に外すには `--oauth-only` を付けます。

```bash
bunx guren make:auth --install --oauth github --oauth-only
```

`/login` は資格情報フォームを持たないプロバイダーボタンだけのページになり、`POST /login` ルートは生成されません。`LoginController` は `show()` とログアウト用の `destroy()` のみになります。新規登録・パスワードリセット・ログインページとプロフィールページのパスワード欄・`LoginValidator`、そしてデモ用の `UsersSeeder` はすべてスキップされます(サインインに使えないパスワードをシードしても意味がないためです)。`--oauth-only` はプロバイダーを1つ以上指定した `--oauth` が前提で(そうでなければサインイン手段が皆無のアプリになります)、`--minimal` の効果を含みます。`--verify` は無視されます — プロバイダー経由のメールアドレスは既に検証済みとして扱えるためです。

`--verify` なしの `--oauth` と同様に、このモードでもプロフィールのメールアドレスは読み取り専用です(詳細は上記を参照)。

`make:auth` は生成するファイルを書き込むだけで、削除は行いません。そのため既存のパスワード認証アプリを `--oauth-only --force` で変換すると、旧来の登録・リセット関連ファイルがディスク上に残ります(スキャフォールドが一覧を表示します)。これらは削除してください。特に残存した `db/seeders/UsersSeeder.ts` はルートテーブルではなく `db:seed` から拾われるため、`routes/auth.ts` を書き換えただけでは無効化されません。

Cloudflare Workers の無料プランのように CPU 時間が課金・制限される実行環境では、どのハッシュアルゴリズムを選んでもパスワードハッシュ1回でリクエストあたりの CPU 予算を超えるため、この構成が推奨です。

## OAuth / ソーシャルログイン

Guren には GitHub / Google / Discord 向けの OAuth プリセットが最初から用意されています。単体で使える低レベルなスキャフォールドです。`make:auth` のログイン・登録ページに直接組み込まれ、アカウント作成まで自動化された OAuth ボタンが欲しい場合は、代わりに上記の[OAuth ログインボタン](#oauth-ログインボタン)を参照してください。

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
    session: this.auth.session(),
  })
  return this.redirect(url)
}

async callback(): Promise<Response> {
  const { profile, redirectTo } = await this.oauth().handleCallback('github', {
    code,
    state,
    session: this.auth.session(),
  })
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
- `Hash`（`DefaultHasher`）をデフォルトで使用。Bun 上では `Bun.password`、それ以外では `node:crypto` の scrypt でハッシュ化します

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
import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '@/db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
}) {
  // 任意で上書き可能:
  // static override passwordField = 'plainPassword'
  // static override passwordHashField = 'password_digest'
}
```

`AuthenticatableModel` を `base` に渡し、同じ呼び出しで create のペイロードを整えます。`defineModel()` がテーブルから推論する型はデフォルト値のない全カラムを必須にしますが、ここではそれが正しい形ではありません。呼び出し側が渡すのは平文の `password` であって `passwordHash` ではないからです。`optionalOnCreate` がカラムを任意にし、`requireOnCreate` が仮想フィールドを必須にします。どちらも型レベルの指定で、キャストも型マーカーの再宣言も不要です。

任意にするだけなので、呼び出し側が `passwordHash` を渡しても型としては通ります。ランタイムでは `AuthenticatableModel` がハッシュカラム（とリメンバートークン）を一括代入から常に拒否します。リクエストボディにこれらが含まれると、モデルの `fillable` の内容に関わらず `MassAssignmentException` がスローされます。`passwordHash: 'oauth:...'` のような信頼できるサーバーサイドの値には `forceCreate()` / `forceUpdate()` を使ってください。

OAuth 専用のサインアップなどパスワードなしでアカウントが作られる場合は `requireOnCreate` を付けず、`password` を任意のままにします。

資格情報カラムにパスワードハッシュ以外の値が入っている場合、そのアカウントはパスワードで認証できないという意味になります。`ModelUserProvider` は null、空文字列、`'oauth:...'` のような番兵を同じ扱いにします: ログインを拒否し、実際の検証と同じだけのハッシュ計算を行うので応答時間からも判別できません。一方、ハッシュ形式を名乗っていて内容がそれを満たさない値はこれまでどおりスローします。カラムの破損や切り詰めであり、黙って拒否すると気付く手がかりが無くなるためです。パスワードを持たないアカウントには nullable なカラムの方が明快で、`make:auth --oauth` はそちらを生成します。

既定の `AuthServiceProvider` は `users` プロバイダーを使う `web` ガードを自動登録します。追加のガード（例: トークンベース API）が必要なら、`context.auth.registerGuard('api', factory)` を呼び、必要に応じて `context.auth.setDefaultGuard('api')` で既定を差し替えます。

## コントローラーとルート

コントローラーは `auth` ヘルパーを持っています。

```ts
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()       // ユーザーまたは null を返す
    return this.inertia(pages.dashboard.Index, { user })
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

Inertia の全ページでログインユーザーを共有する配線は、スキャフォルドが済ませています。`bunx guren add auth`（= `bunx guren make:auth --install`）が生成する `app/Providers/AuthProvider.ts` の `boot()` に次の登録が入っているため、生成直後から全ページの props で `auth.user` を読めます。生成されるレイアウトが **Sign in** と **Log out** を出し分けているのもこの props です。

```ts
// app/Providers/AuthProvider.ts（生成済み。register() の useModel 設定は省略）
import { ServiceProvider, shareInertiaProps, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext } from '@guren/core'

export default class AuthProvider extends ServiceProvider {
  boot(): void {
    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}
```

認証を手動で組み立てた場合は、自分のサービスプロバイダーの `boot()` で同じ呼び出しを行ってください。

このように `auth.user()` を共有する方法はデフォルトで安全です。レコードは認証レイヤーを出る前にサニタイズされるため、パスワードハッシュがブラウザに届くことはありません（後述の「サニタイズされたユーザーレコード」を参照）。

`InertiaSharedProps` を拡張し、React 側でも型付けしてください（詳細はコントローラーガイドを参照）。

> `shareInertiaProps` は先に登録されたリゾルバーの props にマージするため、
> auth・i18n・flash など複数箇所から共有 props を提供しても互いを壊しません:
>
> ```ts
> shareInertiaProps((ctx) => ({ i18n: { locale: detectLocale(ctx) } }), this.container)
> ```
>
> `this.container` を渡すとその props は1つのアプリケーションに閉じます。渡さ
> ない場合はプロセス全体で共有され、同時に起動した別のアプリケーションにも
> 漏れます。
>
> `setInertiaSharedProps` はマージせずプロセス全体のリゾルバーを置き換えるため、
> 実行時点で登録済みのものを丸ごと捨てます。意図的に全部を差し替えたいときだけ
> 使ってください。

ルートミドルウェアを使うと保護が簡単です。

```ts
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import LoginController from '@/app/Http/Controllers/Auth/LoginController'
import DashboardController from '@/app/Http/Controllers/DashboardController'

export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/dashboard' }))

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

`auth.user()`（および `login()` / `attempt()` 直後にキャッシュされるユーザー）が資格情報を露出することはありません。`ModelUserProvider` は、レコードが認証レイヤーを出る前に、パスワードカラム・remember トークンカラム・モデルが `hidden` に指定したフィールドを除去します。

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

`make:auth` スキャフォルダーは、この `hidden` 設定を含むユーザーモデルを最初から生成します。オプションと、引き続き使える `static hidden = [...]` の書き方については[フィールドの非表示](./database.md#フィールドの非表示)を参照してください。

資格情報の検証は内部で生のデータベースレコードに対して行われるため、ログインや remember me の動作には影響しません。サニタイズが変えるのは、`auth.user()` がアプリケーションコードに公開する内容だけです。

カスタムのユーザープロバイダーは、`UserProvider` インターフェースのオプションメソッド `sanitize(user)` を実装することでオプトインできます。`SessionGuard` はユーザーをキャッシュ・返却する前にこのメソッドを呼び出します。

```ts
sanitize(user: AuthUser): AuthUser {
  const { passwordHash, ...safe } = user
  return safe as AuthUser
}
```

### サニタイズ済みユーザーの型付け

サニタイズはランタイムの処理なので、単に `auth.user<UserRecord>()` と書くと、実際には取り除かれている資格情報フィールドが型の上では残ったままになります。`Sanitized<T>` ヘルパーを使うと、慣例的な資格情報キーを型から取り除けます。

```ts
import type { Sanitized } from '@guren/core'

// password / passwordHash / rememberToken 系のキーを型から除去
const user = await this.auth.userOrFail<Sanitized<UserRecord>>()

user.email        // ✅ string
user.passwordHash // ❌ コンパイルエラー — ランタイムで除去済み
```

モデルの `hidden` で追加のフィールドを隠している場合や、資格情報カラムが慣例名(`password`、`passwordHash`、`password_hash`、`rememberToken`、`remember_token`)以外の場合は、第2型引数に列挙します。

```ts
type SafeUser = Sanitized<UserRecord, 'twoFactorSecret' | 'credentialDigest'>
```

ランタイムが除去するのは「プロバイダーに設定されたカラム + モデルの `hidden` フィールド」そのものです。静的型はこの設定を参照できないため、`Sanitized<T>` は慣例名を反映し、それ以外は第2型引数での指定に委ねます。`hidden` に漏れている機微カラムは `guren audit` が警告するため、ランタイム側の正しさはそちらで担保できます。

## Remember トークン

`SessionGuard` は remember トークンを自動管理します。ユーザープロバイダーが `setRememberToken` / `getRememberToken` を実装していれば動作し、`ModelUserProvider` は `rememberTokenColumn` を指定すると対応します。

## 実例アプリ

ブログの例には認証機能一式が含まれます:

- ガード/プロバイダー設定用の `AuthProvider` と `OAuthProvider`
- ログイン・登録・パスワードリセット・メール確認の各コントローラー、および `DashboardController`
- `resources/js/pages/auth/` 配下の Inertia ページ(`Login`・`Register`・`ForgotPassword`・`ResetPassword`・`VerifyEmail`)と `resources/js/pages/dashboard/Index.tsx`
- GitHub・Google 向けの OAuth ログインボタン
- `users` 用のスキーマ、マイグレーション、シーダー

デモを実行します。

```bash
bun run dev
```

`http://localhost:3333/login` にアクセスし、シード済みの `demo@guren.dev` / `secret` でログインするか、`/register` から新規アカウントを作成できます。
