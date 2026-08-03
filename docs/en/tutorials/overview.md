# Tutorials: Build a Mini Blog

This tutorial series takes you from an empty directory to a small but real blog application. You build it one layer at a time — schema, model, validator, controller, routes, React pages — so by the end you understand how every piece of a Guren app fits together.

If any term is unfamiliar along the way, check the [Glossary](../guides/glossary.md).

## What you'll build

A mini blog where visitors can:

- Browse a paginated list of posts and read each one
- Sign in with a user account
- Write posts (signed-in users only), with each post showing its author
- Leave comments on posts

You will also map the finished app's code, generated specs, and architecture decisions in the Docs Graph.

## The series

The parts build on each other — each one starts where the previous one ended, so work through them in order:

1. **[Create a Blog Post App](./create-blog-post-app.md)** — Scaffold a fresh app and build posts CRUD by hand: a `posts` table, a `Post` model, Zod validation, a controller, routes, and three React pages. **Final result:** you create a post through a form and see it appear in the list.
2. **[Add Authentication](./authentication.md)** — Install the auth scaffold with one command, sign in as the demo user, protect post creation behind a login wall, and attach an author to every post. **Final result:** only signed-in users can write posts, and each post shows who wrote it.
3. **[Relationships: Comments](./relationships.md)** — Add a `comments` table related to both posts and users, declare `hasMany`/`belongsTo` relationships, and build a comment form on the post page. Then generate spec views, record an architecture decision, validate its links, and inspect the finished system in the Docs Graph. **Final result:** signed-in users can comment on any post, and the code, generated views, and decision behind that behavior are connected and browsable.

## Prerequisites

- **[Bun](https://bun.sh) 1.1 or later** — the only hard requirement.
- That's it. The scaffold defaults to **SQLite**, which needs zero configuration — no Docker, no database server. (You can pick PostgreSQL or MySQL when scaffolding, but this course sticks with the SQLite default.)

Each part takes roughly 15–25 minutes; the final part includes the Docs Graph workflow.

> [!TIP]
> This series focuses on building features. For a broader tour of environment setup, rendering modes, and production builds, see [Getting Started](../guides/getting-started.md) and [First Steps: A 10-Minute Tour of One Request](../guides/first-steps.md).

Ready? Start with [Part 1: Create a Blog Post App](./create-blog-post-app.md).
