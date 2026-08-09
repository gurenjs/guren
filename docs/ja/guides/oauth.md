# OAuthガイド

Guren は「GitHub / Google / Discordでサインイン」のようなログインのための OAuth 2.0 認可コードフローを提供します。リダイレクト、CSRF対策済みのstate管理、トークン交換、プロフィール取得を処理し、あなたは自分のログインコントローラーとセッションに組み込むだけです。

## コアコンセプト

- **OAuthManager** – プロバイダーを登録し、認可 → コールバックのフローを駆動します。
- **OAuthProviderConfig** – 1つのプロバイダー（GitHub、Google、Discord、または任意の OAuth 2.0 プロバイダー）のクライアントID/シークレット、エンドポイント、スコープ。
- **OAuthStateStore** – CSRFとオープンリダイレクト攻撃を防ぐ、一度限りのstateストレージ。デフォルトはメモリ、マルチプロセス構成では `DatabaseOAuthStateStore`（またはRedis）を使用します。
- **プロバイダーファクトリ** – `createGitHubOAuthProviderConfig`、`createGoogleOAuthProviderConfig`、`createDiscordOAuthProviderConfig` が各プロバイダーの既知のエンドポイントをあらかじめ埋めてくれます。

## 基本的な使い方

### マネージャーの登録

`OAuthServiceProvider` が `OAuthManager` のシングルトンをコンテナに `oauth` として束縛します。アプリの起動時にプロバイダーを登録します。

```ts
// config/oauth.ts
import { createGitHubOAuthProviderConfig, createOAuthManager } from '@guren/core'

export const oauth = createOAuthManager()

oauth.registerProvider('github', createGitHubOAuthProviderConfig({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  redirectUri: `${process.env.APP_URL}/auth/github/callback`,
}))
```

### ログインコントローラー

```ts
import { Controller } from '@guren/core'
import { z } from 'zod'
import { oauth } from '@/config/oauth'
import { User } from '@/app/Models/User'

const CallbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
})

export default class GitHubOAuthController extends Controller {
  async start() {
    // セッションを渡すとフローがこのブラウザに束縛されます。
    // 詳細は下の「stateをブラウザに束縛する」を参照してください。
    const { url } = await oauth.authorize('github', {
      redirectTo: this.query('redirect_to'),
      session: this.auth.session(),
    })
    return this.redirect(url)
  }

  async callback() {
    const { code, state } = this.validateQuery(CallbackQuerySchema)
    const { profile, redirectTo } = await oauth.handleCallback('github', {
      code,
      state,
      session: this.auth.session(),
    })

    let user = await User.where('githubId', profile.id).first()
    if (!user) {
      user = await User.create({ email: profile.email, name: profile.name, githubId: profile.id })
    }

    await this.auth.login(user)
    return this.redirect(redirectTo ?? '/dashboard')
  }
}
```

### ルート

```ts
import { Router } from '@guren/core'
import GitHubOAuthController from '@/app/Http/Controllers/Auth/GitHubOAuthController'

export function registerWebRoutes(router: Router): void {
  router.get('/auth/github', [GitHubOAuthController, 'start'])
  router.get('/auth/github/callback', [GitHubOAuthController, 'callback'])
}
```

## stateをブラウザに束縛する

`state` は推測不能かつ一度きりですが、それだけでは**別のブラウザに移し替えられます**。攻撃者はあなたのアプリでフローを開始し、自分のプロバイダーアカウントで認可を済ませ、受け取った `code` を未消費のまま持っておいて、訪問者に次を開かせることができます。

```
https://your.app/auth/github/callback?code=<攻撃者のもの>&state=<攻撃者のもの>
```

この組み合わせには「どのブラウザが開始したか」を示すものが何もないため、コールバックは成功し、訪問者は**攻撃者のアカウント**にログインさせられます。その後に訪問者が書いたもの — 投稿、アップロード、登録した決済手段 — はすべて攻撃者が読めるアカウントに入ります。

