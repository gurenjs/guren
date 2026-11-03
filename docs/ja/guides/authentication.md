# 認証ガイド

コマンド 1 つでアプリにログイン、新規登録、パスワードリセットを追加し、ルートを保護して、コントローラーでログイン中のユーザーを読めるようにします。このページの前半では生成されるものの使い方を、後半では動きを変えたいときのためにガードとユーザープロバイダーを説明します。セッションと OAuth によるサインインは、それぞれ[セッション](./sessions.md)と [OAuth ガイド](./oauth.md)で扱います。

## クイックスタート

`--install` を付けて雛形生成コマンドを実行します（`bunx guren add auth` でも同じです）。

```bash
bunx guren make:auth --install
```

このコマンドは次のものを書き出します。

- ログイン、新規登録、パスワードリセット、プロフィールのコントローラーと、その Inertia ページ、レイアウト、`routes/auth.ts`
- `AuthProvider`、`User` モデル、デモ用のシーダー、リセットメール用の `config/mail.ts`
- `db/schema.ts` の `users` のカラムと `sessions` テーブル、`config/session.ts`、その両方をまとめたマイグレーション

`--install` を付けると、さらにアプリへの組み込みまで行います。

1. `createApp()` に `AuthProvider` を登録し、`config` 配列にメールの定義を追加する
2. `createApp()` に `auth: {}` を追加する。これでセッションと CSRF のミドルウェアがマウントされる
3. `routes/web.ts` から `registerAuthRoutes(router)` を呼ぶようにする

続いて、次のコマンドを実行します。

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

`bun run dev` が表示する URL（既定は `http://localhost:3333`）の `/login` を開くと、`demo@example.com` / `secret` でログインできます。新しいアカウントは `/register` から作れます。

フラグを付けると、生成される内容が変わります。

