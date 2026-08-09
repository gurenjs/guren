# OAuth Guide

Guren ships an OAuth 2.0 authorization-code flow for "Sign in with GitHub / Google / Discord" style login. It handles the redirect, CSRF-safe state, token exchange, and profile fetch — you wire it into your own login controller and session.

## Core Concepts

- **OAuthManager** – Registers providers and drives the authorize → callback flow.
- **OAuthProviderConfig** – Client ID/secret, endpoints, and scopes for one provider (GitHub, Google, Discord, or any OAuth 2.0 provider).
- **OAuthStateStore** – One-time state storage that prevents CSRF and open-redirect attacks. Memory by default; use `DatabaseOAuthStateStore` (or Redis) for multi-process deployments.
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
    // Passing the session ties the flow to this browser — see
    // "Binding State to the Browser" below.
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

### Routes

```ts
import { Router } from '@guren/core'
import GitHubOAuthController from '@/app/Http/Controllers/Auth/GitHubOAuthController'

export function registerWebRoutes(router: Router): void {
  router.get('/auth/github', [GitHubOAuthController, 'start'])
  router.get('/auth/github/callback', [GitHubOAuthController, 'callback'])
}
```

## Binding State to the Browser

`state` is unguessable and single-use, but on its own it is also *transferable*.
An attacker can start a flow on your app, authorize their own provider account,
keep the resulting `code` unconsumed, and then get a visitor to open

```
https://your.app/auth/github/callback?code=<attacker's>&state=<attacker's>
```

Nothing in the pair identifies whose browser began the flow, so the callback
succeeds and logs that visitor into the **attacker's** account. Everything the
visitor writes afterwards — posts, uploads, a saved payment method — lands in an
account the attacker can also read.

Pass the session to both legs of the flow to close it:

```ts
// starting the flow
const { url } = await oauth.authorize('github', { session: this.auth.session() })

// in the callback
await oauth.handleCallback('github', { code, state, session: this.auth.session() })
```

`authorize()` mints a fresh per-flow value, keeps it in the session, and stores
only its hash with the state; `handleCallback()` reads the value back (removing
it in the same step) and refuses a state whose binding it cannot match. Writing
to the session is also what makes a first-time visitor's session persist across
the round trip to the provider, so the callback request carries the same one.
When `this.auth.session()` returns `undefined` — no session middleware — the
state is simply left unbound, so nothing breaks; it just stays unprotected.

If the binding must live somewhere other than the session (an encrypted cookie,
a native app's secure storage), manage the value yourself with `bindTo`: pass a
value only this browser can present back to `authorize()`, and hand the same
value to `handleCallback()`. `bindTo` wins when both options are given.

> [!WARNING]
> `authorize()` without `session` or `bindTo` still works, so apps written
> against the earlier API keep running, and it logs a warning once per process.
> Those apps remain open to the attack above until they adopt it. `make:auth`
> and the `oauth` blueprint generate the bound version.

## Redirect After Login

Pass a `redirectTo` when starting the flow (e.g. the page the user was on) — it survives the round trip to the provider and comes back from `handleCallback`:

```ts
const { url } = await oauth.authorize('github', {
  redirectTo: '/settings/billing',
  session: this.auth.session(),
})
// ...later, in the callback:
const { redirectTo } = await oauth.handleCallback('github', {
  code,
  state,
  session: this.auth.session(),
})
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

## Provider Email Verification

A provider returning an email is not a claim that it checked the address. Most report that separately — Google sends OIDC's `email_verified`, Discord sends `verified` — and the profile exposes it as `profile.emailVerified`:

| Value | Meaning |
|-------|---------|
| `true` | The provider says it verified the address |
| `false` | The provider says it did **not** |
| `undefined` | The provider sends no such signal — your app decides |

Refuse to *create* an account on `false`: an unverified address lets a user claim an email they do not own, and a callback that rejects duplicate emails then locks the real owner out for good. Check it only on the create path so an already-linked account is not stranded if its status changes later:

```ts
if (!user && profile.emailVerified === false) {
  throw ValidationException.withMessages({
    message: 'Your provider has not verified this email address.',
  })
}
```

The built-in presets declare their own key. For a provider you register yourself, set `emailVerifiedKey` when it uses a non-standard name — the default reads OIDC's `email_verified`, and only boolean values count:

```ts
const discordish: OAuthProviderConfig = {
  // ...
  emailVerifiedKey: 'verified',
}
```

`mapProfile` owns the whole mapping, so a provider using it sets `emailVerified` itself and `emailVerifiedKey` is ignored. GitHub's `/user` carries no verification field at all, so `emailVerified` stays `undefined` there — except when the private-email fallback runs, since `/user/emails` only yields verified primary addresses.

A `fetchFallbackEmail` hook is read against a response that had no email, so the key above cannot vouch for what it returns. Returning a bare string makes no claim and leaves the field `undefined`; return an object to state one:

```ts
fetchFallbackEmail: async (token) => ({ email: await lookupEmail(token), emailVerified: true }),
```

## State Storage

The one-time `state` value that ties the callback back to the original request is stored server-side. The default `MemoryOAuthStateStore` works for single-process dev, but production deployments with more than one process (load balancers, serverless) need shared storage — otherwise the callback can land on a process that never issued the state.

For most apps, `DatabaseOAuthStateStore` is the recommended default — it stores state in the same database your app already uses, with no extra infrastructure:

```ts
import { createOAuthManager, DatabaseOAuthStateStore } from '@guren/core'
import { oauthStates } from '@/db/schema'

export const oauth = createOAuthManager({
  stateStore: new DatabaseOAuthStateStore(oauthStates),
})
```

```ts
// db/schema.ts (sqlite dialect shown)
export const oauthStates = sqliteTable('oauth_states', {
  stateHash: text('state_hash').primaryKey(),
  provider: text('provider').notNull(),
  redirectTo: text('redirect_to'),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  binding: text('binding'),
})
```

The `binding` column holds the hashed browser binding from
[Binding State to the Browser](#binding-state-to-the-browser). Without it the
store cannot persist a binding, and every bound state comes back unbound — which
silently reverts the protection. Add the column before binding flows via
`session` or `bindTo`.

Expired state rows are removed as they are encountered; call `store.deleteExpired()` from a scheduled job for bulk cleanup. Redis remains available for apps that already run it:

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
  emailVerifiedKey?: string      // Userinfo key holding the verification signal (default: 'email_verified')
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

1. **Never skip state verification**: `handleCallback` verifies and consumes the state automatically — don't build a custom callback path that trusts `code` alone. Always pass `session` (or `bindTo`) as well; state verification on its own does not tell you the flow started in the same browser (see [Binding State to the Browser](#binding-state-to-the-browser)).

2. **Set `allowedRedirectHosts` explicitly**: without it, only app-relative `redirectTo` paths are honored, which is the safest default. Add hosts only if you redirect to a separate domain after login.

3. **Use a shared state store in production**: `MemoryOAuthStateStore` only works when every request from the same login hits the same process. Use `DatabaseOAuthStateStore` (no extra infrastructure) or `RedisOAuthStateStore`.

4. **Match accounts by provider ID, not email**: store the provider's `profile.id` (e.g. `githubId`) on your user model. Emails can be unverified or reused across providers.

5. **Request the minimum scopes you need**: each provider factory defaults to a small scope set (e.g. GitHub's `read:user user:email`) — extend it only when you need more.
