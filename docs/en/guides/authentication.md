# Authentication Guide

Add sign-in, registration and password reset to an app with one command, then protect routes and read the signed-in user in controllers. The first half of this page covers that generated setup; the second half covers guards and user providers, for when you change how it works. Sessions and OAuth sign-in have their own guides, [Sessions](./sessions.md) and [OAuth](./oauth.md).

## Quickstart

Run the scaffolder with `--install` (`bunx guren add auth` does the same):

```bash
bunx guren make:auth --install
```

The command writes:

- login, registration, password reset and profile controllers, their Inertia pages and a layout, and `routes/auth.ts`;
- `AuthProvider`, the `User` model, a demo seeder, and `config/mail.ts` for the reset emails;
- the `users` columns and a `sessions` table in `db/schema.ts`, `config/session.ts`, and one migration for both.

`--install` then wires it into the app:

1. Registers `AuthProvider` in `createApp()` and adds the mail definition to its `config` array.
2. Adds `auth: {}` to `createApp()`, which mounts the session and CSRF middleware.
3. Calls `registerAuthRoutes(router)` from `routes/web.ts`.

Then run:

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

Open `/login` on the URL `bun run dev` prints (`http://localhost:3333` by default) and sign in with `demo@example.com` / `secret`, or open `/register` to create a new account.

Flags change what is generated:

