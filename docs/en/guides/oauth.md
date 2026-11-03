# OAuth Guide

Guren ships an OAuth 2.0 authorization-code flow for "Sign in with GitHub / Google / Discord" style login. It handles the redirect, CSRF-safe state, token exchange, and profile fetch. `make:auth --oauth` and `guren add oauth` scaffold it for you, and you can also wire it into a login controller of your own.

## Core Concepts

- **OAuthManager** – Registers providers and drives the authorize → callback flow.
- **OAuthProviderConfig** – Client ID/secret, endpoints, and scopes for one provider (GitHub, Google, Discord, or any OAuth 2.0 provider).
- **OAuthStateStore** – One-time state storage that prevents CSRF and open-redirect attacks. Memory by default; use `DatabaseOAuthStateStore` (or Redis) for multi-process deployments.
- **Provider factories** – `createGitHubOAuthProviderConfig`, `createGoogleOAuthProviderConfig`, `createDiscordOAuthProviderConfig` pre-fill the well-known endpoints for each provider.

The full flow has four parties. Your app is entered twice, and in between the state store answers one question: did this browser really start this flow?

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as Your app
  participant S as OAuthStateStore
  participant P as Provider<br/>(GitHub, …)

  B->>A: GET /auth/github
  A->>S: issue state, bound to the session
  A-->>B: 302 to the provider's authorize URL
  B->>P: user approves on the consent screen
  P-->>B: 302 /auth/github/callback?code=…&state=…
  B->>A: GET /auth/github/callback
  A->>S: match and consume the state (single use)
  A->>P: exchange the code for an access token
  P-->>A: token and profile
  A->>A: find or create the user, then sign in
  A-->>B: 302 /dashboard