両方の脚にセッションを渡すと塞げます。

```ts
// フロー開始時
const { url } = await oauth.authorize('github', { session: this.auth.session() })

// コールバック時
await oauth.handleCallback('github', { code, state, session: this.auth.session() })
```

`authorize()` はフローごとに新しい値を発行してセッションに保持し、そのハッシュだけを state と一緒に保存します。`handleCallback()` は値を読み戻し（同時に削除し）、束縛が一致しない state を拒否します。セッションへの書き込みは、初回訪問者のセッションをプロバイダーとの往復をまたいで永続化させる役割も果たすため、コールバックのリクエストが同じセッションを持って戻ってきます。

束縛は state 単位で保持されるので、同じブラウザで複数のフローを並行させても（タブを2つ開く、プロバイダーを選び直す）互いに無効化しません。

`this.auth.session()` が `undefined` を返す場合（セッションミドルウェアが無い等）は、単に未束縛のまま通ります。壊れはしませんが、保護もされません。

束縛をセッション以外の場所に置く必要がある場合（暗号化Cookie、ネイティブアプリのセキュアストレージ）は、`bindTo` で自分で管理します。そのブラウザだけが提示できる値を `authorize()` に渡し、同じ値を `handleCallback()` に渡してください。両方指定した場合は `bindTo` が優先されます。

> [!WARNING]
> `session` も `bindTo` も渡さない `authorize()` は従来どおり動作するため、以前のAPIで書かれたアプリは壊れません。ただしプロセスごとに一度警告を出し、採用するまで上記の攻撃に晒されたままです。`make:auth` と `oauth` ブループリントは束縛版を生成します。

## ログイン後のリダイレクト

フロー開始時に `redirectTo`（ユーザーが元々いたページなど）を渡すと、プロバイダーとの往復を経ても保持され、`handleCallback` から返ってきます。

```ts
const { url } = await oauth.authorize('github', {
  redirectTo: '/settings/billing',
  session: this.auth.session(),
})
// ...後で、コールバック内で:
const { redirectTo } = await oauth.handleCallback('github', {
  code,
  state,
  session: this.auth.session(),
})
return this.redirect(redirectTo ?? '/dashboard')
```

`redirectTo` は自動的にサニタイズされます。アプリ相対パス（`/settings/billing`）は常に許可されますが、絶対URLは `allowedRedirectHosts` にホストが含まれていない限り破棄されます。これにより、攻撃者がログイン後にユーザーを外部サイトへリダイレクトするリンクを細工することを防ぎます。

```ts
export const oauth = createOAuthManager({
  stateConfig: {
    allowedRedirectHosts: ['app.example.com', '*.example.com'], // ワイルドカード対応
  },
})
```

## 組み込みプロバイダー

```ts
import {
  createGitHubOAuthProviderConfig,
  createGoogleOAuthProviderConfig,
  createDiscordOAuthProviderConfig,
} from '@guren/core'

oauth.registerProvider('github', createGitHubOAuthProviderConfig({
  clientId: process.env.GITHUB_CLIENT_ID!,
  clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  redirectUri: `${process.env.APP_URL}/auth/github/callback`,
}))

oauth.registerProvider('google', createGoogleOAuthProviderConfig({
  clientId: process.env.GOOGLE_CLIENT_ID!,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
  redirectUri: `${process.env.APP_URL}/auth/google/callback`,
}))

oauth.registerProvider('discord', createDiscordOAuthProviderConfig({
  clientId: process.env.DISCORD_CLIENT_ID!,
  clientSecret: process.env.DISCORD_CLIENT_SECRET!,
  redirectUri: `${process.env.APP_URL}/auth/discord/callback`,
}))
```

### 任意の OAuth 2.0 プロバイダー

直接登録するプロバイダーには、生のエンドポイントと、必要に応じてユーザー情報レスポンスを正規化する `mapProfile` 関数が必要です。

