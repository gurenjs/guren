# Tutorials: Build a Mini Blog

This tutorial series takes you from an empty directory to a small but real blog application — and it works the way Guren works: **generate with the CLI, read the generated code to understand it, and verify mechanically with `check` and `audit`**. You'll turn that development loop for every feature you add. By the end you'll understand both how the pieces of a Guren app fit together and the day-to-day workflow.

If any term is unfamiliar along the way, check the [Glossary](../guides/glossary.md).

## What you'll build

A mini blog where visitors can:

- Browse a paginated list of posts and read each one
- Sign in with a user account
- Write, edit, and delete posts (signed-in users only), with each post showing its author
- Leave comments on posts

And you'll connect the finished app's code, generated specs, and architecture decisions in the Docs Graph.

## The series

Each part starts where the previous one ended. Follow them in order.

1. **[Create a Blog Post App](./create-blog-post-app.md)** — Scaffold a fresh app, then generate the entire posts CRUD (schema, model, validator, resource, controller, routes, and four React pages) with a single `bunx guren add resource` command. Then derive the big picture with `guren context` and spec views, read the generated code layer by layer, refine it with validation messages and `fillable`, and verify with `guren check` and `guren audit`. **End state:** a working CRUD without hand-writing a line of code — and you can explain every layer of it.
2. **[Add Authentication](./authentication.md)** — Install the auth stack (login, registration, password reset) with one command, sign in as a demo user, put post mutations behind a login wall, and attach an author to every post. The goal line is resolving the warnings `audit` raised in Part 1 — and catching the spec views back up through the `check --spec` drift gate after the schema change. **End state:** only signed-in users can change posts, every post shows who wrote it, and `audit` is quiet.
3. **[Relationships: Comments](./relationships.md)** — Add a `comments` table related to both posts and users, scaffold the skeleton with the single-purpose `make:*` generators, and finish the `hasMany` / `belongsTo` relationships and a comment form on the post page. Then generate spec views, record the architecture decision, verify the links, and explore the finished system in the Docs Graph. **End state:** signed-in users can comment on any post, and the code, derived views, and decisions behind that behavior are connected.

## Prerequisites

- **[Bun](https://bun.sh) 1.1+** — that's the only requirement.
- That's it. The scaffold defaults to **SQLite**, which needs zero configuration — no Docker, no database server. (PostgreSQL and MySQL are offered during scaffolding, but this course keeps the SQLite default.)

Each part takes roughly 15–25 minutes. The final part includes the Docs Graph workflow.

> [!TIP]
> This series focuses on building features. For a broader tour including environment setup, rendering modes, and production builds, see [Getting Started](../guides/getting-started.md) and [First Steps](../guides/first-steps.md); for the full command surface, see the [CLI reference](../guides/cli.md).

Ready? Start with [Part 1: Create a Blog Post App](./create-blog-post-app.md).
