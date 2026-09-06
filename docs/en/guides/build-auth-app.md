# Build an Auth App

This guide walks you through building an application with user registration, login, and protected routes. You will go from an empty directory to a working auth flow in under ten minutes.

> [!NOTE]
> This is a task-oriented guide. For full details on sessions, guards, and user providers, see the [Authentication Guide](./authentication.md).

## Prerequisites

- **Bun 1.1 or later**
- **Docker Desktop (Compose v2)** for Postgres

## 1. Scaffold the Project

```bash
bunx create-guren-app my-auth-app --mode ssr --db postgres
cd my-auth-app
bun install
```

## 2. Add Authentication

The `add auth` generator creates controllers, Inertia pages, a user model, migration, and session middleware in one step:

```bash
bunx guren add auth
```

This scaffolds:

- `app/Http/Controllers/Auth/LoginController.ts` and `RegisterController.ts`
- `app/Models/User.ts` with password and remember-token columns
- Inertia pages under `resources/js/pages/Auth/`
- `AuthProvider` registered in your application providers
- Session middleware with development-friendly defaults
- `routes/auth.ts`, wired into your `routes/web.ts` registrar

## 3. Start the Database

```bash
bun run db:up
```

Then run the generated migration to create the `users` table:

```bash
bunx guren db:migrate
```

## 4. Generate Type Manifests

```bash
bun run codegen
```

This generates typed route and page manifests so your controllers and frontend components stay in sync.

## 5. Start the Dev Server

```bash
bun run dev
```

Visit `http://localhost:3333/register` to create an account, then `http://localhost:3333/login` to sign in.

## 6. Understand the Key Pieces

### LoginController

The generated controller validates credentials with `LoginSchema` (generated alongside it in `app/Http/Validators/LoginValidator.ts`) and delegates to the auth guard:

```typescript
import { Controller, ValidationException } from '@guren/core'
import { LoginSchema } from '../../Validators/LoginValidator.js'
import { pages } from '@/.guren/pages.gen'

export default class LoginController extends Controller {
  async show(): Promise<Response> {
    const email = this.request.query('email') ?? ''
    return this.inertia(pages.auth.Login, { email }, { title: 'Login' })
  }

  async store(): Promise<Response> {
    const { email, password, remember } = await this.validateBody(LoginSchema)

    this.auth.session()?.regenerate()

    const authenticated = await this.auth.attempt({ email, password }, remember)

    if (!authenticated) {
      throw ValidationException.withMessages({ message: 'Invalid credentials.' })
    }

    return this.redirect('/dashboard')
  }

  async destroy(): Promise<Response> {
    await this.auth.logout()
    this.auth.session()?.invalidate()
    return this.redirect('/')
  }
}
```

A failed attempt throws `ValidationException.withMessages()`, which the framework renders as a 422 carrying an `errors` payload; the generated login page shows `errors.message`. Use a field name as the key (`{ email: '...' }`) to attach the message to a single input instead.

### Auth Middleware

The generator writes `routes/auth.ts` and calls it from your route registrar. Each route carries its own guard:

```typescript
import { Router, requireAuthenticated, requireGuest } from '@guren/core'

export function registerAuthRoutes(router: Router): void {
  router.get('/login', [LoginController, 'show'], requireGuest({ redirectTo: '/dashboard' })).name('login')
  router.post('/login', [LoginController, 'store'], requireGuest({ redirectTo: '/dashboard' })).name('login.store')
  router.post('/logout', [LoginController, 'destroy'], requireAuthenticated({ redirectTo: '/login' })).name('logout')

  router.get('/dashboard', [DashboardController, 'index'], requireAuthenticated({ redirectTo: '/login' })).name('dashboard')
}
```

To guard a whole group under a short name instead, register the alias yourself first. `aliasMiddleware()` returns a router carrying the alias in its type, so capture the return value:

```typescript
export function registerWebRoutes(baseRouter: Router): void {
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index']).name('dashboard')
  })
}
```

### Protected Pages

Inside a protected controller, access the current user via `this.auth`:

```typescript
import { Controller } from '@guren/core'
import type { UserRecord } from '../../Models/User.js'
import { pages } from '@/.guren/pages.gen'

export default class DashboardController extends Controller {
  async index(): Promise<Response> {
    const currentUser = await this.auth.user<UserRecord | null>()
    const user = currentUser
      ? { id: currentUser.id, name: currentUser.name, email: currentUser.email }
      : null
    return this.inertia(pages.dashboard.Index, { user }, { title: 'Dashboard' })
  }
}
```

`this.auth.user<T>()` returns `null` for a guest. Use `this.auth.userOrFail<T>()` when you want a 401 instead of a null branch.

## 7. Verify the Flow

1. Navigate to `/register` and create a user.
2. Navigate to `/login` and sign in with your new credentials.
3. Confirm you land on `/dashboard` and can see your user name.
4. Visit `/dashboard` in an incognito window — you should be redirected to `/login`.
5. Click logout — you should return to the login page.

## Next Steps

- [Email Verification](./email-verification.md) — require users to verify their address before accessing protected routes
- [Password Reset](./password-reset.md) — let users recover their accounts
- [Authorization](./authorization.md) — add role-based access control
- [API Tokens](./api-tokens.md) — issue tokens for programmatic access