```

## Scaffolding OAuth

There are two ways to add provider sign-in:

| Command | What you get |
|---------|--------------|
| `make:auth --oauth github,google` | Buttons on the generated login and registration pages, with account creation and linking already written |
| `guren add oauth` | The OAuth manager, a controller with a stub callback, and routes, for a sign-in flow you write yourself |

Don't run both against the same app: they write the same files, so the second run aborts (or, with `--force`, overwrites the first).

### OAuth login buttons

Pass `--oauth` with a comma-separated provider list to also scaffold "Continue with GitHub / Google / Discord" buttons on the login (and, unless `--minimal` is set, registration) pages:

```bash
bunx guren make:auth --install --oauth github,google
```

This adds:

- a `githubId` / `googleId` column per provider on the `users` table;
- a `config/oauth.ts` definition that registers each provider with the `OAuthManager` once its `OAUTH_<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET` and `_REDIRECT_URI` are all set (the command declares them in `config/env.ts`; see [Registering the Manager](#registering-the-manager));
- an `OAuthController` with `redirectToProvider` and `callback` actions.

The callback signs in the user linked to that provider ID. Otherwise:

- If an existing account has the same email, it refuses to link them: that account signs in with the method it was created with.
- If the provider reports the address as unverified (Google's `email_verified`, Discord's `verified`), it refuses to create an account, since an unverified address would let an account claim one it does not own. Existing links are unaffected if a provider's status changes later.
- Otherwise it creates a **passwordless** account and signs the user in. Nothing is hashed at signup, and the scaffolded `users.passwordHash` column is nullable.

`--oauth` without `--verify` scaffolds the profile email **read-only**: `ProfileUpdateSchema` omits the field and `ProfileController.update()` never reads one, so neither the form nor a hand-crafted request can move an account off the address its provider vouched for. With `--verify` the field stays editable, because a replacement address resets `emailVerifiedAt` and has to be confirmed through a link sent to it. Note that in every mode an address is only *claimed*, never reserved: registration accepts any well-formed email and `users.email` is unique, so an account already holding an address blocks its real owner's first OAuth sign-in. Add your own ownership checks if that matters for your app.

The OAuth state that ties the callback to its authorize redirect is kept in the database. `--oauth` adds an `oauth_states` table to `db/schema.ts`, covered by the same migration as `users` and `sessions`, and `config/oauth.ts` passes `DatabaseOAuthStateStore` as its `stateStore`. `--install` lists the definition in `createApp({ config })`. The redirect and the callback can then reach different processes, which on Workers, Lambda and Vercel is the normal case (see [State Storage](#state-storage)). An app with no `db/schema.ts` gets the definition without a `stateStore`, so state stays in process memory.

The definition is what the command writes once `config/env.ts` exists and no provider binds `oauth`. Otherwise it writes `app/Providers/OAuthProvider.ts` with the same registrations (plus `CoreOAuthServiceProvider` when there is no `db/schema.ts`) and wires that provider instead. Apps that configure OAuth in a service provider keep working; see [Apps with service providers](./configuration.md#apps-with-service-providers).

### OAuth as the only sign-in method

`--oauth` still scaffolds password login alongside the buttons. Add `--oauth-only` to drop it entirely:

```bash
bunx guren make:auth --install --oauth github --oauth-only
```

`/login` becomes a provider-buttons page with no credential form and no `POST /login` route; `LoginController` keeps only `show()` and `destroy()` (logout). Registration, password reset, the login and profile password fields, `LoginValidator`, and the demo `UsersSeeder` are all skipped: a seeded password could never be used to sign in. `--oauth-only` requires `--oauth` with at least one provider (otherwise the app would have no way in at all) and subsumes `--minimal`; `--verify` is skipped under it, since provider-supplied emails arrive already vouched for.

Like plain `--oauth` without `--verify`, the profile email is read-only in this mode (see above).

`make:auth` only writes the files it scaffolds; it never deletes. Converting an existing password app with `--oauth-only --force` therefore leaves the old registration and reset files behind, and the scaffold prints the list. Delete them: the stale `db/seeders/UsersSeeder.ts` in particular is picked up by `db:seed` rather than by the route table, so a dead `routes/auth.ts` does not neutralize it.

This is the recommended shape for CPU-metered runtimes such as the Cloudflare Workers free tier, where a single password hash exceeds the per-request CPU budget no matter which hashing algorithm you pick.

### `guren add oauth`

Guren ships OAuth primitives plus provider presets for GitHub, Google and Discord. `guren add oauth` sets them up without the `make:auth` pages:

```bash
bunx guren add oauth
```

This creates:

- `config/oauth.ts`
- `app/Http/Controllers/Auth/OAuthController.ts`
- `routes/oauth.ts`

and lists the `config/oauth.ts` definition in `createApp({ config })`. The definition binds the `oauth` manager; its contents are shown in [Registering the Manager](#registering-the-manager) below.

It also adds an `oauth_states` table to `db/schema.ts` and generates its migration (run `bun run db:make` yourself if `drizzle-kit` is not installed yet), and registers the `oauth-states:prune` command. `config/oauth.ts` passes `DatabaseOAuthStateStore` as its `stateStore`, so the callback does not need to reach the process that issued the authorize redirect, which on Workers, Lambda and Vercel it usually does not (see [State Storage](#state-storage)). `CoreOAuthServiceProvider` is not registered, because its manager keeps state in process memory. The command refuses to run in an app with no `db/schema.ts`, and writes nothing.

As with [`--oauth`](#oauth-login-buttons), an app without `config/env.ts`, or with a provider already binding `oauth`, gets `app/Providers/OAuthProvider.ts` with the same registrations and store instead.

`routes/oauth.ts` registers two routes. `GET /auth/:provider` creates a signed state and redirects to the provider's consent screen; `GET /auth/:provider/callback` validates the state, exchanges the code for a token and fetches the profile. Each provider's three `OAUTH_<PROVIDER>_*` keys are declared in `config/env.ts` and added, blank, to `.env`; [Registering the Manager](#registering-the-manager) shows how the definition reads them.

## Basic Setup

### Registering the Manager

`config/oauth.ts` default-exports a `defineOAuthConfig` definition. Its callback receives the validated env and returns the providers to register and the state store; the definition builds an `OAuthManager` from them and binds it as `oauth` in the container. `bunx guren add oauth` writes this file:

```ts
// config/oauth.ts
import { DatabaseOAuthStateStore, defineOAuthConfig, type OAuthProviderConfig, createGitHubOAuthProviderConfig, createGoogleOAuthProviderConfig, createDiscordOAuthProviderConfig } from '@guren/core'
import { oauthStates } from '../db/schema.js'

