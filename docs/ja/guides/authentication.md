# 認証ガイド

Guren には Laravel をもとにした認証の仕組みが組み込まれていて、セッションミドルウェアと ORM の上で動きます。ガードとユーザープロバイダーは、TypeScript と Bun で使いやすい形にしてあります。

## 基本概念

- **AuthManager**: ガードとユーザープロバイダーを登録しておく場所です。アプリケーションインスタンスの `app.auth`、またはサービスプロバイダー内の `context.auth` から使います。
- **ガード**: リクエストを認証する実行時のオブジェクトです。既定の `SessionGuard` はセッションにユーザー ID を保持し、必要なら「ログイン状態を保持する」ための remember トークンも扱います。
- **ユーザープロバイダー**: ガードがユーザーを読み込んだり検証したりするためのデータアクセス層です。`ModelUserProvider` は Guren の `Model` に対応しているので、Drizzle のテーブルをそのまま認証に使えます。
- **Auth コンテキスト**: リクエストごとの窓口で、`auth.check()`, `auth.user()`, `auth.login()` などのヘルパーを持ちます。`AuthServiceProvider` が自動で取り付け、コントローラーでは `this.auth`、ミドルウェアでは `attachAuthContext` 経由で使えます。
- **OAuthManager**: ソーシャルログイン用のヘルパーです。OAuth の state の管理、コードの交換、プロフィールの取得を扱います。

## CLI でクイックスタート

新しいアプリでは、`--install` を付けて雛形生成コマンドを実行します（セッションミドルウェアはデフォルトで自動的に付きます）。

```bash
bunx guren make:auth --install
```

このコマンドは、ログイン・登録・パスワードリセットのコントローラー、Inertia ページ、レイアウト、`AuthProvider`、`config/mail.ts`、ユーザーモデル、SQL マイグレーション、デモ用のシーダーを生成します。`--install` フラグを付けると、次の 4 つも自動で行われます。

1. `Application` の providers 配列に `AuthProvider` を登録し、config 配列にメールの定義を追加する
2. 開発環境向けの設定で `createSessionMiddleware` を追加する（本番では `cookieSecure: true`）
3. `routes/web.ts` から `registerAuthRoutes(router)` を呼ぶようにする
4. `db/schema.ts` にパスワードと remember トークンのカラムを追加する

`guren add mail` や独自のプロバイダーでメールをすでに設定しているアプリでは、その設定をそのまま使います。この場合、`make:auth` は `config/mail.ts` を生成せず、メール関連の登録も行いません。リセットメールは既存の設定を通じて送られます。`make:auth` の後で `guren add mail` を実行した場合も、auth が書いた設定は残り、サンプルの Mailable だけが追加されます。

雛形を生成したら、あとは次のコマンドを実行するだけです。

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

`http://localhost:3000/login` を開くと、`demo@example.com` / `secret` でログインできます。新しいアカウントは `/register` から作れます。

登録とパスワードリセットを省いて、ログインだけを生成したい場合は `--minimal` を付けます。

```bash
bunx guren make:auth --install --minimal
```

### パスワードリセット

ログインページの「Forgot your password?」を押すと、`ForgotPasswordController` と `ResetPasswordController` が扱うリセットの流れに入ります。内部では、フレームワークの `createPasswordResetToken` / `completePasswordReset` を使っています。リセットトークンは、生成される `app/Auth/PasswordResetStore.ts` に保存されます。これはインメモリのストアなので、本番や複数インスタンスの構成では Redis ベースのストアに差し替えてください。メールは、同じく生成される `config/mail.ts` を通じて送られます。`config/mail.ts` はデフォルトで `log` ドライバを使うので、リセットリンクはコンソールに出力され、開発環境では何も設定せずに動作を確認できます。実際にメールを送るには、`MAIL_MAILER=smtp`（と `SMTP_*` の環境変数）を設定してください。

### メール確認

`--verify` を付けると、メール確認の流れも一緒に生成されます。

```bash
bunx guren make:auth --install --verify
```

`users` テーブルに `emailVerifiedAt` カラムが追加され、`VerifyEmailController`（「メールを確認してください」の案内の表示、再送、トークンの確認を担当）と `VerifyEmail` ページが生成されます。登録すると確認メールが送られ、`/dashboard` ではなく `/verify-email` にリダイレクトされるようになります。生成される `/dashboard` ルートには `requireVerifiedEmail` が付くので、確認を済ませていないユーザーは、確認が終わるまで `/verify-email` に戻されます。確認リンクも、パスワードリセットと同じインメモリのストアと `log` ドライバのメール設定を使うので、開発環境では何も設定せずに動作を確認できます。`--verify` は登録の仕組みを前提にしているので、デフォルト（`--minimal` なし）の構成で使ってください。

