# Authentication Walkthrough

Secure your app by scaffolding the built-in authentication stack.

1. **Generate scaffolding** — run `bunx guren make:auth --force` to create controllers, views, migrations, and the `AuthProvider`.
2. **Wire providers** — register `AuthProvider`, `createSessionMiddleware`, and `attachAuthContext` inside `src/app.ts` before booting the application:
   ```ts
   app.register(DatabaseProvider)
   app.register(AuthProvider)
   app.use('*', createSessionMiddleware())
   app.use('*', attachAuthContext())
   ```
3. **Run migrations & seeders** — execute `bun run db:migrate` followed by `bun run db:seed` to create the `users` table and demo user.
4. **Protect routes** — apply `requireAuthenticated` middleware to dashboards or post-management endpoints:
   ```ts
   Route.group('/dashboard', () => {
     Route.get('/', [DashboardController, 'index'])
   }, requireAuthenticated({ redirectTo: '/login' }))
   ```
5. **Test the flow** — visit `/register` to create a user or `/login` with seeded credentials. Use the `auth` helper inside controllers (`const user = await this.auth.user()`) to access the signed-in user.