export default defineOAuthConfig((env) => {
  // A provider is registered only when all three of its keys are set, so a
  // half-configured one fails app-side rather than at the provider.
  const providers: Record<string, OAuthProviderConfig> = {}

  if (env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET && env.OAUTH_GITHUB_REDIRECT_URI) {
    providers.github = createGitHubOAuthProviderConfig({
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
      redirectUri: env.OAUTH_GITHUB_REDIRECT_URI,
    })
  }

  if (env.OAUTH_GOOGLE_CLIENT_ID && env.OAUTH_GOOGLE_CLIENT_SECRET && env.OAUTH_GOOGLE_REDIRECT_URI) {
    providers.google = createGoogleOAuthProviderConfig({
      clientId: env.OAUTH_GOOGLE_CLIENT_ID,
      clientSecret: env.OAUTH_GOOGLE_CLIENT_SECRET,
      redirectUri: env.OAUTH_GOOGLE_REDIRECT_URI,
    })
  }

  if (env.OAUTH_DISCORD_CLIENT_ID && env.OAUTH_DISCORD_CLIENT_SECRET && env.OAUTH_DISCORD_REDIRECT_URI) {
    providers.discord = createDiscordOAuthProviderConfig({
      clientId: env.OAUTH_DISCORD_CLIENT_ID,
      clientSecret: env.OAUTH_DISCORD_CLIENT_SECRET,
      redirectUri: env.OAUTH_DISCORD_REDIRECT_URI,
    })
  }

  return {
    providers,
    // The authorize redirect and its callback may reach different processes, so
    // the state tying them together lives in the database, not in memory.
    stateStore: new DatabaseOAuthStateStore(oauthStates),
  }
})
```

Each provider reads three keys, `OAUTH_<PROVIDER>_CLIENT_ID`, `_CLIENT_SECRET` and `_REDIRECT_URI`, declared in `config/env.ts` (see [Configuration](./configuration.md#declaring-the-environment)); `guren add oauth` declares them for you. `_REDIRECT_URI` is the full callback URL, such as `https://your.app/auth/github/callback`. A provider whose keys are not all set is left unregistered, and starting its flow throws `OAuth provider "github" is not configured.`

List the definition in `createApp({ config })`:

```ts
// src/app.ts
import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import oauth from '../config/oauth.js'

const app = createApp({
  env,
  config: [database, oauth],
})
```

