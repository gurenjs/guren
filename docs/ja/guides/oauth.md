# OAuthガイド

Guren は「GitHub / Google / Discordでサインイン」のようなログインのための OAuth 2.0 認可コードフローを提供します。リダイレクト、CSRF対策済みのstate管理、トークン交換、プロフィール取得を処理し、あなたは自分のログインコントローラーとセッションに組み込むだけです。

## コアコンセプト

- **OAuthManager** – プロバイダーを登録し、認可 → コールバックのフローを駆動します。
- **OAuthProviderConfig** – 1つのプロバイダー（GitHub、Google、Discord、または任意の OAuth 2.0 プロバイダー）のクライアントID/シークレット、エンドポイント、スコープ。
- **OAuthStateStore** – CSRFとオープンリダイレクト攻撃を防ぐ、一度限りのstateストレージ。デフォルトはメモリ、マルチプロセス構成ではRedisを使用します。
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
    const { url } = await oauth.authorize('github', {
      redirectTo: this.query('redirect_to'),
    })
    return this.redirect(url)
  }

  async callback() {
    const { code, state } = this.validateQuery(CallbackQuerySchema)
    const { profile, redirectTo } = await oauth.handleCallback('github', { code, state })

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

## ログイン後のリダイレクト

フロー開始時に `redirectTo`（ユーザーが元々いたページなど）を渡すと、プロバイダーとの往復を経ても保持され、`handleCallback` から返ってきます。

```ts
const { url } = await oauth.authorize('github', { redirectTo: '/settings/billing' })
// ...後で、コールバック内で:
const { redirectTo } = await oauth.handleCallback('github', { code, state })
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

## Stateストレージ

コールバックを元のリクエストに結びつける一度限りの `state` 値は、サーバー側で保存されます。デフォルトの `MemoryOAuthStateStore` は単一プロセスの開発環境では動作しますが、複数プロセス（ロードバランサー、サーバーレス）構成の本番環境では共有ストレージが必要です。そうしないと、コールバックがstateを発行していないプロセスに到達してしまう可能性があります。

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

3. **本番環境ではRedisのstateストレージを使う**: `MemoryOAuthStateStore` は同じログインからのすべてのリクエストが同一プロセスに届く場合にのみ機能します。

4. **メールアドレスではなくプロバイダーIDでアカウントを照合する**: プロバイダーの `profile.id`（例: `githubId`）をユーザーモデルに保存してください。メールアドレスは未検証だったり、プロバイダー間で使い回されたりする場合があります。

5. **必要最小限のスコープをリクエストする**: 各プロバイダーファクトリはデフォルトで小さめのスコープセット（例: GitHubの `read:user user:email`）を使用します。必要な場合のみ拡張してください。
