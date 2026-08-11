# CLI Reference

Guren ships with two companion CLIs:

- `bunx guren` for generating controllers, models, views, and running framework utilities inside an existing project.
- `bunx create-guren-app` for scaffolding a brand-new application.

## Basic Usage

```bash
# No global install required—run directly from the project root.
bunx guren --help
```

Commands follow a subcommand pattern such as `bunx guren make:controller UserController`.

## High-Level Scaffolds

Use `bunx guren add ...` when you want the standard vNext path instead of low-level file generators:

```bash
bunx guren add auth
bunx guren add admin
bunx guren add resource posts --fields "title:string,body:text,published:boolean"
bunx guren add queue
bunx guren add mail
bunx guren add events
bunx guren add cache
bunx guren add notifications
bunx guren add storage
bunx guren add broadcasting
bunx guren add schedule
```

> **Golden path:** Start with `bunx guren add auth` and `bunx guren add resource`, then add more features as your app grows.

```bash
bunx guren plugin @acme/guren-plugin-audit
```

`plugin` (also available as `add plugin`) installs the package with `bun add` when missing (pass `--no-install` to skip), verifies the plugin's declared Guren compatibility (`--ignore-compatibility` to override), wires the provider into `src/app.ts`, and applies any config stubs and env keys the plugin declares in its `gurenPlugin` manifest. `--force` overwrites already-published files.


These commands patch `src/app.ts`, create the matching provider/runtime files, and keep the generated app aligned with the reference starter.

`bunx guren add admin` scaffolds:

- `app/Http/Controllers/Admin/AdminDashboardController.ts`
- `resources/js/pages/admin/Dashboard.tsx`
- `routes/admin.ts` (and auto-wires `routes/web.ts` when present)

The dashboard is **authenticated by default**: `routes/admin.ts` attaches
`requireAuthenticated({ redirectTo: '/login' })` to `/admin`, and the controller
calls `this.auth.userOrFail()`. Unlike `make:feature --public`, which only
affects mutating actions, `--public` here opens the whole dashboard:

```bash
bunx guren add admin --public
```

You can run `add admin` before `add auth`. The guard still holds — an app with no
authentication configured has no signed-in user, so every request is redirected
to `/login`, a route that only exists once you run `bunx guren add auth`. Add
authentication first if you want a usable dashboard, or pass `--public` and add
your own check later.

`add admin` needs a fullstack app. The dashboard is an Inertia page, so on an app
scaffolded from the `api` blueprint — no `@guren/inertia-client` dependency and no
`routes/web.ts` — the command refuses and writes nothing rather than scaffolding a
controller that does not typecheck and a routes file nothing mounts. Add an admin
endpoint to `routes/api.ts` by hand instead.

`add auth` needs a fullstack app for the same reason, and refuses on the same two
signals — as does `make:auth`, which reaches the same scaffold. Auth also patches
`db/schema.ts` and generates a migration, so the refusal comes before all of that,
not just before the first file: the app is left exactly as it was. For a
token-based API, guard `routes/api.ts` with `createBearerTokenMiddleware` from
`@guren/core` and issue tokens with `createApiToken` — see the
[API tokens guide](./api-tokens.md).

`add resource` refuses on those same two signals, and for the same reason: it
scaffolds React page components and a controller that returns Inertia responses.
Its refusal likewise comes before the table it would otherwise append to your
`db/schema.ts`. So does `make:feature`, which reaches the same scaffold
directly. Add a JSON controller wired into `routes/api.ts` by hand instead.

`add resource` also needs the two files it patches to be there, whatever shape the
rest of your app is: it appends its table to `db/schema.ts` and registers the CRUD
routes in `routes/web.ts`, and unless those routes are registered already,
`routes/web.ts` must export a route registrar it can patch. When one of those is
missing, the command names it and writes nothing — rather than leaving a scaffold
behind and a table appended for routes that were never registered. Use
`bunx guren make:feature` instead if you want the files without the two patches;
it prints the route block to paste and tells you which schema file to add the
table to.

