# 認証ガイド

Guren には Laravel 由来の認証スタックが同梱されていて、セッションミドルウェアと ORM の上に載っています。ガードとユーザープロバイダーは、TypeScript/Bun に馴染む形になっています。

## 基本概念

- **AuthManager**: ガードとユーザープロバイダーのレジストリ。アプリケーションインスタンスの `app.auth`、またはサービスプロバイダー内の `context.auth` から使います。
- **ガード**: リクエストを認証するランタイムオブジェクト。既定の `SessionGuard` はセッションにユーザー ID を保持し、任意で「ログイン情報を保持する」トークンも扱います。
- **ユーザープロバイダー**: ガードがユーザーを読み込み・検証するためのデータアクセス層。`ModelUserProvider` は Guren の `Model` 抽象に対応しているので、Drizzle のテーブルをそのまま認証に使えます。
- **Auth コンテキスト**: リクエスト単位のファサードで、`auth.check()`, `auth.user()`, `auth.login()` などのヘルパーを持ちます。`AuthServiceProvider` が自動でアタッチし、コントローラーでは `this.auth`、ミドルウェアでは `attachAuthContext` 経由で使えます。
- **OAuthManager**: ソーシャルログイン向けのヘルパー。OAuth state 管理、コード交換、プロファイル取得を扱います。

## CLI でクイックスタート

新規アプリでは、自動インストール付きのスキャフォルダーを実行します(セッションミドルウェアはデフォルトで自動付与されます)。

```bash
bunx guren make:auth --install
```

このコマンドは、ログイン・登録・パスワードリセットのコントローラー、Inertia ページ、レイアウト、`AuthProvider`、`MailProvider`、ユーザーモデル、SQL マイグレーション、デモシーダーを生成します。`--install` フラグを付けると、次の4点も自動で行われます。

1. `Application` の providers 配列に `AuthProvider` と `MailProvider` を登録
2. 開発環境用の設定で `createSessionMiddleware` を追加(本番では `cookieSecure: true`)
3. `routes/web.ts` で `registerAuthRoutes(router)` を接続
4. `db/schema.ts` にパスワードや remember トークンのカラムを追加

スキャフォルド後は以下を実行するだけです。

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

`http://localhost:3000/login` にアクセスすると、`demo@example.com` / `secret` でログインできます。新規アカウントは `/register` から作成できます。

登録とパスワードリセットを省いてログインだけを生成したい場合は、`--minimal` を付けます。

```bash
bunx guren make:auth --install --minimal
```

### パスワードリセット

ログインページの「Forgot your password?」から、`ForgotPasswordController` と `ResetPasswordController` によるフローに入ります。内部ではフレームワークの `createPasswordResetToken` / `verifyPasswordResetToken` を使っています。リセットトークンは、生成される `app/Auth/PasswordResetStore.ts`(インメモリストア。本番や複数インスタンス構成では Redis ベースのストアに差し替えてください)に保存され、同じく生成される `config/mail.ts` 経由でメール送信されます。`config/mail.ts` はデフォルトで `log` ドライバを使うので、リセットリンクはコンソールにそのまま出力され、開発環境では設定なしで動作確認できます。実際にメールを送るには `MAIL_DRIVER=smtp`(および `SMTP_*` の環境変数)を設定してください。

### メール確認

`--verify` を付けるとメール確認フローも一緒にスキャフォールドします。

```bash
bunx guren make:auth --install --verify
```

`users` テーブルに `emailVerifiedAt` カラムが追加され、`VerifyEmailController`(「メールを確認してください」の通知表示・再送・トークン確認を担当)と `VerifyEmail` ページが生成されます。登録時には確認メールが送信され、`/dashboard` の代わりに `/verify-email` へリダイレクトされるようになります。生成される `/dashboard` ルートには `requireVerifiedEmail` が適用され、未確認のユーザーは確認が完了するまで `/verify-email` に戻されます。確認リンクもパスワードリセットと同じインメモリストアと `log` ドライバのメール設定を使うので、開発環境では設定なしで動作確認できます。`--verify` は登録フローの上に載るので、デフォルト(非 `--minimal`)の構成が前提です。

### OAuth ログインボタン

