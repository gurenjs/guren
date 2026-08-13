# Authentication Guide

Guren ships with a Laravel-inspired authentication stack that sits on top of the session middleware and the ORM layer. The goal is to match the expressiveness of Laravel's guards and user providers while staying idiomatic to TypeScript and Bun.

## Core Concepts

- **AuthManager** – central registry for guards and user providers. Resolved from the service container via `this.container.make<AuthManager>('auth')`.
- **Guards** – runtime objects responsible for authenticating a request. The default `SessionGuard` persists the logged-in user's identifier inside the session and supports optional "remember me" tokens.
- **User Providers** – data access adapters used by guards to load and validate users. `ModelUserProvider` integrates with Guren's `Model` abstraction so you can back authentication with Drizzle ORM tables.
- **Auth Context** – per-request facade that surfaces guard helpers (`auth.check()`, `auth.user()`, `auth.login()`, etc.). The context is attached automatically by `AuthServiceProvider`; it is available in controllers via the `this.auth` helper and in middleware through `attachAuthContext`.
- **OAuthManager** – social login helper that manages provider configs, CSRF-safe OAuth state, code exchange, and user profile fetch.

## Quickstart via CLI

For new applications, run the bundled scaffolder with automatic installation (the session middleware will be auto-attached by default):

```bash
bunx guren make:auth --install
```

This command generates login, registration, and password reset controllers, Inertia pages, a layout, `AuthProvider`, `MailProvider`, user model, SQL migration, and a demo seeder. The `--install` flag automatically:

1. Registers `AuthProvider` and `MailProvider` in your `Application` providers array
2. Adds `createSessionMiddleware` with development-friendly defaults (uses `cookieSecure: true` in production)
3. Wires `registerAuthRoutes(router)` into `routes/web.ts`
4. Updates `db/schema.ts` to include password and remember-token columns

After scaffolding, simply run:

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

Visit `http://localhost:3000/login` and sign in with `demo@example.com` / `secret`, or visit `/register` to create a new account.

Pass `--minimal` to skip the registration and password reset scaffold and generate the login-only experience instead:

```bash
bunx guren make:auth --install --minimal
```

### Password reset

Clicking "Forgot your password?" on the login page walks through `ForgotPasswordController` and `ResetPasswordController`, which use the framework's `createPasswordResetToken` / `verifyPasswordResetToken` primitives under the hood. The reset token is stored with the generated `app/Auth/PasswordResetStore.ts` (an in-memory store — swap it for a Redis-backed store in production or any multi-instance deployment) and emailed via the generated `config/mail.ts`, which defaults to the `log` driver: reset links print straight to the console, so the flow works with zero setup in development. Set `MAIL_DRIVER=smtp` (and the `SMTP_*` environment variables) once you're ready to send real email.

### Email verification

Pass `--verify` to also scaffold an email verification flow:

```bash
bunx guren make:auth --install --verify
```

This adds an `emailVerifiedAt` column to the `users` table, a `VerifyEmailController` (shows a "check your email" notice, resends the verification link, and confirms the token), and a `VerifyEmail` page. Registering now sends a verification email and redirects to `/verify-email` instead of `/dashboard`, and the generated `/dashboard` route is guarded with `requireVerifiedEmail` — unverified users are redirected back to `/verify-email` until they confirm. Verification links use the same in-memory store and `log`-driver mail setup as password reset, so this also works with zero setup in development. `--verify` requires the default (non-minimal) experience, since it builds on the registration flow.

### OAuth login buttons

Pass `--oauth` with a comma-separated provider list to also scaffold "Continue with GitHub / Google / Discord" buttons on the login (and, unless `--minimal` is set, registration) pages:

```bash
bunx guren make:auth --install --oauth github,google
```

