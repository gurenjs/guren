# OAuth Guide

Guren ships an OAuth 2.0 authorization-code flow for "Sign in with GitHub / Google / Discord" style login. It handles the redirect, CSRF-safe state, token exchange, and profile fetch — you wire it into your own login controller and session.

## Core Concepts

- **OAuthManager** – Registers providers and drives the authorize → callback flow.
- **OAuthProviderConfig** – Client ID/secret, endpoints, and scopes for one provider (GitHub, Google, Discord, or any OAuth 2.0 provider).
- **OAuthStateStore** – One-time state storage that prevents CSRF and open-redirect attacks. Memory by default, Redis for multi-process deployments.
- **Provider factories** – `createGitHubOAuthProviderConfig`, `createGoogleOAuthProviderConfig`, `createDiscordOAuthProviderConfig` pre-fill the well-known endpoints for each provider.

## Basic Setup

### Registering the Manager

`OAuthServiceProvider` binds an `OAuthManager` singleton as `oauth` in the container. Register your providers during app boot:

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

### Login Controller

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

### Routes

```ts
import { Router } from '@guren/core'
import GitHubOAuthController from '@/app/Http/Controllers/Auth/GitHubOAuthController'

export function registerWebRoutes(router: Router): void {
  router.get('/auth/github', [GitHubOAuthController, 'start'])
  router.get('/auth/github/callback', [GitHubOAuthController, 'callback'])
}
```

## Redirect After Login

Pass a `redirectTo` when starting the flow (e.g. the page the user was on) — it survives the round trip to the provider and comes back from `handleCallback`:

```ts
const { url } = await oauth.authorize('github', { redirectTo: '/settings/billing' })
// ...later, in the callback:
const { redirectTo } = await oauth.handleCallback('github', { code, state })
return this.redirect(redirectTo ?? '/dashboard')
```

`redirectTo` is sanitized automatically: app-relative paths (`/settings/billing`) always pass, but absolute URLs are dropped unless their host is in `allowedRedirectHosts`. This prevents an attacker from crafting a login link that redirects a user off-site after authenticating.

```ts
export const oauth = createOAuthManager({
  stateConfig: {
    allowedRedirectHosts: ['app.example.com', '*.example.com'], // supports wildcards
  },
})
```

## Built-in Providers

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

### Any OAuth 2.0 Provider

Providers you register directly need the raw endpoints and, optionally, a `mapProfile` function to normalize the user-info response:

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

## State Storage

The one-time `state` value that ties the callback back to the original request is stored server-side. The default `MemoryOAuthStateStore` works for single-process dev, but production deployments with more than one process (load balancers, serverless) need shared storage — otherwise the callback can land on a process that never issued the state.

```ts
import { createOAuthManager } from '@guren/core'
import { createRedisClient, RedisOAuthStateStore } from '@guren/core/redis'

const redis = createRedisClient({ url: process.env.REDIS_URL })

export const oauth = createOAuthManager({
  stateStore: new RedisOAuthStateStore(redis),
})
```

## Configuration Options

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
  expiresIn?: number             // State TTL in ms (default: 10 minutes)
  stateLength?: number           // Random state bytes (default: 24)
  hashAlgorithm?: 'sha256' | 'sha512'
  allowedRedirectHosts?: string[] // Absolute redirectTo hosts to allow (wildcards supported)
}
```

## Testing

```ts
import { describe, test, expect } from 'bun:test'
import { OAuthManager, MemoryOAuthStateStore, createGitHubOAuthProviderConfig } from '@guren/core'

describe('GitHub OAuth', () => {
  test('builds an authorize URL with state', async () => {
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

## Best Practices

1. **Never skip state verification**: `handleCallback` verifies and consumes the state automatically — don't build a custom callback path that trusts `code` alone.

2. **Set `allowedRedirectHosts` explicitly**: without it, only app-relative `redirectTo` paths are honored, which is the safest default. Add hosts only if you redirect to a separate domain after login.

3. **Use Redis state storage in production**: `MemoryOAuthStateStore` only works when every request from the same login hits the same process.

4. **Match accounts by provider ID, not email**: store the provider's `profile.id` (e.g. `githubId`) on your user model. Emails can be unverified or reused across providers.

5. **Request the minimum scopes you need**: each provider factory defaults to a small scope set (e.g. GitHub's `read:user user:email`) — extend it only when you need more.