## Core Commands

| Command | Description | Example |
|---------|-------------|---------|
| `key:generate` | Generate a new `APP_KEY` value. Use `--write` to save it to `.env` | `bunx guren key:generate --write` |
| `deploy` | Generate deployment recipe files for Docker/Fly.io/Railway/Vercel | `bunx guren deploy --target all --app my-app --port 3333` |
| `make:controller <Name>` | Generates a controller in `app/Http/Controllers` | `bunx guren make:controller PostController` |
| `make:model <Name>` | Generates a minimal model class and type definition in `app/Models` (imports `camelCase(Name)s` from `db/schema`) | `bunx guren make:model Post` |
| `make:view <path>` | Generates a React component in `resources/js/pages` | `bunx guren make:view posts/Index` |
| `make:auth` | Scaffolds login/logout, registration, and password reset controllers, providers, views, migration, seeder, and routes (`--minimal` skips registration and password reset, `--verify` also scaffolds email verification, `--oauth <providers>` also scaffolds OAuth login buttons for the given comma-separated providers, `--oauth-only` drops password login entirely and makes those providers the only way in) | `bunx guren make:auth --oauth github,google` |
| `make:middleware <Name>` | Generates a middleware file in `app/Http/Middleware` | `bunx guren make:middleware Auth` |
| `make:policy <Name>` | Generates an authorization policy in `app/Policies` with owner-based defaults | `bunx guren make:policy Post` |
| `make:validator <Name>` | Generates Zod validation schemas (route params, list query, payload) in `app/Http/Validators`; `--fields` uses the same syntax as `make:feature` | `bunx guren make:validator Post --fields "title:string,body:text"` |
| `make:adr "<Title>"` | Records an architecture decision as a numbered file under `docs/adr/` with linkable frontmatter; `--entity <Model>` prefills the `entities:`/`related:` links | `bunx guren make:adr "Billing cycle is end-of-month" --entity Invoice` |
| `make:seeder <Name>` | Generates a database seeder file | `bunx guren make:seeder UserSeeder` |
| `make:job <Name>` | Generates a queueable job class | `bunx guren make:job SendEmail` |
| `make:event <Name>` | Generates an event class | `bunx guren make:event UserRegistered` |
| `make:listener <Name>` | Generates an event listener class | `bunx guren make:listener SendWelcomeEmail` |
| `make:notification <Name>` | Generates a notification class | `bunx guren make:notification InvoicePaid` |
| `make:mail <Name>` | Generates a mailable class | `bunx guren make:mail WelcomeEmail` |
| `make:command <Name>` | Generates a console command in `app/Console/Commands`; `--command <name>` sets the invocation name. Register it in `src/console.ts` — see the [console commands guide](./console.md) | `bunx guren make:command SendDigest --command reports:digest` |

> **Note:** `make:*` commands avoid overwriting existing files. Use `--force` if you need to replace them.

## Inspection & Audit Commands

Validate your app before shipping — these commands are also designed for AI coding agents (add `--json` for machine-readable output):

| Command | Description | Example |
|---------|-------------|---------|
| `check` | Validate integrity across routes, controllers, pages, and models — including whether every file in `routes/` is actually reached from your entry registrar (and every file in a module's `routes/` from that module's own registrar) — plus doc links, spec-view freshness, and architecture boundaries | `bunx guren check --json` |
| `audit` | Security audit: missing input validation or authentication on mutating routes, raw SQL with interpolation, hardcoded credentials, disabled security defaults, mass-assignment configuration, sensitive columns not listed in `static hidden`, emailed links built from the request host | `bunx guren audit --json` |
| `doctor` | Project health report (env, config, generated files) with actionable next steps | `bunx guren doctor --next` |
| `context [Entity]` | Project context map — or, with an entity name, everything about one model: table, relationships, routes with schemas, pages with Props, resource, policy, linked docs (`--module` disambiguates, `"app"` = project root) | `bunx guren context User --json` |
| `docs:graph` | The OKF docs relation graph: documents, entities, and code paths as nodes, verified relations as edges. `--entity <Model>` or `--path <file>` narrows to a neighborhood — ask "what governs this?" before renaming | `bunx guren docs:graph --path app/Http/Controllers/PostController.ts` |
| `spec:generate` | Regenerates the derived spec views in `docs/spec/` (ER diagram, domain model, screens, module map) — see [Spec-Anchored Development](./spec-anchored.md) | `bunx guren spec:generate` |