| Flag | What it changes | Notes |
|------|-----------------|-------|
| `--minimal` | Login only: no registration or password reset | |
| `--verify` | Adds email verification (see [Email verification](#email-verification)) | Not with `--minimal` |
| `--oauth github,google` | Adds provider sign-in buttons (see [OAuth login buttons](./oauth.md#oauth-login-buttons)) | Works with `--minimal` |
| `--oauth-only` | Provider sign-in only, no passwords (see [OAuth as the only sign-in method](./oauth.md#oauth-as-the-only-sign-in-method)) | Needs `--oauth`; implies `--minimal` |
| `--no-session` | Keeps sessions in process memory instead of a database table | Lost on restart and across instances |

### Without `--install`

If you prefer to wire things yourself, or already have part of the setup, omit the flag:

```bash
bunx guren make:auth
```

The command prints the steps it skipped. The main ones:

1. Register `AuthProvider` in your `createApp()` providers array.
2. Add `auth: {}` to the `createApp()` options to enable sessions and CSRF.
3. Import `registerAuthRoutes` from `routes/auth.ts` and call it from your `routes/web.ts` registrar.
4. Add the `config/mail.ts` definition to the `config` array, and set `APP_URL` in `.env` (emailed links are built from it).

`--install` is idempotent: it does not duplicate configuration that is already there.

An app that already sets up mail, through `guren add mail` or a provider of its own, keeps that setup: `make:auth` writes no `config/mail.ts`, and the reset mail goes through the existing one. `--no-session` skips the session table and config and leaves sessions in process memory.

## Generated Flows

### Throttling

`POST /login`, `POST /register` and `POST /forgot-password` go through the throttles in the generated `app/Http/Middleware/AuthThrottle.ts`. Each counts requests per client IP and submitted email address: five logins or registrations a minute, three reset requests every 15 minutes. Past the limit, an Inertia form gets the message as a validation error under `errors.message`, and any other client gets a `429` with a `Retry-After` header. The message comes from `auth.throttle` (logins) or `auth.too_many_requests` in `lang/en/auth.json`, which the command writes unless the app already has one.

The file is yours to edit: change a limit, or pass `store: new RedisRateLimitStore(redis)` from `@guren/core/redis` so every instance shares one count, since the default store lives in process memory. Behind a proxy or CDN every client arrives from the proxy's address, so read the header your proxy sets in `clientIp()`. See the [rate limiting guide](./rate-limiting.md) for the options.

### Password reset

"Forgot your password?" on the login page leads through `ForgotPasswordController` and `ResetPasswordController`, built on the framework's `createPasswordResetToken` / `completePasswordReset` (see [Password Reset](./password-reset.md)).

- The token is kept by the generated `app/Auth/PasswordResetStore.ts`, an in-memory store. Swap it for a Redis-backed store in production or any multi-instance deployment.
- The link is mailed through the generated `config/mail.ts`, which defaults to the `log` driver: links print to the console, so the flow works with no setup in development. Set `MAIL_MAILER=smtp` and the `SMTP_*` variables to send real email.

### Email verification

Pass `--verify` to also scaffold an email verification flow:

```bash
bunx guren make:auth --install --verify
```

This adds an `emailVerifiedAt` column to the `users` table, a `VerifyEmailController` (shows a "check your email" notice, resends the verification link, and confirms the token), and a `VerifyEmail` page.

Registering then sends a verification email and redirects to `/verify-email` instead of `/dashboard`. The generated `/dashboard` route is guarded with `requireVerifiedEmail`, so unverified users are sent back to `/verify-email` until they confirm. Verification links use the same in-memory store and `log`-driver mail as password reset, so this works with no setup in development.

## OAuth / Social login

Provider sign-in (GitHub, Google, Discord) is scaffolded by `make:auth --oauth`, which adds buttons to the generated pages, or by `guren add oauth`, which sets up the flow for a controller you write. The [OAuth guide](./oauth.md#scaffolding-oauth) describes both commands, the files they write and the flow behind them.

## Controllers & Routes

Controllers read the signed-in user through `this.auth`:

```ts
import { pages } from '@/.guren/pages.gen'
import type { UserRecord } from '@/app/Models/User'

export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()       // returns user or null
    return this.inertia(pages.dashboard.Index, { user })
  }

  async store() {
    const user = await this.auth.userOrFail<UserRecord>()  // throws 401 if not authenticated
    // user is guaranteed non-null here
    await Post.create(data, { set: { authorId: user.id } })
    return this.redirect('/posts')
  }
}
```

Use `this.validateBody()` / `this.validateQuery()` / `this.validateParams()` with Zod schemas for typed validation. Reserve `FormRequest` for compatibility code.

Surfacing the logged-in user on every Inertia page is already wired for you. The `app/Providers/AuthProvider.ts` that `bunx guren add auth` (equivalently `bunx guren make:auth --install`) generates registers it in `boot()`, so `auth.user` is readable from every page's props right after scaffolding. It is what the generated layout reads to toggle between **Sign in** and **Log out**.

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

Augment `InertiaSharedProps` (see the [Controllers guide](./controllers.md)) to type this `auth` payload for React pages.

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

`auth.user()` (and the cached user available right after `login()` or `attempt()`) never exposes credential material. `ModelUserProvider` strips the password column, the remember-token column, and any fields the model marks as `hidden` before the record leaves the auth layer:

```ts
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  fillable: ['name', 'email', 'password'],
  hidden: ['passwordHash', 'rememberToken'],
}) {}
```

The `make:auth` scaffolder generates the user model with this `hidden` configuration out of the box. See [Hiding Fields](./models.md#hiding-fields) for the option and the still-supported `static hidden = [...]` form.

Credential validation still runs on the raw database record internally, so login and remember-me tokens are unaffected: sanitization only changes what `auth.user()` exposes to application code.

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

The runtime strips exactly the columns your provider is configured with plus the model's `hidden` fields. A static type cannot see that configuration, so `Sanitized<T>` reflects the conventional names and relies on you to pass anything else. `guren audit` warns about sensitive columns missing from `hidden`, which keeps the runtime side honest.

## How Authentication Fits Together

The generated setup is built from these parts, which the rest of the page configures:

- **AuthManager** – central registry for guards and user providers. Resolved from the service container via `this.container.make<AuthManager>('auth')`.
- **Guards** – runtime objects responsible for authenticating a request. The default `SessionGuard` persists the logged-in user's identifier inside the session and supports optional "remember me" tokens.
- **User Providers** – data access adapters used by guards to load and validate users. `ModelUserProvider` integrates with Guren's `Model` abstraction so you can back authentication with Drizzle ORM tables.
- **Auth Context** – per-request facade that surfaces guard helpers (`auth.check()`, `auth.user()`, `auth.login()`, etc.). The context is attached automatically by `AuthServiceProvider`; it is available in controllers via the `this.auth` helper and in middleware through `attachAuthContext`.
- **OAuthManager** – social login helper that manages provider configs, CSRF-safe OAuth state, code exchange, and user profile fetch.

## Sessions

Guards keep the signed-in user in the session. When `createApp()` receives an `auth` option, the session middleware and CSRF protection are attached for you, and `guren add auth` makes the session database-backed from the start. Cookie options, the available stores and how to pick one per environment are described in [Sessions](./sessions.md).

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
- Uses the hasher `createApp({ auth: { hasher } })` selected, scrypt by default (see [Password hasher](#password-hasher))

### Password hasher

Every password the app writes goes through one hasher, whether `AuthenticatableModel` hashes it on `create()` or the session guard rehashes it at login. It is selected once, in `createApp()`:

```ts
const app = createApp({
  auth: {
    hasher: 'scrypt', // the default
  },
})
```

- `'scrypt'` (the default) writes `$scrypt$` hashes through `node:crypto`, which every runtime reads back: Bun, Node, Lambda, Workers.
- `'argon2'` writes Argon2id through `Bun.password`. Pick it only for a deployment that stays on Bun; `createApp()` throws on a runtime without `Bun.password`.
- A `PasswordHasher` object replaces the built-in one entirely.

Verification is routed by the stored hash's format rather than by this setting, so a column holding both formats keeps working. A row in the other format, such as an Argon2id hash written under Bun before scrypt became the default, is rehashed on that user's next successful login. A row that never logs in again keeps its format.

On a runtime without `Bun.password` an Argon2id row cannot be verified at all. Migrate such a column while the app still runs on Bun, by having those users log in or by resetting their passwords, before moving to Node, Lambda or Workers.

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

Optional means optional: a caller may still pass `passwordHash` and it will type-check. At runtime, `AuthenticatableModel` denies the hash column (and the remember token) from mass assignment entirely: a request body carrying it throws a `MassAssignmentException`, whatever the model's `fillable` says. Use `forceCreate()` / `forceUpdate()` for trusted server-side values such as `passwordHash: 'oauth:...'`.

Leave `requireOnCreate` off when accounts can also arrive without a password — an OAuth-only sign-up, for instance — so `password` stays optional.

A credential column holding something that is not a password hash means the account cannot authenticate with one. `ModelUserProvider` treats a null column, an empty string, and a sentinel such as `'oauth:...'` alike: the login is denied, and the same hashing work is spent as on a real verification so the response is not distinguishable by time. A value that *claims* a hash format and fails to satisfy it still throws. That is a corrupt or truncated column, and denying it in silence would leave nothing to notice it by. A nullable column is the clearer choice for a passwordless account; `make:auth --oauth` scaffolds one.

`createApp()` registers a default `web` guard that uses the `users` provider. If you need additional guards (e.g. token-based APIs), call `auth.registerGuard('api', factory)` inside the provider and set it as default via `auth.setDefaultGuard('api')` when appropriate.

## Remember Tokens

`SessionGuard` manages remember tokens automatically when your user provider implements `setRememberToken` / `getRememberToken`. `ModelUserProvider` handles this when the `rememberTokenColumn` option is supplied.

## Custom One-Time Token Stores

Password reset and email verification store one-time tokens. The memory and Redis stores need nothing from you; this section is for writing your own store, or upgrading an older scaffold.

The helpers rely on two atomic store operations. `replace()` revokes the email's previous tokens and stores the new one in a single operation. `consume(tokenId, email)` compares the stored email and deletes the token atomically, returning `true` to exactly one caller. The memory and Redis stores implement both methods. Issuance normalizes email addresses to lowercase before replacement.

Custom `PasswordResetTokenStore` and `EmailVerificationTokenStore` implementations must add these methods before using the issuance and completion helpers. Password reset stores accept `replace(tokenId, email, expiresAt)`; email verification stores accept `replace(token)`. The methods are optional in the interfaces for source compatibility, but the helpers reject stores that lack the required operation. A process-local lock around separate reads and deletes does not protect a store shared by several workers; use a transaction or an atomic database command.

`completePasswordReset()` and `completeEmailVerification()` consume the token before calling application code. If the update fails, request a new token; the consumed token is not restored. `verifyPasswordResetToken()` and `verifyEmailToken()` only inspect validity and do not reserve or consume a token. Use the completion helpers for updates. Existing scaffolded password reset controllers should migrate their separate verify/update/delete sequence to `completePasswordReset()`. Upgrade `@guren/core` and `@guren/cli` together, and restart all instances that issue or complete tokens; older instances still run the non-atomic sequence.

## Example Application

The blog example includes the full authentication stack:

- `AuthProvider` for guard/provider setup, with `config/session.ts` and `config/oauth.ts` definitions
- Login, registration, password reset, and email verification controllers, plus `DashboardController`
- Inertia pages under `resources/js/pages/auth/` (`Login`, `Register`, `ForgotPassword`, `ResetPassword`, `VerifyEmail`) and `resources/js/pages/dashboard/Index.tsx`
- OAuth login buttons for GitHub and Google
- Database schema, migration, and seeder for `users`

Run the demo with:

```bash
bun run dev
```

Visit `http://localhost:3333/login` and sign in using the seeded credentials `demo@guren.dev` / `secret`, or visit `/register` to create a new account.