| フラグ | 変わる内容 | 補足 |
|--------|------------|------|
| `--minimal` | ログインだけを生成し、登録とパスワードリセットは省く | |
| `--verify` | メール確認を追加する（[メール確認](#メール確認)を参照） | `--minimal` とは併用できない |
| `--oauth github,google` | プロバイダーのログインボタンを追加する（[OAuth ログインボタン](./oauth.md#oauth-ログインボタン)を参照） | `--minimal` と併用できる |
| `--oauth-only` | パスワードを使わず、プロバイダーのログインだけにする（[OAuth のみでサインインする](./oauth.md#oauth-のみでサインインする)を参照） | `--oauth` が必要。`--minimal` の効果を含む |
| `--no-session` | セッションをデータベースのテーブルではなくプロセスのメモリに置く | 再起動やインスタンスをまたぐと失われる |

### `--install` を付けない場合

自分で設定したい場合や、一部だけ設定済みの環境では、`--install` フラグを付けずに実行します。

```bash
bunx guren make:auth
```

コマンドは、省いた作業を一覧で表示します。主なものは次のとおりです。

1. `createApp()` の providers 配列に `AuthProvider` を登録する
2. セッションと CSRF を有効にするため、`createApp()` のオプションに `auth: {}` を追加する
3. `routes/auth.ts` の `registerAuthRoutes` を import し、`routes/web.ts` の registrar から呼ぶ
4. `config/mail.ts` の定義を `config` 配列に加え、`.env` に `APP_URL` を設定する（メールで送るリンクはこの値から組み立てられる）

`--install` は冪等で、何度実行しても既存の設定を重複させません。

`guren add mail` や独自のプロバイダーでメールをすでに設定しているアプリでは、その設定をそのまま使います。`make:auth` は `config/mail.ts` を書き出さず、リセットメールは既存の設定を通じて送られます。`--no-session` を付けると、セッションのテーブルと設定は生成されず、セッションはプロセスのメモリに置かれます。

## 生成される機能

### スロットリング

`POST /login`、`POST /register`、`POST /forgot-password` には、生成される `app/Http/Middleware/AuthThrottle.ts` のスロットルがかかります。回数はクライアントの IP アドレスと送信されたメールアドレスの組ごとに数え、ログインと新規登録は 1 分に 5 回、リセットの申請は 15 分に 3 回までです。

上限を超えると、Inertia のフォームには `errors.message` のバリデーションエラーとしてメッセージが表示され、それ以外のクライアントには `Retry-After` ヘッダー付きの `429` が返ります。メッセージは `lang/en/auth.json` の `auth.throttle`（ログイン）か `auth.too_many_requests` から読みます。このファイルは、アプリにまだ無い場合にだけコマンドが書き込みます。

上限の変更などは、このファイルを直接編集してください。デフォルトのストアはプロセスのメモリにあるので、複数のインスタンスで回数を共有するには `@guren/core/redis` の `store: new RedisRateLimitStore(redis)` を渡します。プロキシや CDN の後ろでは、どのクライアントもプロキシのアドレスから届くため、`clientIp()` でプロキシが設定するヘッダーを読むように変えてください。オプションの一覧は[レート制限ガイド](./rate-limiting.md)にあります。

### パスワードリセット

ログインページの「Forgot your password?」を押すと、`ForgotPasswordController` と `ResetPasswordController` が扱うリセットの流れに入ります。内部ではフレームワークの `createPasswordResetToken` / `completePasswordReset` を使っています（[パスワードリセット](./password-reset.md)を参照）。

- トークンは、生成される `app/Auth/PasswordResetStore.ts` に保存されます。これはインメモリのストアなので、本番や複数インスタンスの構成では Redis ベースのストアに差し替えてください。
- リンクは、生成される `config/mail.ts` を通じて送られます。既定の `log` ドライバーではリンクがコンソールに出力されるので、開発環境では何も設定せずに動きます。実際にメールを送るには、`MAIL_MAILER=smtp` と `SMTP_*` の環境変数を設定してください。

### メール確認

`--verify` を付けると、メール確認の流れも一緒に生成されます。

```bash
bunx guren make:auth --install --verify
```

`users` テーブルに `emailVerifiedAt` カラムが追加され、`VerifyEmailController`（「メールを確認してください」の案内の表示、再送、トークンの確認を担当）と `VerifyEmail` ページが生成されます。登録すると確認メールが送られ、`/dashboard` ではなく `/verify-email` にリダイレクトされるようになります。生成される `/dashboard` ルートには `requireVerifiedEmail` が付くので、確認を済ませていないユーザーは、確認が終わるまで `/verify-email` に戻されます。

確認リンクも、パスワードリセットと同じインメモリのストアと `log` ドライバーのメール設定を使うので、開発環境では何も設定せずに動作を確認できます。

## OAuth / ソーシャルログイン

プロバイダー（GitHub、Google、Discord）でのサインインは、生成されるページにボタンを足す `make:auth --oauth` か、自分で書くコントローラー向けにフローを用意する `guren add oauth` でスキャフォールドします。2 つのコマンドの違い、書き出されるファイル、その裏で動くフローは、[OAuth ガイド](./oauth.md#oauth-のスキャフォールド)で説明します。

## コントローラーとルート

コントローラーでは、ログイン中のユーザーを `this.auth` から読みます。

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
    await Post.create(data, { set: { authorId: user.id } })
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

React 側でも型を付けるには、`InertiaSharedProps` を拡張してください（詳しくは[コントローラーガイド](./controllers.md)を参照）。

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
  fillable: ['name', 'email', 'password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

`make:auth` は、この `hidden` の設定を含むユーザーモデルを最初から生成します。このオプションと、引き続き使える `static hidden = [...]` の書き方については、[フィールドの非表示](./models.md#フィールドの非表示)を参照してください。

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

## 認証の仕組み

生成される認証は次の部品でできていて、このページの後半ではこれらを設定します。

- **AuthManager**: ガードとユーザープロバイダーを登録しておく場所です。サービスコンテナから `this.container.make<AuthManager>('auth')` で取り出します。
- **ガード**: リクエストを認証する実行時のオブジェクトです。既定の `SessionGuard` はセッションにユーザー ID を保持し、必要なら「ログイン状態を保持する」ための remember トークンも扱います。
- **ユーザープロバイダー**: ガードがユーザーを読み込んだり検証したりするためのデータアクセス層です。`ModelUserProvider` は Guren の `Model` に対応しているので、Drizzle のテーブルをそのまま認証に使えます。
- **Auth コンテキスト**: リクエストごとの窓口で、`auth.check()`, `auth.user()`, `auth.login()` などのヘルパーを持ちます。`AuthServiceProvider` が自動で取り付け、コントローラーでは `this.auth`、ミドルウェアでは `attachAuthContext` 経由で使えます。
- **OAuthManager**: ソーシャルログイン用のヘルパーです。OAuth の state の管理、コードの交換、プロフィールの取得を扱います。

## セッション

ガードは、ログインしたユーザーの識別子をセッションに保存します。`createApp()` に `auth` オプションを渡せば、セッションのミドルウェアと CSRF 対策は自動で付き、`guren add auth` を実行したアプリでは最初からセッションがデータベースに保存されます。Cookie の設定、使えるストア、環境ごとのストアの選び方は[セッション](./sessions.md)で説明します。

## プロバイダーとガードの設定

### `auth.useModel()` ショートハンドの使用（推奨）

認証を設定するいちばん簡単な方法は、`auth.useModel()` ヘルパーです。`ModelUserProvider` と `SessionGuard` をまとめて登録できます。

```ts
import { ServiceProvider } from '@guren/core'
import type { AuthManager } from '@guren/core'
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

アプリが書き込むパスワードは、`AuthenticatableModel` が `create()` でハッシュ化するときも、セッションガードがログイン時にハッシュし直すときも、同じ 1 つのハッシャーを通ります。ハッシャーは `createApp()` の 1 か所で選びます。

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
import type { AuthManager } from '@guren/core'
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

`AuthenticatableModel` を `base` に渡し、同じ呼び出しの中で create のペイロードの型を整えます。`defineModel()` がテーブルから推論する型では、デフォルト値のないカラムがすべて必須になりますが、ここではそれが正しい形ではありません。呼び出し側が渡すのは平文の `password` で、`passwordHash` ではないからです。

`optionalOnCreate` でカラムを任意にし、`requireOnCreate` で仮想フィールドを必須にします。どちらも型レベルの指定なので、キャストも型マーカーの再宣言もいりません。

任意にしただけなので、呼び出し側が `passwordHash` を渡しても型チェックは通ります。実行時には、`AuthenticatableModel` がハッシュのカラム（と remember トークン）への一括代入を常に拒否します。リクエストボディにこれらが含まれていると、モデルの `fillable` の内容にかかわらず `MassAssignmentException` を投げます。

`passwordHash: 'oauth:...'` のような、サーバー側で決める信頼できる値を書き込むときは、`forceCreate()` / `forceUpdate()` を使ってください。

OAuth だけでサインアップする場合など、パスワードなしでアカウントを作るときは、`requireOnCreate` を付けずに `password` を任意のままにします。

資格情報のカラムにパスワードのハッシュ以外の値が入っていれば、そのアカウントはパスワードでは認証できないという意味になります。`ModelUserProvider` は、null、空文字列、`'oauth:...'` のような番兵の値をどれも同じように扱います。ログインを拒否しつつ、本物の検証と同じだけハッシュの計算を行うので、応答時間からも区別できません。

一方、ハッシュの形式を名乗っているのに中身がそれを満たさない値には、これまでどおり例外を投げます。これはカラムの破損や切り詰めなので、黙って拒否すると気付く手がかりがなくなってしまうためです。

パスワードを持たないアカウントには nullable なカラムを使うほうが分かりやすく、`make:auth --oauth` もそちらを生成します。

`createApp()` は、`users` プロバイダーを使う既定の `web` ガードを登録します。別のガード（たとえばトークンベースの API 用）が必要なら、プロバイダーの中で `auth.registerGuard('api', factory)` を呼び、必要に応じて `auth.setDefaultGuard('api')` で既定のガードを切り替えます。

## Remember トークン

`SessionGuard` は remember トークンを自動で管理します。ユーザープロバイダーが `setRememberToken` / `getRememberToken` を実装していれば動きます。`ModelUserProvider` の場合は、`rememberTokenColumn` を指定すれば対応します。

## 独自のワンタイムトークンストア

パスワード再設定とメール認証は、ワンタイムトークンをストアに保存します。メモリ版と Redis 版のストアを使う場合は何もする必要がなく、この節は独自のストアを書くときや、古い雛形を更新するときのためのものです。

ヘルパーは、ストアの 2 つのアトミックな操作を前提にしています。`replace()` は、そのメールアドレスの既存トークンの失効と新しいトークンの保存を一度に行います。`consume(tokenId, email)` は、保存済みのメールアドレスとの照合とトークンの削除を一度に行い、同時に呼ばれても成功を示す `true` を返すのは 1 回だけです。メモリ版と Redis 版のストアは、どちらもこの 2 つを実装しています。発行時は、メールアドレスを小文字にそろえてから置き換えます。

独自の `PasswordResetTokenStore` や `EmailVerificationTokenStore` を使っている場合は、発行・完了のヘルパーを使う前に、これらのメソッドを追加してください。パスワード再設定のストアは `replace(tokenId, email, expiresAt)`、メール認証のストアは `replace(token)` を受け取ります。型の互換性のためにメソッドは省略可能になっていますが、必要な操作が実装されていなければ、ヘルパーはエラーにします。

複数のワーカーで共有するストアでは、プロセス内のロックだけでは足りません。トランザクションや、データベースのアトミックなコマンドで実装してください。

`completePasswordReset()` と `completeEmailVerification()` は、アプリの更新処理を呼ぶ前にトークンを消費します。消費したトークンは元に戻らないので、更新に失敗したときはトークンを再発行してください。

`verifyPasswordResetToken()` と `verifyEmailToken()` は有効かどうかを確かめるだけで、トークンを予約したり消費したりはしません。更新には完了用のヘルパーを使ってください。

生成済みのパスワード再設定コントローラーで検証・更新・削除を別々に呼んでいる場合は、`completePasswordReset()` に置き換えてください。その際は `@guren/core` と `@guren/cli` を一緒に更新し、トークンを発行・消費するすべてのインスタンスを再起動してください。古いインスタンスには、同時実行の問題が残ります。

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