`audit` exits with a non-zero status when it finds failures. Plain
`check` is informational — its suite flags are the CI gates, each
exiting non-zero on failures in that suite:

```bash
bunx guren audit
bunx guren check --arch    # architecture boundaries (guren.arch.ts + module rules)
bunx guren check --docs    # doc links: OKF frontmatter (type/entities/related) + body links + @docs tags
bunx guren check --spec    # docs/spec/ views match a fresh regeneration
```

Combining suite flags runs their union. `--changed` restricts any of
them to files changed against the merge base with `main` — the fast
path the agent-harness edit hook uses.

Routes wrapped in named middleware (for example `router.middleware('auth').group(...)`) are recognized as protected. Guest flows such as `/login` and `/register` are excluded from authentication checks.

Suppress a false positive by placing `// guren-audit-ignore` on the flagged line or the line above it:

```ts
// guren-audit-ignore -- documented example value
const apiKey = 'example-not-a-real-key'
```

Route- and model-level findings (`authz:*`, `validation:*`, `mass-assignment:*`, `hidden-columns:*`) have no single line to attach a comment to — they come from executing your route registrar and inspecting your models. Ignore those with `config/audit.ts` instead, keyed by the finding's `key` (copy it straight from `--json` output) and a required `reason`:

```ts
// config/audit.ts
export default {
  ignore: [
    { key: 'authz:POST /webhooks/stripe', reason: 'HMAC signature verified in the controller' },
  ],
}
```

Ignored findings stay in the report with `status: "ignored"` and an `ignoreReason` — nothing is silently dropped. An entry with a missing `key`/`reason`, or one that never matches a finding, produces its own warning so stale rules don't rot unnoticed.

`config/audit.ts` only accepts findings that have no source line — the route- and model-level ones above. Line-scoped findings (hardcoded secrets, raw SQL, disabled security toggles) already have `// guren-audit-ignore` for that; an entry targeting one is rejected with a warning pointing you back to the inline comment, rather than becoming a second, less visible way to silence them.

### Architecture boundaries

Drop a `guren.arch.ts` file at your project root and `guren check` starts enforcing it — no flag required:

```typescript
// guren.arch.ts
import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  layers: {
    domain: 'app/Domain/**',
    http: 'app/Http/**',
  },
  rules: [
    // Domain logic must not depend on the HTTP layer.
    { from: 'domain', disallow: ['http'] },
    // Controllers should query through Models, not the ORM directly.
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
```

Each rule's `from` and `disallow` accept either a layer name declared above or an inline glob. Add `severity: 'warn'` while rolling out a new boundary on an existing codebase, then drop it (defaulting to `'fail'`) once violations reach zero.

Two flags make this practical for AI coding agents and large apps:

```bash
bunx guren check --arch      # architecture checks only — fast path for an edit hook
bunx guren check --changed   # restrict checks to files changed vs. the merge base with main
```

An import Guren can't resolve to a project file is reported as a warning, never a failure — an unresolved path shouldn't block your build.

## Application Modules

As an app grows past a couple dozen routes, `guren make:module` gives you a self-contained slice of the app instead of piling everything into one flat `app/`, `routes/`, and `db/schema.ts`:

```bash
bunx guren make:module Billing
```

