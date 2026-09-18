# @guren/cli

The CLI for [Guren](https://guren.dev/), a Bun-first fullstack TypeScript framework with Laravel-style conventions. Scaffolding, migrations, codegen, and the integrity checks a coding agent runs to verify its own work.

You do not install this package directly. It ships as a dependency of `@guren/core`, so every Guren app already has it:

```bash
bunx create-guren-app my-app
```

Inside an app, run it with `bunx guren`. The `guren` command resolves through the app's local `@guren/cli`, so it only works from a project directory.

## What it does

```bash
bunx guren make:feature Post --fields "title:string,body:text"  # CRUD scaffold
bunx guren add auth                 # registration, login, sessions, password flows
bunx guren db:migrate               # run pending migrations
bunx guren codegen                  # regenerate typed routes, pages, and API client
bunx guren gate                     # every CI stage under one exit code
```

`bunx guren --help` lists all commands. The [CLI guide](https://guren.dev/docs/guides/cli) documents each one.

## Commands for coding agents

These exist so an agent can read the project and check its work instead of guessing:

| Command | Answers |
|---------|---------|
| `guren context` | What is in this project? A map with API signatures, models, routes, and pages |
| `guren context <Entity>` | Everything about one entity: model, routes, pages, resource, policy, linked docs |
| `guren check` | Do routes, controllers, and pages agree? Plus doc links, spec freshness, and wiring rules |
| `guren audit` | Which mutating routes have no validation or authorization? Plus raw SQL, secrets, CSRF exemptions |
| `guren doctor --next` | What is misconfigured, and what to do about it |
| `guren agent:init` | Install the agent harness: `CLAUDE.md`, rules, skills, hooks, `.mcp.json` |

## Subpath exports

| Import | Contents |
|--------|----------|
| `@guren/cli/arch` | `defineArchRules()` for `guren.arch.ts` architecture boundaries |
| `@guren/cli/oxlint` | Lint rules shipped to scaffolded apps, including `guren/await-async-assertion` and `guren/no-nullish-env-default` |
| `@guren/cli/vite` | The route-types Vite plugin |

## Documentation

[guren.dev/docs](https://guren.dev/docs)

## License

MIT
