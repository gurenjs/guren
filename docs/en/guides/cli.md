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
bunx guren add plugin @acme/guren-plugin-audit
```

`add plugin` wires the plugin provider into `src/app.ts` and prints a `bun add <package>` hint when the dependency is not installed yet.


These commands patch `src/app.ts`, create the matching provider/runtime files, and keep the generated app aligned with the reference starter.

`bunx guren add admin` scaffolds:

- `app/Http/Controllers/Admin/AdminDashboardController.ts`
- `resources/js/pages/admin/Dashboard.tsx`
- `routes/admin.ts` (and auto-wires `routes/web.ts` when present)

## Core Commands

| Command | Description | Example |
|---------|-------------|---------|
| `key:generate` | Generate a new `APP_KEY` value. Use `--write` to save it to `.env` | `bunx guren key:generate --write` |
| `deploy` | Generate deployment recipe files for Docker/Fly.io/Railway/Vercel | `bunx guren deploy --target all --app my-app --port 3333` |
| `make:controller <Name>` | Generates a controller in `app/Http/Controllers` | `bunx guren make:controller PostController` |
| `make:model <Name>` | Generates a minimal model class and type definition in `app/Models` (imports `camelCase(Name)s` from `db/schema`) | `bunx guren make:model Post` |
| `make:view <path>` | Generates a React component in `resources/js/pages` | `bunx guren make:view posts/Index` |
| `make:auth` | Scaffolds login/logout controllers, provider, views, migration, seeder, and routes | `bunx guren make:auth` |
| `make:middleware <Name>` | Generates a middleware file in `app/Http/Middleware` | `bunx guren make:middleware Auth` |
| `make:policy <Name>` | Generates an authorization policy in `app/Policies` with owner-based defaults | `bunx guren make:policy Post` |
| `make:seeder <Name>` | Generates a database seeder file | `bunx guren make:seeder UserSeeder` |
| `make:job <Name>` | Generates a queueable job class | `bunx guren make:job SendEmail` |
| `make:event <Name>` | Generates an event class | `bunx guren make:event UserRegistered` |
| `make:listener <Name>` | Generates an event listener class | `bunx guren make:listener SendWelcomeEmail` |
| `make:notification <Name>` | Generates a notification class | `bunx guren make:notification InvoicePaid` |
| `make:mail <Name>` | Generates a mailable class | `bunx guren make:mail WelcomeEmail` |

> **Note:** `make:*` commands avoid overwriting existing files. Use `--force` if you need to replace them.

## Inspection & Audit Commands

Validate your app before shipping — these commands are also designed for AI coding agents (add `--json` for machine-readable output):

| Command | Description | Example |
|---------|-------------|---------|
| `check` | Validate integrity across routes, controllers, pages, and models | `bunx guren check --json` |
| `audit` | Security audit: missing input validation or authentication on mutating routes, raw SQL with interpolation, hardcoded credentials, disabled security defaults, mass-assignment configuration | `bunx guren audit --json` |
| `doctor` | Project health report (env, config, generated files) with actionable next steps | `bunx guren doctor --next` |

`audit` exits with a non-zero status when it finds failures, so you can run it in CI:

```bash
bunx guren audit
```

Routes wrapped in named middleware (for example `router.middleware('auth').group(...)`) are recognized as protected. Guest flows such as `/login` and `/register` are excluded from authentication checks.

Suppress a false positive by placing `// guren-audit-ignore` on the flagged line or the line above it:

```ts
// guren-audit-ignore -- documented example value
const apiKey = 'example-not-a-real-key'
```

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

Common options are centralised under `packages/core/src/cli` so behaviour stays consistent:

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
