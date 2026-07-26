# Troubleshoot a Broken Setup

This guide covers the most common issues you will encounter when developing with Guren and how to fix them quickly. When something goes wrong, start here before diving into individual package documentation.

## Quick Diagnostic

Run the built-in doctor command to identify problems automatically:

```bash
bunx guren doctor
```

The doctor checks route-controller-page consistency, missing dependencies, configuration issues, and more. It prints actionable suggestions next to each finding.

For a detailed report with recommended next steps:

```bash
bunx guren doctor --next
```

## Common Issues

### "Cannot find module @guren/core"

**Cause:** Dependencies are not installed or the lockfile is out of date.

**Fix:**

```bash
bun install
```

If you recently switched branches or pulled large changes, also rebuild:

```bash
bun run build
```

---

### Type errors after upgrading Guren

**Cause:** Stale build artifacts from the previous version conflict with the new types.

**Fix:**

```bash
bun run build:clean
```

This removes all `dist/` directories and rebuilds every package in the correct dependency order. Always use `build:clean` after upgrading or switching branches.

---

### Codegen not updating

**Cause:** The codegen cache may be stale, or new routes and pages have not been detected.

**Fix:**

```bash
bun run codegen --force
```

The `--force` flag bypasses the cache and regenerates all manifests from scratch. If the issue persists, check that your route file (`routes/web.ts`) exports a valid route registrar function.

---

### "Connection refused" when accessing the database

`bun run db:migrate` fails with `cannot connect to the database at localhost:54322 (ECONNREFUSED)`.

**Cause:** The Postgres container is not running, its port is not published to the host, or `DATABASE_URL` points to the wrong host or port.

**Fix:**

1. Start the database container:

   ```bash
   bun run db:up
   ```

   Projects scaffolded before `db:up` existed do not have that script — run `docker compose up -d` instead, or add it to `package.json`.

2. Verify the connection string in `.env`:

   ```dotenv
   DATABASE_URL=postgres://guren:guren@localhost:54322/guren
   ```

   The default port is `54322` (not the standard `5432`) to avoid conflicts with system Postgres.

3. Confirm the container **publishes its port to the host**:

   ```bash
   docker compose port postgres 5432
   ```

   You should see `0.0.0.0:54322`. If `docker compose ps` reports `Up` but this command prints nothing, publishing failed (this happens after a Docker Desktop restart). Recreate the container — the named volume survives, so no data is lost:

   ```bash
   docker compose down && docker compose up -d
   ```

---

### "CSRF token mismatch"

**Cause:** The session middleware is not registered, or the frontend is not sending the CSRF token with requests.

**Fix:**

1. Confirm session middleware is registered in your application bootstrap. The `add auth` generator does this automatically, but if you set up manually, ensure `createSessionMiddleware` is in your providers.

2. On the frontend, verify that forms include the CSRF token. Inertia pages handle this automatically. For custom fetch requests, include the token from the cookie:

   ```typescript
   fetch('/api/endpoint', {
     method: 'POST',
     headers: {
       'X-CSRF-Token': getCsrfToken(),
       'Content-Type': 'application/json',
     },
     body: JSON.stringify(data),
   })
   ```

3. See the [CSRF Guide](./csrf.md) for full details.

---

### "Validation failed" with no useful error message

**Cause:** The validation schema does not match the shape of the incoming request body.

**Fix:**

1. Check that your Zod schema matches the field names your frontend sends:

   ```typescript
   // If the frontend sends { userName: "..." }
   // then the schema must use userName, not username
   const Schema = z.object({
     userName: z.string().min(1),
   })
   ```

2. In development, validation errors return a 422 response with a JSON body listing each field and its error. Inspect the response body in your browser's network tab.

3. See [Validation](./validation.md) for more patterns.

---

### "Page not found" for a route that exists

**Cause:** The codegen manifests are out of date, or the controller method name does not match the route definition.

**Fix:**

1. Regenerate manifests:

   ```bash
   bun run codegen --force
   ```

2. Run the consistency check:

   ```bash
   bunx guren check
   ```

   This reports any routes that reference missing controllers or methods.

3. Verify that the controller method name in your route matches the actual method in your controller class:

   ```typescript
   // Route
   router.get('/posts', [PostController, 'index'])

   // Controller — method must be named "index"
   export class PostController extends Controller {
     async index() { /* ... */ }
   }
   ```

---

### Dev server starts but pages are blank

**Cause:** The Vite dev server is not running, or SSR rendering is failing silently.

**Fix:**

1. Make sure `bun run dev` starts both the Bun backend and the Vite dev server. Check your `package.json` scripts.

2. Open the browser console for JavaScript errors.

3. If using SSR, check the terminal output for server-side rendering errors — they appear in the Bun process logs, not the browser.

---

### Migration fails with "relation already exists"

**Cause:** A previous migration partially applied, or you manually created the table.

**Fix:**

1. Check migration status:

   ```bash
   bunx guren db:migrate:status
   ```

2. If you need to start fresh in development:

   ```bash
   bunx guren db:reset
   ```

   This drops all tables, re-runs all migrations, and optionally re-seeds.

> [!WARNING]
> `db:reset` destroys all data. Only use it in development.

## Reading Doctor Output

The `doctor` command groups findings by severity:

- **Error** — must be fixed before the app can run correctly (e.g., a route references a controller that does not exist)
- **Warning** — the app runs but may behave unexpectedly (e.g., a page component exists but is not referenced by any route)
- **Info** — suggestions for improvement (e.g., unused imports)

Each finding includes a description and a suggested fix. Apply the suggestions, then re-run `bunx guren doctor` to confirm the issues are resolved.

## When Nothing Else Works

If none of the above solves your problem:

1. Delete `node_modules` and reinstall:

   ```bash
   rm -rf node_modules bun.lock
   bun install
   bun run build:clean
   ```

2. Check the [CLI Reference](./cli.md) for additional diagnostic commands.

3. Run `bunx guren context` to generate a project map you can share when asking for help.