This scaffolds `modules/billing/{index.ts, routes.ts, db/schema.ts}` and wires it in automatically: `db/schema.ts` gets `export * from '../modules/billing/db/schema'`, and `src/app.ts` gets `billingModule` imported and added to `createApp({ modules: [...] })`.

Most `make:*` commands accept `--module <name>` to scaffold inside a module instead of the project root:

```bash
bunx guren make:controller Invoice --module billing   # modules/billing/app/Http/Controllers/InvoiceController.ts
bunx guren make:model Invoice --module billing        # modules/billing/app/Models/Invoice.ts
```

`guren check`, `guren audit`, `guren context`, `model:list`, and `doctor` all scan `modules/*/` automatically — no extra configuration needed. Two exceptions: `make:auth` (authentication is an app-wide concern, not a per-module one) and `make:migration` (drizzle-kit driven; migrations are generated from whichever schema paths `drizzle.config.ts` points at, module or not).

A module's public API is its `index.ts` — the `defineModule()` descriptor it exports — plus `db/schema.ts` for table definitions shared across modules. Once a `modules/` directory exists, `guren check` enforces this automatically, with no `guren.arch.ts` required: a file inside one module reaching into another module's internals (anything other than its `index.ts` or `db/schema.ts`) is a failure, and so is top-level app code doing the same.

```typescript
// modules/billing/index.ts
import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes'

export const billingModule = defineModule({
  name: 'billing',
  prefix: '/billing',            // optional URL prefix for every route the registrar declares
  routes: registerBillingRoutes,
  providers: [BillingServiceProvider],  // optional — appended to the app's provider list
})
```

Inertia pages are not colocated inside `modules/<name>/` — they stay under the top-level `resources/js/pages/`, namespaced by module name instead (`resources/js/pages/billing/Invoices/Index.tsx`). `make:feature Invoice --module billing` follows this convention automatically.

## AI Agent Harness

Apps scaffolded with `create-guren-app` include an AI agent harness out of the box: a `CLAUDE.md` project guide, verified API rules, skills, and subagents under `.claude/`, an `.mcp.json` pointing at the dev server's MCP endpoint (the scaffolded `dev` script enables it via `GUREN_MCP=1`), and hooks that close the feedback loop — the `guren context` project map loads at session start, and `guren check` re-runs automatically after edits to routes, controllers, models, schema, or pages, reporting failures straight back to the coding agent.

| Command | Description | Example |
|---------|-------------|---------|
| `agent:init` | Install the agent harness into an existing app (skips files that already exist; `--force` overwrites) | `bunx guren agent:init` |
| `agent:sync` | Refresh framework-managed files (`.claude/` rules, skills, agents, hooks) to the latest version | `bunx guren agent:sync` |

`agent:sync` never touches user-owned files — `CLAUDE.md`, `.mcp.json`, and `.claude/settings.json` — so your customizations survive framework updates.

## Deployment Recipes

Generate deployment config files directly from the CLI:

```bash
# Dockerfile only
bunx guren deploy

# Fly.io (Dockerfile + fly.toml)
bunx guren deploy --target fly --app my-app

# Railway (Dockerfile + railway.json)
bunx guren deploy --target railway

# Vercel (vercel.json)
bunx guren deploy --target vercel

# Generate all recipes at once with a custom port
bunx guren deploy --target all --app my-app --port 4000
```

Supported targets are `docker`, `fly`, `railway`, `vercel`, and `all`.

Vercel and Bun
Vercel supports deploying Bun applications. For Bun projects consider either:

- Using `vercel.json` with Bun commands (recommended for simple apps):

  ```json
  {
    "installCommand": "bun install",
    "buildCommand": "NODE_ENV=production bun run build",
    "devCommand": "bun run dev"
  }
  ```

- Deploying a Docker image (recommended when you need exact Bun version, native dependencies, or long-running processes).

Recommendation: If your app relies on a specific Bun version or needs long-lived processes, prefer Docker deployment for reproducibility. The generated `vercel.json` is a starting point; adjust commands, routes, and runtime strategy to your project.