```ts
import type { OAuthProviderConfig } from '@guren/core'

const gitlabConfig: OAuthProviderConfig = {
  clientId: process.env.GITLAB_CLIENT_ID!,
  clientSecret: process.env.GITLAB_CLIENT_SECRET!,
  redirectUri: `${process.env.APP_URL}/auth/gitlab/callback`,
  authorizeUrl: 'https://gitlab.com/oauth/authorize',
  tokenUrl: 'https://gitlab.com/oauth/token',
  userInfoUrl: 'https://gitlab.com/api/v4/user',
  scopes: ['read_user'],
  mapProfile: (raw, token) => ({
    id: String(raw.id),
    email: raw.email as string | undefined,
    name: raw.name as string | undefined,
    avatar: raw.avatar_url as string | undefined,
    token,
    raw,
  }),
}

oauth.registerProvider('gitlab', gitlabConfig)
```

## プロバイダーによるメールアドレスの検証状態

プロバイダーがメールアドレスを返したことは、そのアドレスを検証したという主張ではありません。多くのプロバイダーは検証状態を別に報告しており（Google は OIDC の `email_verified`、Discord は `verified`）、プロフィールでは `profile.emailVerified` として公開されます。

| 値 | 意味 |
|----|------|
| `true` | プロバイダーが検証済みと報告している |
| `false` | プロバイダーが未検証と報告している |
| `undefined` | プロバイダーがこの情報を返していない（アプリ側で方針を決める） |

`false` の場合はアカウントの**新規作成**を拒否してください。未検証のアドレスをそのまま受け入れると、所有していないメールアドレスを名乗れてしまい、重複メールを弾くコールバックが本来の所有者を恒久的に締め出すことになります。既に紐付け済みのアカウントが後から状態変化で締め出されないよう、チェックは作成パスだけに置きます。

```ts
if (!user && profile.emailVerified === false) {
  throw ValidationException.withMessages({
    message: 'Your provider has not verified this email address.',
  })
}
```

組み込みプリセットは自分のキーを宣言済みです。自前で登録するプロバイダーが標準以外のキー名を使う場合は `emailVerifiedKey` を設定してください。デフォルトでは OIDC の `email_verified` を読み、boolean 値のみを有効な信号として扱います。

```ts
const discordish: OAuthProviderConfig = {
  // ...
  emailVerifiedKey: 'verified',
}
```

`mapProfile` はマッピング全体を担うため、それを使うプロバイダーでは `emailVerified` も自分で設定し、`emailVerifiedKey` は無視されます。GitHub の `/user` には検証状態のフィールドがないため `emailVerified` は `undefined` のままですが、メールアドレス非公開時のフォールバックが動いた場合は例外です（`/user/emails` は検証済みのプライマリアドレスしか返さないため）。

`fetchFallbackEmail` はメールアドレスを含まないレスポンスに対して読んだ後に呼ばれるため、上記のキーはその戻り値を保証できません。文字列をそのまま返す場合は検証状態を主張せず `undefined` のままになります。主張する場合はオブジェクトを返してください。

```ts
fetchFallbackEmail: async (token) => ({ email: await lookupEmail(token), emailVerified: true }),
```

## Stateストレージ

コールバックを元のリクエストに結びつける一度限りの `state` 値は、サーバー側で保存されます。デフォルトの `MemoryOAuthStateStore` は単一プロセスの開発環境では動作しますが、複数プロセス（ロードバランサー、サーバーレス）構成の本番環境では共有ストレージが必要です。そうしないと、コールバックがstateを発行していないプロセスに到達してしまう可能性があります。

ほとんどのアプリでは `DatabaseOAuthStateStore` が推奨のデフォルトです。アプリが既に使っているデータベースにstateを保存するため、追加のインフラは不要です:

```ts
import { createOAuthManager, DatabaseOAuthStateStore } from '@guren/core'
import { oauthStates } from '@/db/schema'

export const oauth = createOAuthManager({
  stateStore: new DatabaseOAuthStateStore(oauthStates),
})
```