This adds a `githubId` / `googleId` column per provider to the `users` table, an `OAuthProvider` that registers each provider against the shared `OAuthManager` (only once its client ID, secret, and redirect URI are all set — see [OAuth / Social login](#oauth-social-login) below for the env var names), and an `OAuthController` with `redirectToProvider` and `callback` actions. The callback looks up the user by provider ID, refuses to link an existing account with the same email (that account signs in with the method it was created with), and otherwise creates a **passwordless** account before logging the user in — nothing is hashed at signup, and the scaffolded `users.passwordHash` column is left nullable. Account creation is refused when the provider reports the address as unverified (Google's `email_verified`, Discord's `verified`); returning an email is not a claim that the provider checked it, and an unverified one would let an account claim an address it does not own. Existing links are unaffected if a provider's status changes later. Unlike `--verify`, `--oauth` works with `--minimal` — it doesn't depend on the registration scaffold.

`--oauth` without `--verify` scaffolds the profile email **read-only**: `ProfileUpdateSchema` omits the field and `ProfileController.update()` never reads one, so neither the form nor a hand-crafted request can move an account off the address its provider vouched for. With `--verify` the field stays editable, because a replacement address resets `emailVerifiedAt` and has to be confirmed through a link sent to it. Note that in every mode an address is only *claimed*, never reserved: registration accepts any well-formed email and `users.email` is unique, so an account already holding an address blocks its real owner's first OAuth sign-in. Add your own ownership checks if that matters for your app.

`--oauth` shares its `OAuthController` / `OAuthProvider` file paths and wiring conventions with `guren add oauth` below, just with a complete (not stub) callback — don't run both against the same app, since the second run either aborts (no `--force`) or overwrites the first (`--force`).

### OAuth as the only sign-in method

`--oauth` still scaffolds password login alongside the buttons. Add `--oauth-only` to drop it entirely:

```bash
bunx guren make:auth --install --oauth github --oauth-only
```

`/login` becomes a provider-buttons page with no credential form and no `POST /login` route; `LoginController` keeps only `show()` and `destroy()` (logout). Registration, password reset, the login and profile password fields, `LoginValidator`, and the demo `UsersSeeder` are all skipped — a seeded password could never be used to sign in. `--oauth-only` requires `--oauth` with at least one provider (otherwise the app would have no way in at all) and subsumes `--minimal`; `--verify` is skipped under it, since provider-supplied emails arrive already vouched for.

Like plain `--oauth` without `--verify`, the profile email is read-only in this mode — see above.

`make:auth` only writes the files it scaffolds; it never deletes. Converting an existing password app with `--oauth-only --force` therefore leaves the old registration and reset files behind — the scaffold prints the list. Delete them: the stale `db/seeders/UsersSeeder.ts` in particular is picked up by `db:seed` rather than by the route table, so a dead `routes/auth.ts` does not neutralize it.

This is the recommended shape for CPU-metered runtimes such as the Cloudflare Workers free tier, where a single password hash exceeds the per-request CPU budget no matter which hashing algorithm you pick.

## OAuth / Social login

Guren ships first-party OAuth primitives plus provider presets for GitHub / Google / Discord. This is a lower-level, standalone scaffold — for OAuth buttons wired directly into `make:auth`'s login/registration pages with automatic account creation, see [OAuth login buttons](#oauth-login-buttons) above instead.

### Scaffold OAuth in an app

```bash
bunx guren add oauth
```

This creates:

- `app/Providers/OAuthProvider.ts`
- `app/Http/Controllers/Auth/OAuthController.ts`
- `routes/oauth.ts`

and wires `CoreOAuthServiceProvider` + `OAuthProvider` into `src/app.ts`.

### Configure provider credentials

```bash
OAUTH_GITHUB_CLIENT_ID=...
OAUTH_GITHUB_CLIENT_SECRET=...
OAUTH_GITHUB_REDIRECT_URI=https://your-app.test/auth/github/callback
```

Equivalent env names exist for `GOOGLE` and `DISCORD`.

### Route flow

```ts
router.get('/auth/:provider', [OAuthController, 'redirectToProvider'])
router.get('/auth/:provider/callback', [OAuthController, 'callback'])
```

`redirectToProvider` creates a signed state and redirects to the provider consent screen.  
`callback` validates state, exchanges code for token, then fetches the remote profile.

### Post-login redirect (`redirectTo`)

Pass `redirectTo` when starting the flow and read it back — sanitized — after the callback. In the scaffolded `OAuthController` (which resolves the manager with `this.oauth()`):

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
  // ...log the user in...
  return this.redirect(redirectTo ?? '/')
}
```

`redirectTo` is guarded against open redirects on both ends of the flow: only app-relative paths (`/settings`) survive by default. Protocol-relative URLs (`//evil.com`), backslash variants, non-http schemes, and unlisted hosts are dropped — `redirectTo` comes back as `undefined` and your fallback applies.

To allow specific external hosts (wildcards supported), bind the manager with an allowlist before anything resolves it — in a scaffolded app, at the top of `app/Providers/OAuthProvider.ts`'s `register()`:

```ts
this.container.singleton('oauth', () =>
  createOAuthManager({
    stateConfig: { allowedRedirectHosts: ['accounts.example.com', '*.example.org'] },
  }),
)
```

> **Note:** `createRedirectSafetyMiddleware` (opt-in) validates `Location` headers with its own separate `allowedHosts` option. If you mount it, keep both allowlists in agreement — otherwise the middleware rewrites an approved external redirect to `/`.

### Manual Setup

If you prefer to configure manually or already have partial setup, omit the `--install` flag:

```bash
bunx guren make:auth
```

Then manually:
1. Register `AuthProvider` in `src/app.ts`
2. Add `createSessionMiddleware` to your middleware stack (auto-added by `AuthServiceProvider` unless you opt out)
3. Register `registerAuthRoutes(router)` from `routes/web.ts`

The `--install` flag is safe and idempotent – it won't duplicate existing configuration.

## Enabling Sessions

Guards need access to the session. By default, `AuthServiceProvider` will attach `createSessionMiddleware` for you. To customize or disable it, pass auth options to `createApp()`:

```ts
import { createApp } from '@guren/core'

const app = createApp({
  auth: {
    autoSession: true, // set false to opt out
    sessionOptions: {
      cookieSecure: process.env.NODE_ENV === 'production',
    },
  },
})
```

If you need manual control, register the middleware explicitly in `src/app.ts`:

```ts
import { createApp, createSessionMiddleware } from '@guren/core'

const app = createApp()
app.use('*', createSessionMiddleware())
```

`cookieSecure` controls whether the session cookie is marked `Secure` (only sent over HTTPS). In production you should keep it `true`; in local development it is set to `false` by default so cookies work over http://localhost.

**Application auth options**
- `autoSession` (default `true`): automatically attaches `createSessionMiddleware`.
- `sessionOptions` (forwarded to `createSessionMiddleware`):
  - `cookieName` (default `guren.session`)
  - `cookieSecure` (default `true` in production, `false` in dev/local)
  - `cookieSameSite` (default `Lax`)
  - `cookieHttpOnly` (default `true`)
  - `cookieMaxAgeSeconds` (optional; falls back to `ttlSeconds`)
  - `ttlSeconds` (default 2 hours)
  - `store` (default in-memory; swap for your own implementation for multi-instance deployments)

## Configuring Providers & Guards

### Using the `auth.useModel()` Shorthand (Recommended)

The simplest way to configure authentication is using the `auth.useModel()` helper, which registers both a `ModelUserProvider` and `SessionGuard` in one call:

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

This single method call:
- Registers a `ModelUserProvider` with the specified columns
- Creates a `SessionGuard` with proper session handling
- Sets up the default guard as 'web'
- Uses `ScryptHasher` (based on Bun's native scrypt) by default

### Manual Configuration (Advanced)

For advanced use cases requiring custom providers or guards, you can still configure them manually:

```ts
import { ServiceProvider } from '@guren/core'
import { ModelUserProvider, SessionGuard } from '@guren/core'
import type { AuthManager } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')

    // Register the provider
    auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    }))

    // Register a custom guard
    auth.registerGuard('web', ({ session, manager }) => {
      const provider = manager.getProvider('users')
      return new SessionGuard({ provider, session })
    })

    auth.setDefaultGuard('web')
  }
}
```

Pair this with the `AuthenticatableModel` base class (see below) to get automatic password hashing and validation helpers.

### Authenticatable Models

Models that extend `AuthenticatableModel` receive first-class password handling. Providing a plain `password` property when calling `create` or `update` automatically hashes and stores it in the `passwordHash` column (configurable via static properties). The framework never persists the plain text password, and authentication continues to rely on the same hashing algorithm as the providers.

```ts
import { AuthenticatableModel, defineModel } from '@guren/core'
import { users } from '@/db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
}) {
  // Optional:
  // static override passwordField = 'plainPassword'
  // static override passwordHashField = 'password_digest'
}
```

Pass `AuthenticatableModel` as the `base` and reshape the create payload in the same call. The type `defineModel()` infers from the table requires every non-defaulted column, which is the wrong shape here: callers pass a plain `password` the model hashes for them, not a `passwordHash`. `optionalOnCreate` makes the column optional and `requireOnCreate` makes the virtual field required, both at the type level with no cast and no redeclared markers.

Optional means optional: a caller may still pass `passwordHash` and it will type-check. At runtime, `AuthenticatableModel` denies the hash column (and the remember token) from mass assignment entirely — a request body carrying it throws a `MassAssignmentException`, whatever the model's `fillable` says. Use `forceCreate()` / `forceUpdate()` for trusted server-side values such as `passwordHash: 'oauth:...'`.

Leave `requireOnCreate` off when accounts can also arrive without a password — an OAuth-only sign-up, for instance — so `password` stays optional.

The default `AuthServiceProvider` automatically registers a `web` guard that uses the `users` provider. If you need additional guards (e.g. token-based APIs), call `auth.registerGuard('api', factory)` inside the provider and set it as default via `auth.setDefaultGuard('api')` when appropriate.

## Controllers & Routes

Controllers now expose an `auth` helper:

```ts
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()       // returns user or null
    return this.inertia(pages.dashboard.Index, { user })
  }

  async store() {
    const user = await this.auth.userOrFail()  // throws 401 if not authenticated
    // user is guaranteed non-null here
    await Post.create({ authorId: user.id, ...data })
    return this.redirect('/posts')
  }
}
```

Use `this.validateBody()` / `this.validateQuery()` / `this.validateParams()` with Zod schemas for typed validation. Reserve `FormRequest` for compatibility code.

Surfacing the logged-in user on every Inertia page is already wired for you. The `app/Providers/AuthProvider.ts` that `bunx guren add auth` (equivalently `bunx guren make:auth --install`) generates registers it in `boot()`, so `auth.user` is readable from every page's props right after scaffolding — it is what the generated layout reads to toggle between **Sign in** and **Log out**.

```ts
// app/Providers/AuthProvider.ts (generated; register()'s useModel setup elided)
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

If you assembled authentication by hand, make the same call from your own service provider's `boot()`.

Sharing `auth.user()` this way is safe by default: the record is sanitized before it leaves the auth layer, so the password hash never reaches the browser (see [Sanitized User Records](#sanitized-user-records)).

Augment `InertiaSharedProps` (see the Controllers guide) to type this `auth` payload for React pages.

> `shareInertiaProps` merges its props over whatever was registered before, so
> several parts of your app (auth, i18n, flash, …) can each contribute without
> clobbering one another:
>
> ```ts
> shareInertiaProps((ctx) => ({ i18n: { locale: detectLocale(ctx) } }), this.container)
> ```
>
> Pass `this.container` to scope the props to one application; without it they
> are process-wide and leak into a second application booted alongside.
>
> `setInertiaSharedProps` replaces the process-wide resolver rather than
> merging, dropping whatever is registered at the moment it runs. Reach for it
> only when you mean to replace the whole thing.

Route middleware makes protecting endpoints straightforward:

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

## Session Guard Helpers

- `auth.check()` – resolves to `true` when a user is authenticated.
- `auth.user()` – returns the current user record (or `null`), sanitized: the password hash, remember token, and the model's `hidden` fields are stripped.
- `auth.userOrFail()` – returns the current user or throws `AuthenticationException` (401). Useful when you know the route is protected and want to avoid null checks.
- `auth.login(user, remember?)` – logs in the given user and optionally issues a remember token.
- `auth.attempt(credentials, remember?)` – validates credentials using the active guard and logs in on success.
- `auth.logout()` – clears the session and remember token.

## Sanitized User Records

`auth.user()` — and the cached user available right after `login()` or `attempt()` — never exposes credential material. `ModelUserProvider` strips the password column, the remember-token column, and any fields the model marks as `hidden` before the record leaves the auth layer:

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

The `make:auth` scaffolder generates the user model with this `hidden` configuration out of the box. See [Hiding Fields](./database.md#hiding-fields) for the option and the still-supported `static hidden = [...]` form.

Credential validation still runs on the raw database record internally, so login and remember-me tokens are unaffected — sanitization only changes what `auth.user()` exposes to application code.

Custom user providers can opt in by implementing the optional `sanitize(user)` method on the `UserProvider` interface. `SessionGuard` calls it before caching or returning the user:

```ts
sanitize(user: AuthUser): AuthUser {
  const { passwordHash, ...safe } = user
  return safe as AuthUser
}
```

### Typing Sanitized Users

Sanitization happens at runtime, so a plain `auth.user<UserRecord>()` would still *type* the record as if the credential fields were present. Use the `Sanitized<T>` helper to strip the conventional credential keys from the type:

```ts
import type { Sanitized } from '@guren/core'

// Strips password/passwordHash/rememberToken-style keys from the type
const user = await this.auth.userOrFail<Sanitized<UserRecord>>()

user.email        // ✅ string
user.passwordHash // ❌ compile error — stripped at runtime
```

If your model hides additional fields via `hidden`, or your credential columns use names outside the conventions (`password`, `passwordHash`, `password_hash`, `rememberToken`, `remember_token`), list them in the second type parameter:

```ts
type SafeUser = Sanitized<UserRecord, 'twoFactorSecret' | 'credentialDigest'>
```

The runtime strips exactly the columns your provider is configured with plus the model's `hidden` fields — a static type cannot see that configuration, so `Sanitized<T>` reflects the conventional names and relies on you to pass anything else. `guren audit` warns about sensitive columns missing from `hidden`, which keeps the runtime side honest.

## Remember Tokens

`SessionGuard` manages remember tokens automatically when your user provider implements `setRememberToken` / `getRememberToken`. `ModelUserProvider` handles this when the `rememberTokenColumn` option is supplied.

## Example Application

The blog example includes the full authentication stack:

- `AuthProvider` and `OAuthProvider` for guard/provider setup
- Login, registration, password reset, and email verification controllers, plus `DashboardController`
- Inertia pages under `resources/js/pages/auth/` (`Login`, `Register`, `ForgotPassword`, `ResetPassword`, `VerifyEmail`) and `resources/js/pages/dashboard/Index.tsx`
- OAuth login buttons for GitHub and Google
- Database schema, migration, and seeder for `users`

Run the demo with:

```bash
bun run dev
```

Visit `http://localhost:3333/login` and sign in using the seeded credentials `demo@guren.dev` / `secret`, or visit `/register` to create a new account.