## OpenAPI Commands

| Command | Description | Example |
|---------|-------------|---------|
| `openapi:generate` | Generate an OpenAPI 3.1 document from route definitions | `bunx guren openapi:generate` |

Requires the optional `@guren/openapi` package (`bun add @guren/openapi`).

### openapi:generate Options

```bash
# Generate with defaults (reads routes/web.ts, writes .guren/openapi.gen.json)
bunx guren openapi:generate

# Custom title, version, and description
bunx guren openapi:generate --title "Blog API" --version "1.0.0" --description "My blog"

# Custom routes file and output path
bunx guren openapi:generate --routes routes/api.ts --out docs/openapi.json

# Include a server URL
bunx guren openapi:generate --server "https://api.example.com"

# Overwrite existing file
bunx guren openapi:generate --force
```

| Flag | Default | Description |
|------|---------|-------------|
| `--routes` | `routes/web.ts` | Path to the route registration file |
| `--out` | `.guren/openapi.gen.json` | Output path for the generated document |
| `--title` | `package.json` name or `"Guren API"` | OpenAPI document title |
| `--version` | `package.json` version or `"1.0.0"` | OpenAPI document version |
| `--description` | `package.json` description | OpenAPI document description |
| `--server` | — | Server URL to include |
| `--app` | Current directory | Application root directory |
| `--force` | `false` | Overwrite existing files |

