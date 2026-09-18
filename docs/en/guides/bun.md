# Fullstack on Bun

Bun ships a runtime, a package manager, a bundler and a test runner, and its dev server can serve HTML pages next to API routes. It does not ship a fullstack framework, and its own documentation says so. This page is for anyone searching for a Bun fullstack framework: what Bun, Hono and Elysia each cover, what is left for you to assemble, and how Guren fills that gap while still deploying to Node.js, Vercel and Cloudflare Workers.

## What Bun Gives You

Bun's fullstack dev server (Bun 1.2.3 and later) takes HTML imports as route entrypoints, bundles the scripts and styles they reference, and lets `Bun.serve()` answer API routes from a `routes` object with hot reloading in development. The runtime adds the pieces a server needs on day one: `Bun.serve()`, `bun:sqlite`, `Bun.password`, `Bun.file()`, `bun test` and `bun install`.

The same documentation lists what the dev server leaves out. Server-side rendering is not built in, API routes are not auto-discovered, and the feature is marked as a work in progress. Nothing in Bun decides how a project is laid out, how a request reaches a database, or how a user logs in. Those decisions are yours, and so is the glue between them.

## What Hono and Elysia Cover

Both are excellent, and both are backend frameworks by their own description.

| | Hono | Elysia |
|---|---|---|
| Describes itself as | A web framework built on Web Standards, for any JavaScript runtime | An ergonomic web framework for building backend servers with Bun |
| Ships | Router, middleware, validators, JSX for server-rendered fragments | Router, schema validation, Eden end-to-end types, OpenAPI generation |
| Leaves to you | ORM, migrations, auth, sessions, jobs, mail, frontend integration | ORM, migrations, auth, sessions, jobs, mail, frontend integration |

If you are building a handful of JSON endpoints, stop here and pick one. Elysia's Eden gives a TypeScript client typed against your routes; Hono runs unchanged on Bun, Node.js, Deno and Workers.

## What Is Left to Build

A fullstack application on top of either framework still needs answers to the same questions, and each answer is a dependency to choose plus glue code to write, test and maintain:

- Database access and migrations
- Passwords, sessions, OAuth, password reset, email verification
- Validation that turns into a 422 response with field errors
- A frontend that receives typed data from the server without a hand-rolled API layer
- Background jobs, mail, cache, events
- A test harness that boots the app and asserts on responses
- A production build for the target you deploy to

## What Guren Adds

Guren is a Laravel-style layer on top of Hono. Every request goes through Hono's router, so you stay in the same performance class, and every row of the previous list has a default:

| You need | In a Guren app |
|---|---|
| HTTP | `router.get('/posts', [PostController, 'index'])`, controllers, middleware groups |
| Database | Drizzle ORM with a Model API: `Post.where('published', true).get()`, `bun run db:migrate` |
| Auth | `bunx guren add auth` scaffolds registration, login, sessions and the password flows; `bunx guren add oauth` adds providers |
| Validation | `this.validateBody(schema)` with a Zod schema; failures become 422 responses |
| Frontend | Inertia.js pages in React, with page props typed from the controller by codegen |
| Jobs, mail, cache, events | Built-in subsystems, opt-in through providers |
| Testing | `TestApp` from `@guren/testing`, on `bun test` |
| Coding agents | `guren context`, `guren check` and `guren audit` give an agent a project map and mechanical verification of its work |

A route, a controller and a typed page:

```ts
// routes/web.ts
import { Router } from '@guren/core'
import PostController from '@/app/Http/Controllers/PostController'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index'])
  router.post('/posts', [PostController, 'store'])
}
```

```ts
// app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { Post } from '@/app/Models/Post'
import { CreatePostSchema } from '@/app/Http/Validators/PostValidator'
import { pages } from '@/.guren/pages.gen'

export default class PostController extends Controller {
  async index() {
    const posts = await Post.where('published', true).orderBy('createdAt', 'desc').get()
    return this.inertia(pages.posts.Index, { posts })
  }

  async store() {
    const data = await this.validateBody(CreatePostSchema)
    const post = await Post.create(data)
    return this.redirect(`/posts/${post?.id ?? ''}`)
  }
}
```

The React page for `pages.posts.Index` declares a `Props` interface, and codegen checks the controller's `this.inertia()` call against it. See [First Steps](./first-steps.md) for the whole request path.

## Where Bun Shows Up in a Guren App

`bunx create-guren-app my-app` scaffolds a project whose scripts run on Bun: `bun run dev` starts the server under `bun --hot`, `bun test` runs the suite, and the default database is SQLite through `bun:sqlite`, with PostgreSQL and MySQL as the other choices. `Bun.password` is available as the Argon2id hasher when you opt in with `createApp({ auth: { hasher: 'argon2' } })`.

Bun-first is not Bun-only. The default password hasher is scrypt through `node:crypto`, so the same code verifies on Node.js. The deploy plugins target AWS Lambda on the Node.js runtime, Vercel on its Bun runtime, and Cloudflare Workers with D1. The [deployment guide](./deployment.md) covers each.

## When to Pick Something Else

- A small API service with no database or users: plain Hono or Elysia, and Elysia if you want Eden's typed client.
- A content site or storefront where React rendering is the product: Next.js.
- A team already on Laravel or Rails with no reason to move: stay.

[Why Guren](./why-guren.md) goes through each comparison in more depth.

## Next Steps

- [Getting Started](./getting-started.md): scaffold an app and run it.
- [The Guren Tutorial](../tutorials/00-overview.md): build a blog with users, authorization, uploads and mail.
- [Deployment](./deployment.md): Bun servers, containers, Lambda, Vercel and Workers.