```ts
// db/schema.ts（sqliteダイアレクトの例）
export const oauthStates = sqliteTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  binding: text('binding'),
})
```

`binding` 列は[stateをブラウザに束縛する](#stateをブラウザに束縛する)で使うハッシュを保持します。この列が無いとストアは束縛を永続化できず、束縛済みのstateがすべて未束縛で戻ってくるため、保護が黙って無効化されます。`session` / `bindTo` を使う前に列を追加してください。

期限切れのstate行は参照時に削除されます。まとめて掃除する場合はスケジュールジョブから `store.deleteExpired()` を呼んでください。既にRedisを運用しているアプリではRedisも引き続き使えます:

```ts
import { createOAuthManager } from '@guren/core'
import { createRedisClient, RedisOAuthStateStore } from '@guren/core/redis'

const redis = createRedisClient({ url: process.env.REDIS_URL })

export const oauth = createOAuthManager({
  stateStore: new RedisOAuthStateStore(redis),
})
```

## 設定オプション

```ts
interface OAuthProviderConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  authorizeUrl: string
  tokenUrl: string
  userInfoUrl: string
  scopes?: string[]
  tokenAuthMethod?: 'client_secret_post' | 'client_secret_basic'
  userInfoMethod?: 'GET' | 'POST'
  mapProfile?: (raw: Record<string, unknown>, token: OAuthTokenResult) => OAuthUserProfile
  emailVerifiedKey?: string      // 検証状態を持つユーザー情報のキー（デフォルト: 'email_verified'）
}

interface OAuthStateConfig {
  expiresIn?: number             // stateのTTL（ミリ秒、デフォルト: 10分）
  stateLength?: number           // ランダムstateのバイト数（デフォルト: 24）
  hashAlgorithm?: 'sha256' | 'sha512'
  allowedRedirectHosts?: string[] // 許可する絶対URLの redirectTo ホスト（ワイルドカード対応）
}
```

## テスト

```ts
import { describe, test, expect } from 'bun:test'
import { OAuthManager, MemoryOAuthStateStore, createGitHubOAuthProviderConfig } from '@guren/core'

describe('GitHub OAuth', () => {
  test('stateを含む認可URLを生成する', async () => {
    const oauth = new OAuthManager({ stateStore: new MemoryOAuthStateStore() })
    oauth.registerProvider('github', createGitHubOAuthProviderConfig({
      clientId: 'test-client',
      clientSecret: 'test-secret',
      redirectUri: 'http://localhost:3000/auth/github/callback',
    }))

    const { url, state } = await oauth.authorize('github')

    expect(url).toContain('github.com/login/oauth/authorize')
    expect(url).toContain(`state=${state}`)
  })
})
```

## ベストプラクティス

1. **state検証を省略しない**: `handleCallback` は自動的にstateを検証・消費します。`code` だけを信頼するカスタムコールバックを実装しないでください。

2. **`allowedRedirectHosts` を明示的に設定する**: 設定しない場合、アプリ相対パスの `redirectTo` のみが許可されます（最も安全なデフォルト）。ログイン後に別ドメインへリダイレクトする場合のみホストを追加してください。

3. **本番環境では共有stateストアを使う**: `MemoryOAuthStateStore` は同じログインからのすべてのリクエストが同一プロセスに届く場合にのみ機能します。`DatabaseOAuthStateStore`（追加インフラ不要）か `RedisOAuthStateStore` を使ってください。

4. **メールアドレスではなくプロバイダーIDでアカウントを照合する**: プロバイダーの `profile.id`（例: `githubId`）をユーザーモデルに保存してください。メールアドレスは未検証だったり、プロバイダー間で使い回されたりする場合があります。

5. **必要最小限のスコープをリクエストする**: 各プロバイダーファクトリはデフォルトで小さめのスコープセット（例: GitHubの `read:user user:email`）を使用します。必要な場合のみ拡張してください。