Apps that configure OAuth in a service provider keep working; see [Apps with service providers](./configuration.md#apps-with-service-providers).

### Login Controller

```ts
import { Controller, type OAuthManager } from '@guren/core'
import { z } from 'zod'
import { User } from '@/app/Models/User'

const CallbackQuerySchema = z.object({
  code: z.string(),
  state: z.string(),
})

export default class GitHubOAuthController extends Controller {
  private oauth(): OAuthManager {
    return this.make<OAuthManager>('oauth')
  }

  async start() {
    // Passing the session ties the flow to this browser — see
    // "Binding State to the Browser" below.
    const { url } = await this.oauth().authorize('github', {
      redirectTo: this.query('redirect_to'),
      session: this.auth.session(),
    })
    return this.redirect(url)
  }

  async callback() {
    const { code, state } = this.validateQuery(CallbackQuerySchema)

    const { profile, redirectTo } = await this.oauth().handleCallback('github', {
      code,
      state,
      session: this.auth.session(),
    })

    let user = await User.where('githubId', profile.id).first()
    if (!user) {
      user = await User.create({ email: profile.email, name: profile.name }, { set: { githubId: profile.id } })
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
visitor writes afterwards (posts, uploads, a saved payment method) lands in an
account the attacker can also read.

Pass the session to both legs of the flow to close it:

```ts
// starting the flow
const { url } = await this.oauth().authorize('github', { session: this.auth.session() })

// in the callback
await this.oauth().handleCallback('github', { code, state, session: this.auth.session() })
```

`authorize()` mints a fresh per-flow value, keeps it in the session, and stores
only its hash with the state; `handleCallback()` reads the value back (removing
it in the same step) and refuses a state whose binding it cannot match. Writing
to the session is also what makes a first-time visitor's session persist across
the round trip to the provider, so the callback request carries the same one.
When `this.auth.session()` returns `undefined` (no session middleware), the
state is simply left unbound, so nothing breaks; it just stays unprotected.

If the binding must live somewhere other than the session (an encrypted cookie,
a native app's secure storage), manage the value yourself with `bindTo`: pass a
value only this browser can present back to `authorize()`, and hand the same
value to `handleCallback()`. `bindTo` wins when both options are given.

A bound state carries a short marker, so boundness travels with the state rather
than only in the store: a store that cannot keep `binding` then rejects the
callback instead of quietly accepting a transferable state. Send the `state` that
`authorize()` returns, including when you supplied one of your own.

> [!WARNING]
> `authorize()` without `session` or `bindTo` still works, so apps written
> against the earlier API keep running, and it logs a warning once per process.
> Those apps remain open to the attack above until they adopt it. `make:auth`
> and the `oauth` blueprint generate the bound version.

## Redirect After Login

Pass a `redirectTo` when starting the flow (e.g. the page the user was on). It survives the round trip to the provider and comes back from `handleCallback`:

```ts
const { url } = await this.oauth().authorize('github', {
  redirectTo: '/settings/billing',
  session: this.auth.session(),
})
// ...later, in the callback:
const { redirectTo } = await this.oauth().handleCallback('github', {
  code,
  state,
  session: this.auth.session(),
})
return this.redirect(redirectTo ?? '/dashboard')
```

`redirectTo` is sanitized automatically: app-relative paths (`/settings/billing`) always pass, but absolute URLs are dropped unless their host is in `allowedRedirectHosts`. This prevents an attacker from crafting a login link that redirects a user off-site after authenticating.

Protocol-relative URLs (`//evil.com`), backslash variants and non-http schemes are dropped as well. A dropped `redirectTo` comes back as `undefined`, so your fallback applies.

The allowlist goes in the definition's `stateConfig`, next to the providers and the state store:

```ts
// config/oauth.ts, the end of the defineOAuthConfig callback
return {
  providers,
  stateStore: new DatabaseOAuthStateStore(oauthStates),
  stateConfig: {
    allowedRedirectHosts: ['app.example.com', '*.example.com'], // supports wildcards
  },
}
```

> [!NOTE]
> `createRedirectSafetyMiddleware` (opt-in) validates `Location` headers with its own separate `allowedHosts` option. If you mount it, keep both allowlists in agreement, or the middleware rewrites an approved external redirect to `/`.

## Built-in Providers

Each factory fills in the provider's endpoints and default scopes, so the definition passes only the three keys. `config/oauth.ts` above registers all three:

| Provider | Factory | Keys |
|----------|---------|------|
| GitHub | `createGitHubOAuthProviderConfig` | `OAUTH_GITHUB_CLIENT_ID`, `OAUTH_GITHUB_CLIENT_SECRET`, `OAUTH_GITHUB_REDIRECT_URI` |
| Google | `createGoogleOAuthProviderConfig` | `OAUTH_GOOGLE_CLIENT_ID`, `OAUTH_GOOGLE_CLIENT_SECRET`, `OAUTH_GOOGLE_REDIRECT_URI` |
| Discord | `createDiscordOAuthProviderConfig` | `OAUTH_DISCORD_CLIENT_ID`, `OAUTH_DISCORD_CLIENT_SECRET`, `OAUTH_DISCORD_REDIRECT_URI` |

Delete the block for a provider you do not offer, along with its keys in `config/env.ts`.

### Any OAuth 2.0 Provider

A provider without a factory needs the raw endpoints and, optionally, a `mapProfile` function to normalize the user-info response. Add it to `providers` in `config/oauth.ts`, and declare its three `OAUTH_GITLAB_*` keys in `config/env.ts`:

```ts
// config/oauth.ts, inside the defineOAuthConfig callback
if (env.OAUTH_GITLAB_CLIENT_ID && env.OAUTH_GITLAB_CLIENT_SECRET && env.OAUTH_GITLAB_REDIRECT_URI) {
  providers.gitlab = {
    clientId: env.OAUTH_GITLAB_CLIENT_ID,
    clientSecret: env.OAUTH_GITLAB_CLIENT_SECRET,
    redirectUri: env.OAUTH_GITLAB_REDIRECT_URI,
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
}
```

On a manager you build yourself with `createOAuthManager()`, `manager.registerProvider('gitlab', config)` registers the same object, as the [test below](#testing) does with a built-in factory.

## Provider Email Verification

A provider returning an email is not a claim that it checked the address. Most report that separately (Google sends OIDC's `email_verified`, Discord sends `verified`), and the profile exposes it as `profile.emailVerified`:

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

The built-in presets declare their own key. For a provider you register yourself, set `emailVerifiedKey` when it uses a non-standard name. The default reads OIDC's `email_verified`, and only boolean values count:

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

The one-time `state` value that ties the callback back to the original request is stored server-side. The default `MemoryOAuthStateStore` works for single-process dev, but production deployments with more than one process (load balancers, serverless) need shared storage. Otherwise the callback can land on a process that never issued the state.

For most apps, `DatabaseOAuthStateStore` is the recommended default, since it stores state in the same database your app already uses, with no extra infrastructure. `guren add oauth` and `make:auth --oauth` pass it as the definition's `stateStore`, as shown in [Registering the Manager](#registering-the-manager). The store reads an `oauth_states` table:

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
store cannot persist a binding, so every bound state comes back unbound and
`handleCallback` rejects it with "Invalid or expired OAuth state" (a warning on
the console names the store as the cause). Add the column before binding flows
via `session` or `bindTo`.

A state row is removed when its callback arrives, so a sign-in abandoned before that keeps its row. Schedule `oauth-states:prune`, the console command `guren add oauth` registers, to sweep the expired ones; it calls `OAuthManager.pruneExpiredStates()` on the store behind your `oauth` binding. Redis remains available for apps that already run it, and expires its own keys. Declare `REDIS_URL` in `config/env.ts`:

```ts
// config/oauth.ts
import { defineOAuthConfig } from '@guren/core'
import { createRedisClient, RedisOAuthStateStore } from '@guren/core/redis'

export default defineOAuthConfig((env) => ({
  providers: {
    // one entry per provider, as in Registering the Manager
  },
  stateStore: new RedisOAuthStateStore(createRedisClient({ url: env.REDIS_URL })),
}))
```

Unlike a cache or queue driver, `stateStore` is a value rather than a factory, so this client connects when the app boots, not on the first sign-in.

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

1. **Never skip state verification**: `handleCallback` verifies and consumes the state automatically, so don't build a custom callback path that trusts `code` alone. Always pass `session` (or `bindTo`) as well; state verification on its own does not tell you the flow started in the same browser (see [Binding State to the Browser](#binding-state-to-the-browser)).

2. **Set `allowedRedirectHosts` explicitly**: without it, only app-relative `redirectTo` paths are honored, which is the safest default. Add hosts only if you redirect to a separate domain after login.

3. **Use a shared state store in production**: `MemoryOAuthStateStore` only works when every request from the same login hits the same process. Use `DatabaseOAuthStateStore` (no extra infrastructure) or `RedisOAuthStateStore`.

4. **Match accounts by provider ID, not email**: store the provider's `profile.id` (e.g. `githubId`) on your user model. Emails can be unverified or reused across providers.

5. **Request the minimum scopes you need**: each provider factory defaults to a small scope set (e.g. GitHub's `read:user user:email`). Extend it only when you need more.
