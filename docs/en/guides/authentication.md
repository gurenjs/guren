# Authentication Guide

Guren ships with a Laravel-inspired authentication stack that sits on top of the session middleware and the ORM layer. The goal is to match the expressiveness of Laravel's guards and user providers while staying idiomatic to TypeScript and Bun.

## Core Concepts

- **AuthManager** – central registry for guards and user providers. Available from the application instance (`app.auth`) or inside service providers via `context.auth`.
- **Guards** – runtime objects responsible for authenticating a request. The default `SessionGuard` persists the logged-in user's identifier inside the session and supports optional "remember me" tokens.
- **User Providers** – data access adapters used by guards to load and validate users. `ModelUserProvider` integrates with Guren's `Model` abstraction so you can back authentication with Drizzle ORM tables.
- **Auth Context** – per-request façade that surfaces guard helpers (`auth.check()`, `auth.user()`, `auth.login()`, etc.). The context is attached automatically by `AuthServiceProvider`; it is available in controllers via the new `this.auth` helper and in middleware through `attachAuthContext`.

## Quickstart via CLI

For new applications, run the bundled scaffolder with automatic installation (the session middleware will be auto-attached by default):

```bash
bunx guren make:auth --install
```

This command generates controllers, Inertia pages, a layout, `AuthProvider`, user model, SQL migration, and a demo seeder. The `--install` flag automatically:

1. Registers `AuthProvider` in your `Application` providers array
2. Adds `createSessionMiddleware` with development-friendly defaults (uses `cookieSecure: true` in production)
3. Imports auth routes into `routes/web.ts`
4. Updates `db/schema.ts` to include password and remember-token columns

After scaffolding, simply run:

```bash
bun run db:migrate
bun run db:seed
bun run dev
```

Visit `http://localhost:3000/login` and sign in with `demo@example.com` / `secret`.

### Manual Setup

If you prefer to configure manually or already have partial setup, omit the `--install` flag:

```bash
bunx guren make:auth
```

Then manually:
1. Register `AuthProvider` in `src/app.ts`
2. Add `createSessionMiddleware` to your middleware stack (auto-added by `AuthServiceProvider` unless you opt out)
3. Import `./routes/auth` from `routes/web.ts`

The `--install` flag is safe and idempotent – it won't duplicate existing configuration.

## Enabling Sessions

Guards need access to the session. By default, `AuthServiceProvider` will attach `createSessionMiddleware` for you. To customize or disable it, pass auth options to `Application`:

```ts
import { Application } from '@guren/server'

const app = new Application({
  auth: {
    autoSession: true, // set false to opt out
    sessionOptions: {
      cookieSecure: process.env.NODE_ENV === 'production',
    },
  },
})
```

If you need manual control, register the middleware explicitly early in your bootstrap:

```ts
import { Application, createSessionMiddleware } from '@guren/core'

const app = new Application()
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
import type { ApplicationContext, Provider } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.useModel(User, {
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
import type { ApplicationContext, Provider } from '@guren/core'
import { ModelUserProvider, SessionGuard } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    // Register the provider
    context.auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    }))

    // Register a custom guard
    context.auth.registerGuard('web', ({ session, manager }) => {
      const provider = manager.getProvider('users')
      return new SessionGuard({ provider, session })
    })

    context.auth.setDefaultGuard('web')
  }
}
```

Pair this with the `AuthenticatableModel` base class (see below) to get automatic password hashing and validation helpers.

### Authenticatable Models

Models that extend `AuthenticatableModel` receive first-class password handling. Providing a plain `password` property when calling `create` or `update` automatically hashes and stores it in the `passwordHash` column (configurable via static properties). The framework never persists the plain text password, and authentication continues to rely on the same hashing algorithm as the providers.

```ts
import { AuthenticatableModel } from '@guren/core'
import { users } from '@/db/schema.js'

export type UserRecord = typeof users.$inferSelect

export class User extends AuthenticatableModel<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
  // Optional:
  // static override passwordField = 'plainPassword'
  // static override passwordHashField = 'password_digest'
}
```

The default `AuthServiceProvider` automatically registers a `web` guard that uses the `users` provider. If you need additional guards (e.g. token-based APIs), call `context.auth.registerGuard('api', factory)` inside the provider and set it as default via `context.auth.setDefaultGuard('api')` when appropriate.

## Controllers & Routes

Controllers now expose an `auth` helper:

```ts
export default class DashboardController extends Controller {
  async index() {
    const user = await this.auth.user()
    return this.inertia('dashboard/Index', { user }, { url: this.request.path })
  }
}
```

Use `parseRequestPayload()` and `formatValidationErrors()` from `guren` to keep controller-level request handling consistent when integrating Zod or other schema validators.

To surface the logged-in user on every Inertia page without repeating controller code, register shared props during app boot:

```ts
// config/inertia.ts
import { setInertiaSharedProps, AUTH_CONTEXT_KEY, type AuthContext } from '@guren/server'

setInertiaSharedProps(async (ctx) => {
  const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
  return { auth: { user: await auth?.user() } }
})
```

Augment `InertiaSharedProps` (see the Controllers guide) to type this `auth` payload for React pages.

Route middleware makes protecting endpoints straightforward:

```ts
import { Route, requireAuthenticated, requireGuest } from '@guren/core'
import LoginController from '@/app/Http/Controllers/Auth/LoginController'

Route.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' }))
Route.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' }))
```

## Session Guard Helpers

- `auth.check()` – resolves to `true` when a user is authenticated.
- `auth.user()` – returns the current user record (or `null`).
- `auth.login(user, remember?)` – logs in the given user and optionally issues a remember token.
- `auth.attempt(credentials, remember?)` – validates credentials using the active guard and logs in on success.
- `auth.logout()` – clears the session and remember token.

## Remember Tokens

`SessionGuard` manages remember tokens automatically when your user provider implements `setRememberToken` / `getRememberToken`. `ModelUserProvider` handles this when the `rememberTokenColumn` option is supplied.

## Example Application

The blog example now includes:

- `AuthProvider` for guard/provider setup
- `LoginController` & `DashboardController`
- Inertia pages at `resources/js/pages/auth/Login.tsx` and `resources/js/pages/dashboard/Index.tsx`
- Database schema, migration, and seeder for `users`

Run the demo with:

```bash
bun run dev
```

Visit `http://localhost:3000/login` and sign in using the seeded credentials `demo@example.com` / `secret`.
