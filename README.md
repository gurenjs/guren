# Guren

[![X (Twitter)](https://img.shields.io/badge/follow-%40gurenjs-black?logo=x)](https://x.com/gurenjs)
[![GitHub Discussions](https://img.shields.io/github/discussions/gurenjs/guren)](https://github.com/gurenjs/guren/discussions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub Sponsors](https://img.shields.io/github/sponsors/7nohe?logo=githubsponsors)](https://github.com/sponsors/7nohe)

**The fullstack TypeScript framework for the AI-agent era.**

Guren is a fullstack framework for Bun where your coding agent works from the same map you do. Laravel-style conventions, type safety from the route definition to the React component, and mechanical checks that verify the work. Secure by default, agent-ready by default.

> **v2** is stable. Breaking changes only in major releases, per the [release policy](docs/en/guides/release-policy.md).

---

## Quick Start

```bash
# 1. Scaffold a new app with authentication (dependencies install automatically)
bunx create-guren-app my-app --auth
cd my-app

# 2. Run migrations and seed the demo user (SQLite by default, no server needed)
bun run db:migrate
bun run db:seed

# 3. Start the dev server
bun run dev
```

Open `http://localhost:3333` and sign in at `/login` with `demo@example.com` / `secret`.

### Add features as you go

```bash
bunx guren add auth            # Session auth: login, registration, middleware
bunx guren add oauth           # OAuth providers with callback routes
bunx guren add session         # Database-backed sessions
bunx guren add resource posts --fields "title:string,body:text"  # CRUD resource
bunx guren add admin           # Starter admin dashboard, auth-guarded
bunx guren add queue           # Background jobs
bunx guren add mail            # Email sending
bunx guren add cache           # Cache layer
bunx guren add notifications   # Multi-channel notifications
bunx guren add storage         # File storage disks
bunx guren add attachments     # Uploads attached to your models
bunx guren add events          # Events & listeners
bunx guren add broadcasting    # Real-time (SSE)
bunx guren add schedule        # Cron scheduling
bunx guren add prototype       # Prototype mode: pages from fixtures, no backend yet
bunx guren add lint            # oxlint with the Guren rules
bunx guren add plugin @acme/guren-plugin-foo   # Install a plugin, register its provider
```

Run `bun run codegen` after adding features to regenerate types. When you are ready to ship, `bun run build` creates the production build.

---

## Your agent works from the same map

A coding agent is a first-class user of the framework here, not an afterthought. Project knowledge is derived where possible, declared where not, and checked always.

```bash
bunx guren context User    # One entity: model, routes, pages, resource, policy, linked docs
bunx guren spec:generate   # ER, domain and screen views, derived from code
bunx guren check           # Route/controller/page wiring, doc links, spec freshness
bunx guren audit           # Validation, authorization, raw SQL, secrets
```

A scaffolded app installs the harness those commands feed: `CLAUDE.md`, glob-scoped rules, skills, hooks and an MCP config, written by `bunx guren agent:init` and refreshed by `agent:sync`. Before an app exists, two on-ramp skills cover the gap. Install them at user scope, since they apply whatever you are building:

```bash
claude plugin marketplace add gurenjs/agent-skills   # or: npx skills add gurenjs/agent-skills
```

The effect is measured. [Agents on Guren](https://github.com/gurenjs/agents-on-guren) runs 20 bug, security and feature tasks with hidden acceptance tests across three models, with and without the harness the scaffold ships: 360 runs, each one's patch, logs and verdict published. On Sonnet 5 the harness passed 60 of 60 runs against 58 of 60 bare, at 28% fewer turns and 25% lower cost. Opus 5 went 60 of 60 either way, at 26% fewer turns and 12% lower cost. On Haiku 4.5 the pass rate itself moved, 51 of 60 to 54, at 6% higher cost. Agents that had the harness ran `guren check` in 119 of their 180 runs; bare, 15.

---

## What you get

- **Laravel-style MVC.** A route points at a controller, the controller validates input and returns an Inertia page, and an Eloquent-inspired Model API rides on Drizzle ORM.
- **No API layer to babysit.** Inertia.js hands controller props straight to your React components, so there is no REST or GraphQL glue to keep in sync.
- **End-to-end type safety.** `bunx guren codegen` turns routes, page props and resources into compile-time contracts. Rename a route and the build fails instead of your users.
- **Secure by default.** Mass assignment is blocked structurally, CSRF protection mounts with sessions, and security headers and same-origin CORS are on before you configure anything.
- **Batteries included.** Auth, sessions, queues, mail, cache, notifications, storage, attachments, events, broadcasting, scheduling and i18n are first-party subsystems, not a shopping list of npm packages.
- **Bun-first, deploy anywhere.** Develop on the Bun toolchain, then self-host on a Bun server or ship the same app to Cloudflare Workers, Vercel or AWS Lambda with first-party plugins. [guren.dev](https://guren.dev/) is a Guren app running on Workers.
- **PostgreSQL, MySQL or SQLite.** One ORM adapter covers all three, and SQLite needs no server for local work.

### Measured, not promised

The same spec app on Guren and on an equivalent Node.js MVC stack, self-hosted and benchmarked under identical conditions with the app code held constant: **2.3× the throughput on full SSR pages, 3.5× on the JSON path, and 1.8× faster cold starts**. The gap is Bun itself, and that is the point: keep the Laravel-style architecture, change the engine. [Methodology and one-command reproduction](https://github.com/gurenjs/framework-comparison/blob/main/BENCHMARK.md).

---

## A taste of the code

### Controller

```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../Models/Post'

const PostSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})

export class PostController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia(pages.posts.Index, { posts })
  }

  async store() {
    const data = await this.validateBody(PostSchema)
    const user = await this.auth.userOrFail()
    await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

### Routes

```typescript
import { Router } from '@guren/core'

export function registerWebRoutes(router: Router): void {
  router.get('/posts', [PostController, 'index'])
  router.post('/posts', [PostController, 'store'])
}
```

### Model

```typescript
import { defineModel } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends defineModel(posts) {}

const post = await Post.findOrFail(1)
```

---

## Documentation

- [Official docs](https://guren.dev/): tutorials, guides and API reference
- [Why Guren](https://guren.dev/docs/guides/why-guren): how it compares, and when to pick something else
- [examples/blog](./examples/blog): the reference implementation

---

## Requirements

- [Bun](https://bun.sh/) v1.1 or later
- Docker only if you want the bundled PostgreSQL or MySQL container. SQLite is the default and needs nothing.

---

## Contributing

Issues, discussions, and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and workflow.

## Support Guren

If Guren is useful to you or your team, consider [sponsoring development on GitHub Sponsors](https://github.com/sponsors/7nohe). Sponsorships fund ongoing maintenance, documentation, and new features.

## License

[MIT License](./LICENSE)