The command extracts Zod schemas and OpenAPI metadata (`summary`, `description`, `tags`, `operationId`, `deprecated`) from route contracts and produces an OpenAPI 3.1 JSON document. See [Routing — OpenAPI](./routing.md#openapi-document-generation) for details on annotating routes.

## Route Commands

| Command | Description | Example |
|---------|-------------|---------|
| `route:list` | List all registered routes | `bunx guren route:list` |

### route:list Options

Display all application routes with filtering and sorting capabilities:

```bash
# List all routes
bunx guren route:list

# Filter by HTTP method
bunx guren route:list --method GET

# Filter by path pattern
bunx guren route:list --path users

# Filter by route name
bunx guren route:list --name admin

# Sort routes
bunx guren route:list --sort path
bunx guren route:list --sort method
bunx guren route:list --sort name

# Reverse sort order
bunx guren route:list --sort path --reverse

# Output formats
bunx guren route:list --format table   # Default table format
bunx guren route:list --format json    # JSON output
bunx guren route:list --format compact # Compact single-line format
```

## Config Commands

| Command | Description | Example |
|---------|-------------|---------|
| `config:cache` | Cache all configuration files | `bunx guren config:cache` |
| `config:clear` | Clear the configuration cache | `bunx guren config:clear` |
| `config:show` | Display configuration cache info | `bunx guren config:show` |

### Configuration Caching

Cache your configuration files for improved performance in production:

```bash
# Cache all configuration
bunx guren config:cache

# Clear the cache
bunx guren config:clear

# View cache info
bunx guren config:show
```

The cache is stored in `bootstrap/cache/config.json`. Configuration files are loaded from the `config/` directory (including nested subdirectories).

**Note:** After modifying configuration files, run `config:cache` again to update the cache.

## Database Commands

| Command | Description | Example |
|---------|-------------|---------|
| `db:migrate` | Run pending database migrations | `bunx guren db:migrate` |
| `db:rollback` | Rollback the last migration batch | `bunx guren db:rollback` |
| `db:reset` | Drop all tables and re-run migrations | `bunx guren db:reset` |
| `db:seed` | Run database seeders | `bunx guren db:seed` |

### db:migrate Options

```bash
# Run migrations
bunx guren db:migrate

# Force migrations in production
bunx guren db:migrate --force

# Specify migration path
bunx guren db:migrate --path db/migrations
```

### db:rollback Options

```bash
# Rollback last batch
bunx guren db:rollback

# Rollback specific number of steps
bunx guren db:rollback --step 3

# Rollback all migrations
bunx guren db:rollback --all
```

### db:seed Options

```bash
# Run all seeders
bunx guren db:seed

# Run specific seeder
bunx guren db:seed --class UserSeeder

# Force seeding in production
bunx guren db:seed --force
```

## Queue Commands

| Command | Description | Example |
|---------|-------------|---------|
| `queue:work` | Start processing queued jobs | `bunx guren queue:work` |

### queue:work Options

```bash
# Process jobs from default queue
bunx guren queue:work

# Process specific queue
bunx guren queue:work --queue emails

# Limit number of jobs
bunx guren queue:work --max-jobs 100

# Stop when queue is empty
bunx guren queue:work --stop-when-empty
```

## Shared Options

These options behave consistently across every `make:*` and `add` command:

- `--force` / `-f`: Overwrite files even if they already exist.
- `--dry-run`: Show what would be generated without writing files (planned).
- `--cwd <path>`: Execute the command against a specific workspace (defaults to the current directory).

## Template Details

Generated files match the Laravel-inspired ergonomics of the framework:

- Controllers extend `Controller` and use helpers like `this.inertia()`.
- Models extend `Model<TRecord>` and prefill `static table`. Use the helpers for quick CRUD, or call Drizzle’s RQB directly. `Model.query(db)` lets you start from the model while still writing Drizzle-flavoured queries.
- Views are React + TypeScript + Tailwind CSS functional components.

After generation remember to wire up routes and connect `static table` to the proper Drizzle schema. Complex queries can skip the model entirely—use your Drizzle database (`getDatabase()`) or `Model.query()` to stay type-safe.

## Scaffolding New Apps

Use the dedicated bootstrapper when starting from scratch:

```bash
bunx create-guren-app my-app
```

The CLI copies the default template, updates metadata, and prompts for a rendering mode. Choose **SSR** (default) to keep server-side rendering enabled via `autoConfigureInertiaAssets`, or pick **SPA** to disable SSR. Skip the prompt with `--mode ssr` or `--mode spa`, and overwrite a non-empty directory with `--force`.

## Troubleshooting
- `command not found: bunx`: Your Bun version may be outdated. Upgrade to 1.1 or later.
- `Error: Port already in use`: The development server (default port 3333) is occupied. Update `PORT` in `.env` and restart.
- `Database connection failed`: Make sure your Postgres instance is reachable and that `.env` points to `postgres://guren:guren@localhost:54322/guren`.

## Interactive REPL

Launch the framework-aware console with:

```bash
bunx guren console
```

> This is an interactive REPL, not your application's commands. To run those, use `bun run console <command>` — see the [console commands guide](./console.md).

The command boots your application (honouring `src/main.ts` and registered providers), then drops into a prompt preloaded with useful globals—`app`, `auth`, discovered models, database helpers, and utilities from `@guren/testing`. Use `:help` to explore console shortcuts, or `:editor` when you need a multiline buffer.

### Typical workflow

1. **Launch** – `bunx guren console` from your project root.
2. **Execute code** – Issue ad-hoc queries or inspect services already registered during bootstrap scripts such as `src/main.ts`. Because the REPL shares scope across commands (and auto-registers models), you can run statements like `await Post.all()` directly without re-importing classes.
3. **Reset state** – Exit with `Ctrl+D` (or `.exit`) and relaunch the console when you need a clean slate.

### Tips

- Press `Ctrl+D` (or type `.exit`) to leave the REPL.
- `reloadModels()` refreshes the discovered model list if you add a new class while the console is running.
- `:load path/to/script.ts` executes the contents of a file inside the current session.
- Need the plain Bun REPL? Run `bun repl` for a minimal prompt or `bun repl --inspect` to pair with DevTools.

These patterns deliver the same iterative mode of operation you’d expect from a future `guren repl`, without waiting for a dedicated CLI wrapper.
