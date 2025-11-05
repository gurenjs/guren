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

## Core Commands

| Command | Description | Example |
|---------|-------------|---------|
| `make:controller <Name>` | Generates a controller in `app/Http/Controllers` | `bunx guren make:controller PostController` |
| `make:model <Name>` | Generates a model class and type definition in `app/Models` | `bunx guren make:model Post` |
| `make:view <path>` | Generates a React component in `resources/js/pages` | `bunx guren make:view posts/Index` |
| `make:auth` | Scaffolds login/logout controllers, provider, views, migration, seeder, and routes | `bunx guren make:auth` |

> **Note:** `make:*` commands avoid overwriting existing files. Use `--force` if you need to replace them.

## Shared Options

Common options are centralised under `packages/core/src/cli` so behaviour stays consistent:

- `--force` / `-f`: Overwrite files even if they already exist.
- `--dry-run`: Show what would be generated without writing files (planned).
- `--cwd <path>`: Execute the command against a specific workspace (defaults to the current directory).

## Template Details

Generated files match the Laravel-inspired ergonomics of the framework:

- Controllers extend `Controller` and use helpers like `this.inertia()`.
- Models extend `Model<TRecord>` and prefill `static table`.
- Views are React + TypeScript + Tailwind CSS functional components.

After generation remember to wire up routes and connect `static table` to the proper Drizzle schema.

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
