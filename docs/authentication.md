# Authentication Guide

Guren ships with a Laravel-inspired authentication stack that sits on top of the session middleware and the ORM layer. The goal is to match the expressiveness of Laravel's guards and user providers while staying idiomatic to TypeScript and Bun.

## Core Concepts

- **AuthManager** – central registry for guards and user providers. Available from the application instance (`app.auth`) or inside service providers via `context.auth`.
- **Guards** – runtime objects responsible for authenticating a request. The default `SessionGuard` persists the logged-in user's identifier inside the session and supports optional "remember me" tokens.
- **User Providers** – data access adapters used by guards to load and validate users. `ModelUserProvider` integrates with Guren's `Model` abstraction so you can back authentication with Drizzle ORM tables.
- **Auth Context** – per-request façade that surfaces guard helpers (`auth.check()`, `auth.user()`, `auth.login()`, etc.). The context is attached automatically by `AuthServiceProvider`; it is available in controllers via the new `this.auth` helper and in middleware through `attachAuthContext`.

## Quickstart via CLI

For new applications, run the bundled scaffolder:

```bash
bunx guren make:auth
```

This command generates controllers, Inertia pages, a layout, `AuthProvider`, user model, SQL migration, and a demo seeder. After running it:

1. Register `AuthProvider`, `createSessionMiddleware`, and `attachAuthContext` inside `src/app.ts`.
2. Import `./routes/auth` from `src/main.ts` (or your existing route bootstraps).
3. Execute `bun run db:migrate` followed by `bun run db:seed`.

The scaffolder updates `db/schema.ts` to include password and remember-token columns when needed.

## Enabling Sessions

Guards need access to the session. Register `createSessionMiddleware` early in your application bootstrap:

```ts
import { Application, createSessionMiddleware } from '@guren/core'

const app = new Application()
app.use('*', createSessionMiddleware())
```

## Configuring Providers & Guards

Create a service provider that registers a user provider and (optionally) custom guards. The example below wires a `ModelUserProvider` for the `User` model and keeps the default `web` session guard.

```ts
import type { ApplicationContext, Provider } from '@guren/core'
import { ModelUserProvider } from '@guren/core'
import { User } from '@/app/Models/User'

export default class AuthProvider implements Provider {
  register(context: ApplicationContext): void {
    context.auth.registerProvider('users', () => new ModelUserProvider(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    }))
  }
}
```

Pair this with the `AuthenticatableModel` base class (see below) to get automatic password hashing and validation helpers. Under the hood, Guren uses Bun's Argon2id implementation by default, so you get modern password hashing without additional dependencies.

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
  async index(ctx: Context) {
    const user = await this.auth.user()
    return this.inertia('dashboard/Index', { user }, { url: ctx.req.path })
  }
}
```

Use `parseRequestPayload()` and `formatValidationErrors()` from `guren` to keep controller-level request handling consistent when integrating Zod or other schema validators.

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