`--oauth` にカンマ区切りのプロバイダー名を渡すと、ログインページ(および `--minimal` でない限り登録ページにも)に「Continue with GitHub / Google / Discord」ボタンをスキャフォールドします。

```bash
bunx guren make:auth --install --oauth github,google
```

これで、プロバイダーごとの `githubId` / `googleId` カラムが `users` テーブルに追加されます。あわせて、各プロバイダーのクライアントID・シークレット・リダイレクトURIがすべて設定されている場合にのみ共有の `OAuthManager` へ登録する `OAuthProvider`(環境変数名は後述の[OAuth / ソーシャルログイン](#oauth-ソーシャルログイン)を参照)と、`redirectToProvider` / `callback` アクションを持つ `OAuthController` が生成されます。コールバックはプロバイダーIDでユーザーを検索します。同じメールアドレスの既存アカウントへ自動で紐付けることはせず(そのアカウントは作成時の方法でサインインしてもらいます)、それ以外の場合は**パスワードを持たない**アカウントを作成してからログインさせます。サインアップ時にハッシュ計算は発生せず、生成される `users.passwordHash` カラムも nullable のままです。プロバイダーがそのアドレスを未検証と報告している場合(Google の `email_verified`、Discord の `verified`)は、アカウント作成を拒否します。メールアドレスが返ってきたことは「プロバイダーが検証済みである」という保証にはならず、未検証のまま作成すると、所有していないアドレスを名乗れてしまうからです。すでに紐付け済みのアカウントは、あとからプロバイダー側の状態が変わっても影響を受けません。`--verify` と違い、`--oauth` は `--minimal` と併用できます。登録スキャフォールドに依存しないためです。

`--verify` を伴わない `--oauth` では、プロフィールのメールアドレスが**読み取り専用**でスキャフォールドされます。`ProfileUpdateSchema` からフィールドが除かれ、`ProfileController.update()` もメールアドレスを受け取らないので、フォームからも、直接組み立てたリクエストからも、プロバイダーが保証したアドレスからアカウントを移すことはできません。`--verify` を併用した場合は編集可能なままです。変更後のアドレスは `emailVerifiedAt` がリセットされ、そのアドレス宛のリンクで確認するまで検証済みになりません。なお、どのモードでもアドレスは「主張」されるだけで、予約されるわけではありません。登録フォームは形式が正しいメールアドレスをすべて受け付け、`users.email` は一意制約を持つので、すでにそのアドレスを保持しているアカウントがあると、本来の持ち主の初回 OAuth サインインは拒否されます。これが問題になるアプリでは、独自の所有確認を追加してください。

`--oauth` は、`OAuthController` / `OAuthProvider` のファイルパスと配線方法を下記の `guren add oauth` と共有しています(違いは、コールバックがスタブではなく完成された実装である点だけです)。同じアプリに対して両方を実行しないでください。2回目の実行は、`--force` なしなら失敗し、`--force` ありなら1回目の生成物を上書きします。

### OAuth のみでサインインする

`--oauth` だけを付けると、パスワードログインも同時に生成されます。パスワードログインを完全に外すには `--oauth-only` を付けます。

```bash
bunx guren make:auth --install --oauth github --oauth-only
```

`/login` は資格情報フォームを持たない、プロバイダーボタンだけのページになり、`POST /login` ルートは生成されません。`LoginController` は `show()` とログアウト用の `destroy()` だけになります。新規登録・パスワードリセット・ログインページとプロフィールページのパスワード欄・`LoginValidator`、そしてデモ用の `UsersSeeder` はすべてスキップされます(サインインに使えないパスワードをシードしても意味がないためです)。`--oauth-only` はプロバイダーを1つ以上指定した `--oauth` が前提で(そうでなければサインイン手段のないアプリになります)、`--minimal` の効果を含みます。`--verify` は無視されます。プロバイダー経由のメールアドレスは、すでに検証済みとして扱えるためです。

`--verify` なしの `--oauth` と同じく、このモードでもプロフィールのメールアドレスは読み取り専用です(詳細は上記を参照)。

`make:auth` は生成するファイルを書き込むだけで、削除はしません。そのため、既存のパスワード認証アプリを `--oauth-only --force` で変換すると、旧来の登録・リセット関連ファイルがディスク上に残ります(スキャフォールドが一覧を表示します)。これらは削除してください。特に残った `db/seeders/UsersSeeder.ts` は、ルートテーブルではなく `db:seed` から拾われるので、`routes/auth.ts` を書き換えただけでは無効になりません。

Cloudflare Workers の無料プランのように CPU 時間が課金・制限される実行環境では、どのハッシュアルゴリズムを選んでもパスワードハッシュ1回でリクエストあたりの CPU 予算を超えるので、この構成をおすすめします。

## OAuth / ソーシャルログイン

Guren には GitHub / Google / Discord 向けの OAuth プリセットが最初から用意されています。単体で使える低レベルなスキャフォールドです。`make:auth` のログイン・登録ページに直接組み込まれ、アカウント作成まで自動化された OAuth ボタンが欲しい場合は、上記の[OAuth ログインボタン](#oauth-ログインボタン)を参照してください。

### OAuth スキャフォールド

```bash
bunx guren add oauth
```

次のファイルが生成されます。

- `app/Providers/OAuthProvider.ts`
- `app/Http/Controllers/Auth/OAuthController.ts`
- `routes/oauth.ts`

あわせて、`src/app.ts` に `CoreOAuthServiceProvider` と `OAuthProvider` が自動登録されます。

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

`redirectToProvider` は state を生成し、プロバイダーの同意画面へリダイレクトします。  
`callback` は state を検証し、authorization code を token に交換してプロフィールを取得します。

### ログイン後リダイレクト(`redirectTo`)

フロー開始時に `redirectTo` を渡すと、コールバック後にサニタイズ済みの値として受け取れます。スキャフォールドされた `OAuthController`(`this.oauth()` でマネージャーを解決)なら、次のように書けます。

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

`redirectTo` は、フローの入口と出口の両方でオープンリダイレクト対策の検証を通ります。デフォルトで通過するのはアプリ相対パス(`/settings`)だけです。プロトコル相対URL(`//evil.com`)、バックスラッシュ変種、http(s) 以外のスキーム、許可リスト外のホストは破棄され、`redirectTo` は `undefined` になってフォールバックが適用されます。

特定の外部ホストを許可する場合(ワイルドカード対応)は、マネージャーが解決される前に許可リスト付きでバインドします。スキャフォールドアプリなら、`app/Providers/OAuthProvider.ts` の `register()` 冒頭に次を書きます。

```ts
this.container.singleton('oauth', () =>
  createOAuthManager({
    stateConfig: { allowedRedirectHosts: ['accounts.example.com', '*.example.org'] },
  }),
)
```

> **Note:** `createRedirectSafetyMiddleware`(オプトイン)は、独自の `allowedHosts` オプションで `Location` ヘッダーを検証します。併用する場合は両方の許可リストを揃えてください。ずれていると、許可したはずの外部リダイレクトがミドルウェアに `/` へ書き換えられます。

### 手動セットアップ

手動で設定したい場合や、一部だけ設定済みの環境では `--install` フラグを省略します。

```bash
bunx guren make:auth
```

そのあと、手動で次を行います。
1. `src/app.ts` に `AuthProvider` を登録
2. ミドルウェアスタックに `createSessionMiddleware` を追加(`AuthServiceProvider` がデフォルトで自動追加。不要ならオプトアウト)
3. `routes/web.ts` から `registerAuthRoutes(router)` を呼ぶ

`--install` フラグは安全かつ冪等で、既存の設定を重複させません。

## セッションの有効化

ガードはセッションに依存します。デフォルトでは `AuthServiceProvider` が `createSessionMiddleware` を自動で付与します。無効化やカスタマイズは、`createApp()` にオプションを渡して行います。

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

細かく制御したい場合は、`src/app.ts` で明示的に登録します。

```ts
import { createApp, createSessionMiddleware } from '@guren/core'

const app = createApp()
app.use('*', createSessionMiddleware())
```

`cookieSecure` は、セッション Cookie に `Secure` 属性を付けるかどうかを決めます。HTTPS のときだけ送信させる属性なので、本番では `true` にしてください。ローカル開発は `http://localhost` で動かすため、デフォルトは `false` です。

**Application の auth オプション**
- `autoSession`(デフォルト `true`): `createSessionMiddleware` を自動で付与します。
- `sessionOptions`(`createSessionMiddleware` にそのまま渡されます):
  - `cookieName`(デフォルト `guren.session`)
  - `cookieSecure`(本番は `true`、開発は `false` がデフォルト)
  - `cookieSameSite`(デフォルト `Lax`)
  - `cookieHttpOnly`(デフォルト `true`)
  - `cookieMaxAgeSeconds`(任意。指定がなければ `ttlSeconds` を使用)
  - `ttlSeconds`(デフォルト 2 時間)
  - `store`(デフォルトはメモリストア。複数インスタンス構成では独自実装に差し替えてください)。ストアそのものか、ストアを返す関数を受け取ります。関数は起動時ではなくリクエストごとに呼ばれます(`SessionManager` 側がメモ化します)。

### `SessionManager` でストアを選ぶ

`bunx guren add session` が生成するのは、`sessions` テーブルとそのマイグレーション、`database` ストアを宣言した `config/session.ts`、`SessionProvider`、`.env` と `.env.example` の `SESSION_DRIVER`、そして `sessions:prune` コマンドです。下の `redis` ストアだけは手で足す部分です。`@guren/core/redis` を import すると ioredis が全バンドルに入るので、必要になるまで scaffold は出しません。`guren add auth` はこれを内部で実行するので、生成直後のアプリは最初からデータベースに永続化されます。以下は、手で配線する場合のためにその生成物を説明したものです。

候補となるストアが複数あるなら、一度まとめて宣言して環境ごとに選びます。プロバイダの `register()` で `session` キーに `SessionManager` を bind すると、`AuthServiceProvider` は起動時にそれを組み込んだセッションミドルウェアを構築し、ストア自体は最初のリクエストで解決します。

```ts
import { createSessionManager, ServiceProvider, type SessionConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'
import { sessions } from '@/db/schema'

const sessionConfig: SessionConfig = {
  default: process.env.SESSION_DRIVER || 'database',
  ttlSeconds: 60 * 60 * 2,
  stores: {
    // 再起動・isolate・コールドスタートをまたいで残ります。接続は
    // `configureOrm()` が確立済みのもの(Postgres / MySQL / SQLite / D1)を使います。
    database: { driver: 'database', table: sessions },
    // `client` は関数でも構いません。このストアが最初に使われたときに実行されるので、
    // 宣言しただけで選ばれていないストアは接続を開きません。
    redis: { driver: 'redis', client: () => createRedisClient({ url: process.env.REDIS_URL }) },
    memory: { driver: 'memory' },
  },
}

export default class SessionProvider extends ServiceProvider {
  register(): void {
    this.container.instance('session', createSessionManager(sessionConfig))
  }
}
```

`createSessionManager()` は、`new SessionManager()` に `database` ドライバを登録したものです。このドライバはテーブルを ORM のモデルで包むので、ORM に依存しない HTTP 層ではなく `@guren/core` からしか出せません。`database` ストアを宣言するなら、常にこちらを使ってください。別の方法で組み立てたマネージャには、`registerDatabaseSessionDriver(manager)` でドライバを足せます。

#### `cookie` ストア

`{ driver: 'cookie' }` はセッション全体を cookie の中に置き、`APP_KEY` で暗号化します(AES-256-GCM。`APP_PREVIOUS_KEYS` も復号に使うので、鍵をローテーションしても全員がログアウトすることはありません)。**サーバ側のリソースを一切必要としない**唯一のストアで、テーブルもマイグレーションも Redis も Workers のバインディングも要りません。

```ts
stores: {
  cookie: { driver: 'cookie' },
}
```

できないことが3つあります。承知のうえで選んでください。

- **セッションの中身がすべて cookie に載る**ので上限があります。ミドルウェアは送出する `Set-Cookie` 全体(名前と属性を含む)を測り、`maxCookieBytes`(既定 4096、ブラウザが保持する値)を超えるとエラーにします。ブラウザが黙って捨てる cookie を出すよりはましだからです。セッション本体に使えるのは約2.9KBです。レコードはデータベースに置き、セッションにはその id だけを入れてください
- **ログアウトしても、クライアントがすでに複製した cookie は失効できません**。`invalidate()` はそのクライアントの cookie を消すだけで、複製は期限まで有効です。失効させる必要があるものはデータベースに置いてください
- **「全端末からログアウト」もセッション一覧もできません**。サーバ側に列挙できるものがないためです

`ttlSeconds` は意識して設定してください。サーバ側から cookie を早期に失効させる手段がないので、暗号化ペイロード自身の期限が唯一の上限になります。

`database` ドライバには、`db/schema.ts` の `sessions` テーブルとマイグレーションが要ります。列は `id`(text 主キー)・`data`・`expiresAt` の3つで、方言ごとの定義は [Cloudflare ガイド](./cloudflare.md#sessions-and-oauth-state-must-be-database-backed) にあります。期限切れ行は `manager.pruneExpired()` をスケジュール実行して掃除してください(`read()` は期限切れをすでに不在として扱います)。

マネージャ側の cookie と TTL 設定が基本になり、`auth.sessionOptions` がフィールド単位で上書きします。`auth.sessionOptions.store` とマネージャの両方を設定すると、どちらかを黙って選ぶのではなく起動時にエラーになります。`default` ストアのドライバが未登録の場合も同じく起動で失敗し、未宣言の `default` 名は構築時に失敗します。いずれの場合も、`SESSION_DRIVER` の typo は最初のログインではなく起動で止まります。`memory` は常に宣言済みなので、`SESSION_DRIVER=memory` はエントリなしで動きます。マネージャは `boot()` ではなく `register()` で bind してください。`AuthServiceProvider` はアプリのプロバイダより先に boot します(deferred provider は例外で、最初のリクエストで起動されます)。プラグイン側は、`SessionDrivers` インターフェースを augmentation で拡張し、`manager.registerDriver(name, factory)` を呼べばドライバを追加できます。解決は遅延なので、プラグインの `register()` が設定の宣言より後に走っても構いません。

> [!WARNING]
> Cloudflare Workers、AWS Lambda、Vercel ではリクエスト間でメモリを共有しないので、デフォルトの `MemorySessionStore` はログイン直後のリクエストでセッションを失います。ミドルウェアはその状況を検出するとプロセスごとに一度警告し、`guren check` とデプロイビルドは事前に警告します。

## プロバイダーとガードの設定

### `auth.useModel()` ショートハンドの使用（推奨）

認証を設定する一番シンプルな方法は `auth.useModel()` ヘルパーです。`ModelUserProvider` と `SessionGuard` を一度に登録できます。

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

このメソッド呼び出しで、次が行われます。
- 指定されたカラムで `ModelUserProvider` を登録
- 適切なセッション処理を備えた `SessionGuard` を作成
- デフォルトガードを 'web' に設定
- `createApp({ auth: { hasher } })` で選んだハッシャーを使用。既定は scrypt です（[パスワードハッシャー](#パスワードハッシャー)を参照）

### パスワードハッシャー

アプリが書き込むパスワードは、`AuthenticatableModel` が `create()` でハッシュ化する場合も、セッションガードがログイン時に再ハッシュする場合も、同じひとつのハッシャーを通ります。選ぶ場所は `createApp()` の 1 か所です。

```ts
const app = createApp({
  auth: {
    hasher: 'scrypt', // 既定値
  },
})
```

- `'scrypt'`（既定）は `node:crypto` で `$scrypt$` 形式のハッシュを書きます。Bun、Node、Lambda、Workers のどのランタイムでも検証できます。
- `'argon2'` は `Bun.password` で Argon2id を書きます。Bun で動かし続けるデプロイにだけ選んでください。`Bun.password` のないランタイムでは `createApp()` が例外を投げます。
- `PasswordHasher` オブジェクトを渡すと、組み込みのハッシャーを丸ごと置き換えます。

検証はこの設定ではなく、保存されたハッシュの形式で振り分けます。両方の形式が混在したカラムもそのまま動きます。別形式の行（scrypt が既定になる前のリリースが Bun で書いた Argon2id など）は、そのユーザーが次にログインに成功したときに再ハッシュされます。ログインしない行は形式がそのまま残り、`Bun.password` のないランタイムでは Argon2id の行を検証できません。Node や Workers へ移す前に、アプリが Bun で動いているうちにカラムを移行するか、該当ユーザーのパスワードをリセットしてください。

### 手動設定（上級者向け）

カスタムプロバイダーやガードが要る場合は、手動で設定できます。

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

後述の `AuthenticatableModel` を併用すると、パスワードのハッシュ化と検証ヘルパーが自動で付きます。

### 認証可能モデル

`AuthenticatableModel` を継承したモデルには、パスワード処理が組み込まれます。`create` や `update` に平文 `password` を渡すと自動でハッシュ化し、`passwordHash` カラム(静的プロパティで変更可)に保存します。平文は保持せず、認証にはプロバイダーと同じアルゴリズムを使います。

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

`AuthenticatableModel` を `base` に渡し、同じ呼び出しで create のペイロードを整えます。`defineModel()` がテーブルから推論する型は、デフォルト値のない全カラムを必須にしますが、ここではそれが正しい形ではありません。呼び出し側が渡すのは平文の `password` で、`passwordHash` ではないからです。`optionalOnCreate` がカラムを任意にし、`requireOnCreate` が仮想フィールドを必須にします。どちらも型レベルの指定なので、キャストも型マーカーの再宣言も要りません。

任意にするだけなので、呼び出し側が `passwordHash` を渡しても型としては通ります。ランタイムでは `AuthenticatableModel` が、ハッシュカラム(とリメンバートークン)を一括代入から常に拒否します。リクエストボディにこれらが含まれると、モデルの `fillable` の内容に関わらず `MassAssignmentException` がスローされます。`passwordHash: 'oauth:...'` のような信頼できるサーバーサイドの値には、`forceCreate()` / `forceUpdate()` を使ってください。

OAuth 専用のサインアップなど、パスワードなしでアカウントが作られる場合は `requireOnCreate` を付けず、`password` を任意のままにします。

資格情報カラムにパスワードハッシュ以外の値が入っている場合、それはそのアカウントがパスワードで認証できないという意味です。`ModelUserProvider` は null、空文字列、`'oauth:...'` のような番兵を同じ扱いにします。ログインを拒否し、実際の検証と同じだけのハッシュ計算を行うので、応答時間からも判別できません。一方、ハッシュ形式を名乗っていて内容がそれを満たさない値は、これまでどおりスローします。カラムの破損や切り詰めであり、黙って拒否すると気付く手がかりがなくなるためです。パスワードを持たないアカウントには nullable なカラムのほうが明快で、`make:auth --oauth` はそちらを生成します。

既定の `AuthServiceProvider` は、`users` プロバイダーを使う `web` ガードを自動登録します。追加のガード(例: トークンベース API)が要るなら、`context.auth.registerGuard('api', factory)` を呼び、必要に応じて `context.auth.setDefaultGuard('api')` で既定を差し替えます。

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

バリデーションには、`this.validateBody()` / `this.validateQuery()` / `this.validateParams()` を Zod スキーマと組み合わせて使います。`FormRequest` は互換用途に限定してください。

Inertia の全ページでログインユーザーを共有する配線は、スキャフォルドが済ませています。`bunx guren add auth`(= `bunx guren make:auth --install`)が生成する `app/Providers/AuthProvider.ts` の `boot()` に次の登録が入っているので、生成直後から全ページの props で `auth.user` を読めます。生成されるレイアウトが **Sign in** と **Log out** を出し分けているのも、この props です。

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

このように `auth.user()` を共有する方法は、デフォルトで安全です。レコードは認証レイヤーを出る前にサニタイズされるので、パスワードハッシュがブラウザに届くことはありません(後述の「サニタイズされたユーザーレコード」を参照)。

`InertiaSharedProps` を拡張して、React 側でも型を付けてください(詳細はコントローラーガイドを参照)。

> `shareInertiaProps` は先に登録されたリゾルバーの props にマージするので、
> auth・i18n・flash など複数箇所から共有 props を足しても互いを壊しません。
>
> ```ts
> shareInertiaProps((ctx) => ({ i18n: { locale: detectLocale(ctx) } }), this.container)
> ```
>
> `this.container` を渡すと、その props は1つのアプリケーションに閉じます。渡さ
> ない場合はプロセス全体で共有され、同時に起動した別のアプリケーションにも
> 漏れます。
>
> `setInertiaSharedProps` はマージせずプロセス全体のリゾルバーを置き換えるので、
> 実行時点で登録済みのものを丸ごと捨てます。意図的に全部を差し替えたいときだけ
> 使ってください。

ルートミドルウェアを使えば、保護は簡単です。

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

- `auth.check()`: 認証済みなら `true`。
- `auth.user()`: 現在のユーザーレコード(または `null`)。パスワードハッシュ・remember トークン・モデルの `hidden` フィールドを除いた、サニタイズ済みのレコードを返します。
- `auth.userOrFail()`: 現在のユーザーを返し、未認証なら `AuthenticationException`(401)をスロー。ルートが保護されていると分かっている場合、null チェックを省けます。
- `auth.login(user, remember?)`: 指定ユーザーでログインし、任意で remember トークンを発行。
- `auth.attempt(credentials, remember?)`: 資格情報を検証し、成功したらログイン。
- `auth.logout()`: セッションと remember トークンをクリア。

## サニタイズされたユーザーレコード

`auth.user()`(および `login()` / `attempt()` 直後にキャッシュされるユーザー)が資格情報を露出することはありません。`ModelUserProvider` が、レコードが認証レイヤーを出る前に、パスワードカラム・remember トークンカラム・モデルが `hidden` に指定したフィールドを取り除きます。

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

`make:auth` スキャフォルダーは、この `hidden` 設定を含むユーザーモデルを最初から生成します。オプションと、引き続き使える `static hidden = [...]` の書き方については[フィールドの非表示](./database.md#フィールドの非表示)を参照してください。

資格情報の検証は内部で生のデータベースレコードに対して行われるので、ログインや remember me の動作には影響しません。サニタイズが変えるのは、`auth.user()` がアプリケーションコードに公開する内容だけです。

カスタムのユーザープロバイダーは、`UserProvider` インターフェースのオプションメソッド `sanitize(user)` を実装すればオプトインできます。`SessionGuard` は、ユーザーをキャッシュして返す前にこのメソッドを呼びます。

```ts
sanitize(user: AuthUser): AuthUser {
  const { passwordHash, ...safe } = user
  return safe as AuthUser
}
```

### サニタイズ済みユーザーの型付け

サニタイズはランタイムの処理なので、単に `auth.user<UserRecord>()` と書くと、実際には取り除かれている資格情報フィールドが型の上では残ります。`Sanitized<T>` ヘルパーを使えば、慣例的な資格情報キーを型からも取り除けます。

```ts
import type { Sanitized } from '@guren/core'

// password / passwordHash / rememberToken 系のキーを型から除去
const user = await this.auth.userOrFail<Sanitized<UserRecord>>()

user.email        // ✅ string
user.passwordHash // ❌ コンパイルエラー — ランタイムで除去済み
```

モデルの `hidden` で追加のフィールドを隠している場合や、資格情報カラムが慣例名(`password`、`passwordHash`、`password_hash`、`rememberToken`、`remember_token`)でない場合は、第2型引数に列挙します。

```ts
type SafeUser = Sanitized<UserRecord, 'twoFactorSecret' | 'credentialDigest'>
```

ランタイムが除去するのは「プロバイダーに設定されたカラム + モデルの `hidden` フィールド」そのものです。静的型はこの設定を参照できないので、`Sanitized<T>` は慣例名だけを反映し、それ以外は第2型引数での指定に委ねます。`hidden` から漏れている機微カラムは `guren audit` が警告するので、ランタイム側の正しさはそちらで担保できます。

## Remember トークン

`SessionGuard` は remember トークンを自動で管理します。ユーザープロバイダーが `setRememberToken` / `getRememberToken` を実装していれば動き、`ModelUserProvider` は `rememberTokenColumn` を指定すると対応します。

## 実例アプリ

ブログの例には、認証機能一式が入っています。

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
