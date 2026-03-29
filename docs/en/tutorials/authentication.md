# Authentication Walkthrough

Secure your app by scaffolding the built-in authentication stack.

1. **Generate scaffolding** — run `bunx guren make:auth --install` to create controllers, views, migrations, the `AuthProvider`, and auto-wire session + routes. Use `--force` if you want to overwrite existing files.
2. **(Usually done for you)** `--install` auto-registers `AuthProvider`, attaches session middleware, and wires auth routes. If you want to tweak session behavior (e.g., force secure cookies), pass auth options to `createApp()`:
   ```ts
   import { createApp } from '@guren/core'

   const app = createApp({
     auth: {
       autoSession: true, // set false to skip auto session wiring
       sessionOptions: {
         cookieSecure: process.env.NODE_ENV === 'production',
       },
     },
   })
   ```
3. **Run migrations & seeders** — execute `bun run db:migrate` followed by `bun run db:seed` to create the `users` table and demo user.
4. **Protect routes** — register an `auth` middleware alias and wrap protected routes in a group:
   ```ts
   import { Router, requireAuthenticated } from '@guren/core'

   export function registerWebRoutes(router: Router): void {
     router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

     router.middleware('auth').group((auth) => {
       auth.get('/dashboard', [DashboardController, 'index'])
     })
   }
   ```
5. **Test the flow** — visit `/register` to create a user or `/login` with seeded credentials. Use the `auth` helper inside controllers (`const user = await this.auth.user()`) to access the signed-in user.