### OAuth ログインボタン

`--oauth` にカンマ区切りでプロバイダー名を渡すと、ログインページに「Continue with GitHub / Google / Discord」のボタンが生成されます（`--minimal` でなければ登録ページにも付きます）。

```bash
bunx guren make:auth --install --oauth github,google
```

このオプションを付けると、プロバイダーごとの `githubId` / `googleId` カラムが `users` テーブルに追加されます。あわせて、次の 2 つが生成されます。

- `config/oauth.ts` の定義。`OAUTH_<PROVIDER>_CLIENT_ID`・`_CLIENT_SECRET`・`_REDIRECT_URI` がすべて設定されているプロバイダーだけを `OAuthManager` に登録します（キーはコマンドが `config/env.ts` に宣言します。後述の[OAuth / ソーシャルログイン](#oauth-ソーシャルログイン)を参照）
- `redirectToProvider` / `callback` アクションを持つ `OAuthController`

コールバックは、プロバイダーの ID でユーザーを探します。同じメールアドレスの既存アカウントに自動で紐付けることはしません（そのアカウントには、作成したときの方法でサインインしてもらいます）。どちらにも当てはまらなければ、**パスワードを持たない**アカウントを作ってログインさせます。サインアップのときにハッシュの計算は発生せず、生成される `users.passwordHash` カラムも nullable のままです。

プロバイダーがそのアドレスを未検証と報告している場合（Google の `email_verified`、Discord の `verified`）は、アカウントの作成を拒否します。メールアドレスが返ってきたからといって、プロバイダーが検証済みだという保証にはなりません。未検証のまま作成すると、自分のものではないアドレスを名乗れてしまいます。すでに紐付け済みのアカウントは、あとからプロバイダー側の状態が変わっても影響を受けません。`--oauth` は登録の雛形に依存しないので、`--verify` と違って `--minimal` と一緒に使えます。

`--verify` を付けずに `--oauth` を使うと、プロフィールのメールアドレスは**読み取り専用**で生成されます。`ProfileUpdateSchema` からフィールドが除かれ、`ProfileController.update()` もメールアドレスを受け取らないので、フォームからでも、手で組み立てたリクエストからでも、プロバイダーが保証したアドレスからアカウントを付け替えることはできません。`--verify` も付けた場合は、メールアドレスを編集できます。その場合、変更後のアドレスは `emailVerifiedAt` がリセットされ、そのアドレスに届いたリンクで確認するまで検証済みになりません。

なお、どのモードでも、アドレスは名乗られるだけで、誰かのために確保されるわけではありません。登録フォームは形式が正しいメールアドレスならすべて受け付け、`users.email` には一意制約があります。そのため、あるアドレスをすでに別のアカウントが使っていると、本来の持ち主が初めて OAuth でサインインしようとしても拒否されます。これが問題になるアプリでは、アドレスの所有を確かめる仕組みを独自に追加してください。

コールバックを認可リダイレクトと結びつける OAuth の state は、データベースに保存します。`--oauth` は `db/schema.ts` に `oauth_states` テーブルを追加し、`users` や `sessions` と同じマイグレーションに含めます。`config/oauth.ts` は `DatabaseOAuthStateStore` を `stateStore` に渡し、`--install` がその定義を `createApp({ config })` に追加します。これで、リダイレクトとコールバックが別々のプロセスに届いても動きます。Workers、Lambda、Vercel ではそれがふつうです（[Stateストレージ](./oauth.md#stateストレージ)を参照）。`db/schema.ts` がないアプリでは `stateStore` のない定義が生成され、state はプロセスのメモリに置かれます。

この定義の形で生成されるのは、`config/env.ts` があり、`oauth` を束縛するプロバイダがない場合です。それ以外の場合は、同じ内容を登録する `app/Providers/OAuthProvider.ts` を生成し、そちらを登録します（`db/schema.ts` がなければ `CoreOAuthServiceProvider` も登録します）。OAuth をサービスプロバイダで設定しているアプリも、そのまま動きます。詳しくは[サービスプロバイダを使うアプリ](./configuration.md#サービスプロバイダを使うアプリ) を参照してください。

`--oauth` は、`OAuthController` と `config/oauth.ts` のファイルパス、そして state をデータベースに保存する仕組みを、後述の `guren add oauth` と共有しています。違うのは、コールバックがスタブではなく完成した実装になっている点だけです。同じアプリで両方を実行しないでください。2 回目の実行は、`--force` がなければ失敗し、`--force` があれば 1 回目に生成したファイルを上書きします。

### OAuth のみでサインインする

`--oauth` だけを付けた場合は、パスワードでのログインも一緒に生成されます。パスワードでのログインを完全になくすには、`--oauth-only` を付けます。

```bash
bunx guren make:auth --install --oauth github --oauth-only
```

`/login` は資格情報の入力欄がない、プロバイダーのボタンだけのページになり、`POST /login` ルートは生成されません。`LoginController` にあるのは `show()` とログアウト用の `destroy()` だけになります。新規登録、パスワードリセット、ログインページとプロフィールページのパスワード欄、`LoginValidator`、デモ用の `UsersSeeder` は、どれも生成されません（サインインに使えないパスワードをシードしても意味がないためです）。`--oauth-only` を使うには、プロバイダーを 1 つ以上指定した `--oauth` が必要です（そうしないと、サインインする手段のないアプリになります）。`--oauth-only` には `--minimal` の効果も含まれます。プロバイダーから得たメールアドレスはすでに検証済みとして扱えるので、`--verify` は無視されます。

`--verify` なしの `--oauth` と同じく、このモードでもプロフィールのメールアドレスは読み取り専用です（詳しくは上を参照）。

`make:auth` はファイルを書き込むだけで、削除はしません。そのため、パスワード認証を使っている既存のアプリを `--oauth-only --force` で変換すると、以前の登録やリセット関連のファイルがディスク上に残ります（生成時に一覧が表示されます）。これらは削除してください。特に、残った `db/seeders/UsersSeeder.ts` はルートテーブルではなく `db:seed` から読み込まれるので、`routes/auth.ts` を書き換えただけでは無効になりません。

Cloudflare Workers の無料プランのように CPU 時間で課金や制限がかかる実行環境では、この構成をおすすめします。どのハッシュアルゴリズムを選んでも、パスワードを 1 回ハッシュするだけで 1 リクエストあたりの CPU の上限を超えてしまうためです。

### ワンタイムトークンのストア

パスワード再設定とメール認証では、ストアの操作をアトミックに実行します。`replace()` は、そのメールアドレスの既存トークンの失効と新しいトークンの保存を一度に行います。`consume(tokenId, email)` は、保存済みのメールアドレスとの照合とトークンの削除を一度に行い、同時に呼ばれても成功を示す `true` を返すのは 1 回だけです。メモリ版と Redis 版のストアは、どちらもこの 2 つを実装しています。発行時は、メールアドレスを小文字にそろえてから置き換えます。

独自の `PasswordResetTokenStore` や `EmailVerificationTokenStore` を使っている場合は、発行・完了のヘルパーを使う前に、これらのメソッドを追加してください。パスワード再設定のストアは `replace(tokenId, email, expiresAt)`、メール認証のストアは `replace(token)` を受け取ります。型の互換性のためにメソッドは省略可能になっていますが、必要な操作が実装されていなければ、ヘルパーはエラーにします。複数のワーカーで共有するストアでは、プロセス内のロックだけでは足りません。トランザクションや、データベースのアトミックなコマンドで実装してください。

`completePasswordReset()` と `completeEmailVerification()` は、アプリの更新処理を呼ぶ前にトークンを消費します。消費したトークンは元に戻らないので、更新に失敗したときはトークンを再発行してください。`verifyPasswordResetToken()` と `verifyEmailToken()` は有効かどうかを確かめるだけで、トークンを予約したり消費したりはしません。更新には完了用のヘルパーを使ってください。生成済みのパスワード再設定コントローラーで検証・更新・削除を別々に呼んでいる場合は、`completePasswordReset()` に置き換えてください。その際は `@guren/core` と `@guren/cli` を一緒に更新し、トークンを発行・消費するすべてのインスタンスを再起動してください。古いインスタンスには、同時実行の問題が残ります。

## OAuth / ソーシャルログイン

Guren には、GitHub / Google / Discord 向けの OAuth のプリセットが最初から用意されています。ここで説明するのは、単体で使える低レベルな雛形です。`make:auth` のログインページや登録ページに組み込まれ、アカウントの作成まで自動で行う OAuth ボタンが必要な場合は、上の[OAuth ログインボタン](#oauth-ログインボタン)を参照してください。

### OAuth スキャフォールド

```bash
bunx guren add oauth
```

次のファイルが生成されます。

- `config/oauth.ts`
- `app/Http/Controllers/Auth/OAuthController.ts`
- `routes/oauth.ts`

あわせて、`config/oauth.ts` の定義が `createApp({ config })` に追加されます。`oauth` マネージャーを束縛するのはこの定義です。中身は [OAuth ガイド](./oauth.md#マネージャーの登録)で説明しています。

`db/schema.ts` には `oauth_states` テーブルが追加され、そのマイグレーションも生成されます。`drizzle-kit` をまだインストールしていない場合は、あとで `bun run db:make` を実行してください。`oauth-states:prune` コマンドも登録されます。`config/oauth.ts` は `DatabaseOAuthStateStore` を `stateStore` に渡すので、認可リダイレクトを発行したのとは別のプロセスにコールバックが届いても動きます。Workers、Lambda、Vercel ではそれがふつうです（[Stateストレージ](./oauth.md#stateストレージ)を参照）。`CoreOAuthServiceProvider` は state をメモリ上に持つので、登録しません。`db/schema.ts` がないアプリでは、何も書き込まずにエラーで終了します。

[`--oauth`](#oauth-ログインボタン) と同じく、`config/env.ts` がないアプリや、すでにプロバイダが `oauth` を束縛しているアプリでは、同じ内容とストアを登録する `app/Providers/OAuthProvider.ts` が生成されます。

### プロバイダー資格情報の設定

コマンドはプロバイダーごとに 3 つのキーを `config/env.ts` に宣言し、値を空にして `.env` にも追加します。

```bash
OAUTH_GITHUB_CLIENT_ID=...
OAUTH_GITHUB_CLIENT_SECRET=...
OAUTH_GITHUB_REDIRECT_URI=https://your-app.test/auth/github/callback
```

`GOOGLE` / `DISCORD` にも同じ形のキーがあります。プロバイダーが登録されるのは、3 つのキーがすべて設定されたときだけです。

### ルートフロー

```ts
router.get('/auth/:provider', [OAuthController, 'redirectToProvider'])
router.get('/auth/:provider/callback', [OAuthController, 'callback'])
```

`redirectToProvider` は state を生成し、プロバイダーの同意画面にリダイレクトします。  
`callback` は state を検証してから、authorization code を token に交換し、プロフィールを取得します。

### ログイン後リダイレクト(`redirectTo`)

フローの開始時に `redirectTo` を渡しておくと、コールバックの後でサニタイズ済みの値として受け取れます。生成された `OAuthController`（`this.oauth()` でマネージャーを取得）なら、次のように書けます。

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

`redirectTo` は、フローの入口と出口の両方で、オープンリダイレクトを防ぐための検証を受けます。デフォルトで通るのは、アプリ内の相対パス（`/settings`）だけです。プロトコル相対 URL（`//evil.com`）、バックスラッシュを使った変形、http(s) 以外のスキーム、許可リストにないホストは捨てられ、`redirectTo` は `undefined` になってフォールバック先が使われます。

特定の外部ホストを許可したい場合（ワイルドカードも使えます）は、`config/oauth.ts` の `stateConfig` に並べます。定義の例は、OAuth ガイドの[ログイン後のリダイレクト](./oauth.md#ログイン後のリダイレクト)にあります。

> **Note:** オプトインの `createRedirectSafetyMiddleware` は、独自の `allowedHosts` オプションで `Location` ヘッダーを検証します。両方を使う場合は、2 つの許可リストをそろえてください。食い違っていると、許可したはずの外部リダイレクトがミドルウェアによって `/` に書き換えられます。

### 手動セットアップ

自分で設定したい場合や、一部だけ設定済みの環境では、`--install` フラグを付けずに実行します。

```bash
bunx guren make:auth
```

そのあと、次の作業を手で行います。
1. `src/app.ts` に `AuthProvider` を登録する
2. ミドルウェアのスタックに `createSessionMiddleware` を追加する（デフォルトでは `AuthServiceProvider` が自動で追加します。不要ならオプトアウトしてください）
3. `routes/web.ts` から `registerAuthRoutes(router)` を呼ぶ

`--install` フラグは冪等で、何度実行しても既存の設定を重複させません。

## セッションの有効化

ガードはセッションを使います。デフォルトでは `AuthServiceProvider` が `createSessionMiddleware` を自動で付けます。無効にしたり設定を変えたりするには、`createApp()` にオプションを渡します。

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

`cookieSecure` は、セッション Cookie に `Secure` 属性を付けるかどうかを決めます。`Secure` は HTTPS のときだけ Cookie を送らせる属性なので、本番では `true` にしてください。ローカル開発は `http://localhost` で動かすので、デフォルトは `false` になっています。

**Application の auth オプション**
- `autoSession`（デフォルト `true`）: `createSessionMiddleware` を自動で付けます。
- `sessionOptions`（`createSessionMiddleware` にそのまま渡されます）:
  - `cookieName`(デフォルト `guren.session`)
  - `cookieSecure`(本番は `true`、開発は `false` がデフォルト)
  - `cookieSameSite`(デフォルト `Lax`)
  - `cookieHttpOnly`(デフォルト `true`)
  - `cookieMaxAgeSeconds`（任意。指定しなければ `ttlSeconds` を使います）
  - `ttlSeconds`（デフォルトは 2 時間）
  - `store`（デフォルトはメモリストア。複数インスタンスの構成では独自の実装に差し替えてください）。ストアそのものか、ストアを返す関数を渡します。関数は起動時ではなくリクエストごとに呼ばれます（結果は `SessionManager` 側でメモ化されます）。

### `SessionManager` でストアを選ぶ

`bunx guren add session` を実行すると、次のものが生成されます。

- `sessions` テーブルとそのマイグレーション
- `database` と `cookie` のストアを宣言した `config/session.ts`
- `SESSION_DRIVER` キー（`config/env.ts` に `database` をデフォルトとして宣言し、`.env` と `.env.example` にも追加）
- `sessions:prune` コマンド

定義は `createApp({ config })` に追加されます。下の例のうち `redis` ストアだけは手で書き足す部分です。`@guren/core/redis` を import すると ioredis がすべてのバンドルに入るので、必要になるまで雛形には含めていません。`guren add auth` はこのコマンドを内部で実行するので、生成した直後のアプリでも、セッションは最初からデータベースに保存されます。以下は、手で組み込む場合に備えて、生成されるものを説明したものです。

[`--oauth`](#oauth-ログインボタン) と同じく、`config/env.ts` がないアプリや、すでにプロバイダが `session` を束縛しているアプリでは、プレーンな `SessionConfig` としての `config/session.ts` と、それを束縛する `app/Providers/SessionProvider.ts` が生成されます。

使う可能性のあるストアが複数あるなら、まとめて宣言しておき、環境ごとに選びます。`defineSessionConfig` が `session` キーに `SessionManager` を bind し、`AuthServiceProvider` は起動時に、それを組み込んだセッションミドルウェアを組み立てます。ストア自体は最初のリクエストのときに解決されます。

```ts
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'
import { sessions } from '../db/schema'

export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  ttlSeconds: 60 * 60 * 2,
  stores: {
    // 再起動・isolate・コールドスタートをまたいで残ります。接続は
    // `configureOrm()` が確立済みのもの(Postgres / MySQL / SQLite / D1)を使います。
    database: { driver: 'database', table: sessions },
    cookie: { driver: 'cookie' },
    // `client` は関数でも構いません。このストアが最初に使われたときに実行されるので、
    // 宣言しただけで選ばれていないストアは接続を開きません。
    redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) },
  },
}))
```

`REDIS_URL` は `config/env.ts` に宣言します。`@guren/core/redis` は ioredis を読み込むので、実際に使う設定ファイルでだけ import してください。定義は、データベースの定義と並べて登録します。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import session from '../config/session.js'

const app = createApp({
  env,
  config: [database, session],
})
```

`defineSessionConfig()` は、マネージャを `createSessionManager()` で組み立てます。`createSessionManager()` は、`new SessionManager()` に `database` ドライバを登録したものです。このドライバはテーブルを ORM のモデルで包むので、ORM に依存しない HTTP 層には置けず、`@guren/core` からしか提供できません。`database` ストアを宣言するときは、常にこちらを使ってください。別の方法で組み立てたマネージャには、`registerDatabaseSessionDriver(manager)` でドライバを追加できます。

#### `cookie` ストア

`{ driver: 'cookie' }` は、セッション全体を cookie の中に入れ、`APP_KEY` で暗号化します（AES-256-GCM。`APP_PREVIOUS_KEYS` も復号に使うので、鍵をローテーションしても全員がログアウトすることはありません）。**サーバ側のリソースをまったく必要としない**唯一のストアで、テーブルもマイグレーションも Redis も Workers のバインディングもいりません。

```ts
stores: {
  cookie: { driver: 'cookie' },
}
```

このストアにはできないことが 3 つあります。理解したうえで選んでください。

- **セッションの中身がすべて cookie に入る**ので、サイズに上限があります。ミドルウェアは送り出す `Set-Cookie` 全体（名前と属性を含む）の大きさを測り、`maxCookieBytes`（既定は 4096。ブラウザが保持できる大きさ）を超えるとエラーにします。ブラウザに黙って捨てられる cookie を出すよりはよいからです。セッション本体に使えるのは約 2.9KB です。レコードはデータベースに置き、セッションにはその id だけを入れてください
- **ログアウトしても、クライアントがすでに複製した cookie は失効させられません**。`invalidate()` が消すのはそのクライアントの cookie だけで、複製は期限まで有効なままです。失効させる必要があるものはデータベースに置いてください
- **「すべての端末からログアウト」も、セッションの一覧表示もできません**。サーバ側に列挙できるものがないためです

`ttlSeconds` はよく考えて設定してください。サーバ側から cookie を期限前に失効させる手段がないので、暗号化したペイロード自身の有効期限が唯一の上限になります。

`database` ドライバを使うには、`db/schema.ts` の `sessions` テーブルとそのマイグレーションが必要です。カラムは `id`（text の主キー）・`data`・`expiresAt` の 3 つで、方言ごとの定義は [Cloudflare ガイド](./cloudflare.md#セッションと-oauth-state-はデータベースに保存する) にあります。期限切れの行は、`manager.pruneExpired()` を定期的に実行して片付けてください（`read()` は期限切れの行をすでに存在しないものとして扱います）。

マネージャ側の cookie と TTL の設定が基本になり、`auth.sessionOptions` がそれをフィールドごとに上書きします。次の設定ミスは起動時にエラーになるので、`SESSION_DRIVER` の打ち間違いも最初のログインより前に見つかります。

- `auth.sessionOptions.store` とマネージャの両方を設定した（どちらかを黙って選ぶことはしません）
- `default` のストアのドライバが登録されていない
- `default` の名前が `stores` に宣言されていない（`AuthServiceProvider` がマネージャを組み立てる時点で検出します）

`memory` は常に宣言済みなので、`SESSION_DRIVER=memory` はエントリを書かなくても動きます。マネージャは、どのプロバイダの boot よりも前にバインドされます。詳しくは [config 定義](./configuration.md#config-定義) を参照してください。

プラグインがドライバを追加するときは、`SessionDrivers` インターフェースを augmentation で拡張し、`manager.registerDriver(name, factory)` を呼びます。ストアの解決は遅延して行われるので、プラグインの `register()` が設定の宣言より後に実行されても問題ありません。

> [!WARNING]
> Cloudflare Workers、AWS Lambda、Vercel ではリクエストの間でメモリを共有しないので、デフォルトの `MemorySessionStore` を使うと、ログインした直後のリクエストでセッションが失われます。ミドルウェアはこの状況を検出するとプロセスごとに 1 度警告を出し、`guren check` とデプロイのビルドは事前に警告します。

## プロバイダーとガードの設定

### `auth.useModel()` ショートハンドの使用（推奨）

認証を設定するいちばん簡単な方法は、`auth.useModel()` ヘルパーです。`ModelUserProvider` と `SessionGuard` をまとめて登録できます。

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

この呼び出しで、次のことが行われます。
- 指定したカラムで `ModelUserProvider` を登録する
- セッションを適切に扱う `SessionGuard` を作る
- デフォルトのガードを 'web' にする
- `createApp({ auth: { hasher } })` で選んだハッシャーを使う。既定は scrypt です（[パスワードハッシャー](#パスワードハッシャー)を参照）

### パスワードハッシャー

アプリが書き込むパスワードは、`AuthenticatableModel` が `create()` でハッシュ化するときも、セッションガードがログイン時にハッシュし直すときも、同じ 1 つのハッシャーを通ります。ハッシャーを選ぶのは `createApp()` の 1 か所だけです。

```ts
const app = createApp({
  auth: {
    hasher: 'scrypt', // 既定値
  },
})
```

- `'scrypt'`（既定）は、`node:crypto` を使って `$scrypt$` 形式のハッシュを書き込みます。Bun、Node、Lambda、Workers のどのランタイムでも検証できます。
- `'argon2'` は、`Bun.password` を使って Argon2id を書き込みます。今後も Bun で動かすデプロイでだけ選んでください。`Bun.password` のないランタイムでは、`createApp()` が例外を投げます。
- `PasswordHasher` オブジェクトを渡すと、組み込みのハッシャーをまるごと置き換えます。

検証するときは、この設定ではなく、保存されているハッシュの形式を見てハッシャーを選びます。そのため、両方の形式が混ざったカラムもそのまま動きます。設定と違う形式の行（たとえば、scrypt が既定になる前のリリースが Bun で書いた Argon2id）は、そのユーザーが次にログインに成功したときにハッシュし直されます。その後一度もログインしないユーザーの行は、元の形式のまま残ります。

`Bun.password` のないランタイムでは、Argon2id の行を検証できません。Node、Lambda、Workers に移る前に、アプリがまだ Bun で動いているうちに移行を済ませてください。移行するには、該当するユーザーにログインしてもらうか、パスワードをリセットします。

### 手動設定（上級者向け）

独自のプロバイダーやガードが必要な場合は、手で設定できます。

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

後述の `AuthenticatableModel` と組み合わせると、パスワードのハッシュ化と検証のヘルパーが自動で付きます。

### 認証可能モデル

`AuthenticatableModel` を継承したモデルには、パスワードの処理が組み込まれます。`create` や `update` に平文の `password` を渡すと、自動でハッシュ化して `passwordHash` カラム（静的プロパティで変更できます）に保存します。平文は保持せず、認証にはプロバイダーと同じアルゴリズムを使います。

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

`AuthenticatableModel` を `base` に渡し、同じ呼び出しの中で create のペイロードの型を整えます。`defineModel()` がテーブルから推論する型では、デフォルト値のないカラムがすべて必須になりますが、ここではそれが正しい形ではありません。呼び出し側が渡すのは平文の `password` で、`passwordHash` ではないからです。`optionalOnCreate` でカラムを任意にし、`requireOnCreate` で仮想フィールドを必須にします。どちらも型レベルの指定なので、キャストも型マーカーの再宣言もいりません。

任意にしただけなので、呼び出し側が `passwordHash` を渡しても型チェックは通ります。実行時には、`AuthenticatableModel` がハッシュのカラム（と remember トークン）への一括代入を常に拒否します。リクエストボディにこれらが含まれていると、モデルの `fillable` の内容にかかわらず `MassAssignmentException` を投げます。`passwordHash: 'oauth:...'` のような、サーバー側で決める信頼できる値を書き込むときは、`forceCreate()` / `forceUpdate()` を使ってください。

OAuth だけでサインアップする場合など、パスワードなしでアカウントを作るときは、`requireOnCreate` を付けずに `password` を任意のままにします。

資格情報のカラムにパスワードのハッシュ以外の値が入っていれば、そのアカウントはパスワードでは認証できないという意味になります。`ModelUserProvider` は、null、空文字列、`'oauth:...'` のような番兵の値をどれも同じように扱います。ログインを拒否しつつ、本物の検証と同じだけハッシュの計算を行うので、応答時間からも区別できません。一方、ハッシュの形式を名乗っているのに中身がそれを満たさない値には、これまでどおり例外を投げます。これはカラムの破損や切り詰めなので、黙って拒否すると気付く手がかりがなくなってしまうためです。パスワードを持たないアカウントには nullable なカラムを使うほうが分かりやすく、`make:auth --oauth` もそちらを生成します。

既定の `AuthServiceProvider` は、`users` プロバイダーを使う `web` ガードを自動で登録します。別のガード（たとえばトークンベースの API 用）が必要なら、`context.auth.registerGuard('api', factory)` を呼び、必要に応じて `context.auth.setDefaultGuard('api')` で既定のガードを切り替えます。

## コントローラーとルート

コントローラーには `auth` ヘルパーがあります。

```ts
import { pages } from '@/.guren/pages.gen'
import type { UserRecord } from '@/app/Models/User'

export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()       // ユーザーまたは null を返す
    return this.inertia(pages.dashboard.Index, { user })
  }

  async store() {
    const user = await this.auth.userOrFail<UserRecord>()  // 未認証なら 401 をスロー
    // user は non-null が保証される
    await Post.create({ authorId: user.id, ...data })
    return this.redirect('/posts')
  }
}
```

バリデーションには、`this.validateBody()` / `this.validateQuery()` / `this.validateParams()` を Zod スキーマと組み合わせて使います。`FormRequest` は、互換性のためだけに使ってください。

ログイン中のユーザーを Inertia のすべてのページで共有する設定は、雛形生成の時点で済んでいます。`bunx guren add auth`（= `bunx guren make:auth --install`）が生成する `app/Providers/AuthProvider.ts` の `boot()` に次の登録が入っているので、生成した直後から、すべてのページの props で `auth.user` を読めます。生成されるレイアウトが **Sign in** と **Log out** を出し分けているのも、この props を使っています。

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

認証を手で組み立てた場合は、自分のサービスプロバイダーの `boot()` で同じ呼び出しを行ってください。

この方法で `auth.user()` を共有しても、デフォルトで安全です。レコードは認証レイヤーを出る前にサニタイズされるので、パスワードのハッシュがブラウザに届くことはありません（後述の「サニタイズされたユーザーレコード」を参照）。

React 側でも型を付けるには、`InertiaSharedProps` を拡張してください（詳しくはコントローラーガイドを参照）。

> `shareInertiaProps` は、先に登録されたリゾルバーの props にマージします。
> そのため、auth・i18n・flash など複数の場所から共有 props を追加しても、互いを壊しません。
>
> ```ts
> shareInertiaProps((ctx) => ({ i18n: { locale: detectLocale(ctx) } }), this.container)
> ```
>
> `this.container` を渡すと、その props は 1 つのアプリケーションの中だけで使われます。
> 渡さない場合はプロセス全体で共有され、同時に起動した別のアプリケーションにも漏れます。
>
> `setInertiaSharedProps` はマージせず、プロセス全体のリゾルバーを置き換えます。
> 呼んだ時点で登録済みのものはすべて捨てられるので、意図的にまるごと差し替えたいときだけ使ってください。

ルートの保護は、ルートミドルウェアを使えば簡単です。

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

- `auth.check()`: 認証済みなら `true` を返します。
- `auth.user()`: 現在のユーザーのレコード（または `null`）を返します。パスワードのハッシュ、remember トークン、モデルの `hidden` フィールドを取り除いた、サニタイズ済みのレコードです。
- `auth.userOrFail()`: 現在のユーザーを返し、未認証なら `AuthenticationException`（401）を投げます。ルートが保護されていると分かっているときは、null チェックを省けます。
- `auth.login(user, remember?)`: 指定したユーザーでログインし、必要なら remember トークンを発行します。
- `auth.attempt(credentials, remember?)`: 資格情報を検証し、正しければログインします。
- `auth.logout()`: セッションと remember トークンを消去します。

## サニタイズされたユーザーレコード

`auth.user()`（と、`login()` / `attempt()` の直後にキャッシュされるユーザー）が資格情報を外に出すことはありません。レコードが認証レイヤーを出る前に、`ModelUserProvider` がパスワードのカラム、remember トークンのカラム、モデルが `hidden` に指定したフィールドを取り除きます。

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

`make:auth` は、この `hidden` の設定を含むユーザーモデルを最初から生成します。このオプションと、引き続き使える `static hidden = [...]` の書き方については、[フィールドの非表示](./database.md#フィールドの非表示)を参照してください。

資格情報の検証は、内部で生のデータベースレコードに対して行われるので、ログインや remember me の動作には影響しません。サニタイズによって変わるのは、`auth.user()` がアプリケーションのコードに渡す内容だけです。

独自のユーザープロバイダーでも、`UserProvider` インターフェースの省略可能なメソッド `sanitize(user)` を実装すれば、同じサニタイズを使えます。`SessionGuard` は、ユーザーをキャッシュして返す前にこのメソッドを呼びます。

```ts
sanitize(user: AuthUser): AuthUser {
  const { passwordHash, ...safe } = user
  return safe as AuthUser
}
```

### サニタイズ済みユーザーの型付け

サニタイズは実行時の処理なので、単に `auth.user<UserRecord>()` と書くと、実際には取り除かれている資格情報のフィールドが型の上では残ってしまいます。`Sanitized<T>` ヘルパーを使うと、慣例的な名前の資格情報キーを型からも取り除けます。

```ts
import type { Sanitized } from '@guren/core'

// password / passwordHash / rememberToken 系のキーを型から除去
const user = await this.auth.userOrFail<Sanitized<UserRecord>>()

user.email        // ✅ string
user.passwordHash // ❌ コンパイルエラー — ランタイムで除去済み
```

モデルの `hidden` でほかのフィールドも隠している場合や、資格情報のカラムが慣例的な名前（`password`、`passwordHash`、`password_hash`、`rememberToken`、`remember_token`）でない場合は、2 つ目の型引数に並べます。

```ts
type SafeUser = Sanitized<UserRecord, 'twoFactorSecret' | 'credentialDigest'>
```

実行時に取り除かれるのは、「プロバイダーに設定したカラム」と「モデルの `hidden` フィールド」です。静的な型からはこの設定を参照できないので、`Sanitized<T>` が反映するのは慣例的な名前だけで、それ以外は 2 つ目の型引数で指定してもらう形になっています。`hidden` に入れ忘れた機密性の高いカラムは `guren audit` が警告するので、実行時の正しさはそちらで確かめられます。

## Remember トークン

`SessionGuard` は remember トークンを自動で管理します。ユーザープロバイダーが `setRememberToken` / `getRememberToken` を実装していれば動きます。`ModelUserProvider` の場合は、`rememberTokenColumn` を指定すれば対応します。

## 実例アプリ

ブログのサンプルには、認証の機能がひととおり入っています。

- ガードとプロバイダーを設定する `AuthProvider` と、`config/session.ts`・`config/oauth.ts` の定義
- ログイン・登録・パスワードリセット・メール確認の各コントローラーと `DashboardController`
- `resources/js/pages/auth/` 配下の Inertia ページ（`Login`・`Register`・`ForgotPassword`・`ResetPassword`・`VerifyEmail`）と `resources/js/pages/dashboard/Index.tsx`
- GitHub・Google 向けの OAuth ログインボタン
- `users` のスキーマ、マイグレーション、シーダー

デモは次のコマンドで起動します。

```bash
bun run dev
```

`http://localhost:3333/login` を開き、シード済みの `demo@guren.dev` / `secret` でログインしてください。`/register` から新しいアカウントを作ることもできます。
