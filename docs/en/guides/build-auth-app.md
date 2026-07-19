# Build an Auth App

This guide walks you through building an application with user registration, login, and protected routes. You will go from an empty directory to a working auth flow in under ten minutes.

> [!NOTE]
> This is a task-oriented guide. For full details on sessions, guards, and user providers, see the [Authentication Guide](./authentication.md).

## Prerequisites

- **Bun 1.1 or later**
- **Docker Desktop (Compose v2)** for Postgres

## 1. Scaffold the Project

```bash
bunx create-guren-app my-auth-app --mode ssr
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
- Auth routes wired into `routes/web.ts`

## 3. Start the Database

```bash
docker compose up -d
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

The generated controller validates credentials with Zod and delegates to the auth guard:

```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'

const LoginSchema = z.object({
  email: z.email(),
  password: z.string().min(1),
  remember: z.boolean().optional(),
})

export class LoginController extends Controller {
  async show() {
    return this.inertia(pages.auth.Login)
  }

  async login() {
    const { email, password, remember } = await this.validateBody(LoginSchema)
    const ok = await this.auth.attempt({ email, password }, remember)

    if (!ok) {
      return this.back().withErrors({ email: 'Invalid credentials.' })
    }

    return this.redirect('/dashboard')
  }

  async logout() {
    await this.auth.logout()
    return this.redirect('/login')
  }
}
```

### Auth Middleware

Protect any route group with the `auth` alias that the generator registers:

```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  // Public routes
  router.get('/login', [LoginController, 'show']).name('login.show')
  router.post('/login', [LoginController, 'login']).name('login')
  router.post('/logout', [LoginController, 'logout']).name('logout')

  // Protected routes
  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index']).name('dashboard')
  })
}
```

### Protected Pages

Inside a protected controller, access the current user via `this.auth`:

```typescript
export class DashboardController extends Controller {
  async index() {
    const user = await this.auth.userOrFail()
    return this.inertia(pages.dashboard.Index, { user })
  }
}
```

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
