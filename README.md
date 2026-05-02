# Guren

[![X (Twitter)](https://img.shields.io/badge/follow-%40gurenjs-black?logo=x)](https://x.com/gurenjs)
[![GitHub Discussions](https://img.shields.io/github/discussions/gurenjs/guren)](https://github.com/gurenjs/guren/discussions)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A Laravel-inspired fullstack TypeScript framework, built for Bun.**

Routing, controllers, ORM, authentication, and Inertia.js + React frontend integration — all in one cohesive developer experience.

> ⚠️ **Alpha (v0.2.x)** — Breaking changes are expected before 1.0.

---

## Quick Start

```bash
# 1. Scaffold a new app
bunx create-guren-app my-app
cd my-app
bun install

# 2. Start the database and run migrations
bun run db:up
bun run db:migrate
bun run db:seed

# 3. Start the dev server
bun run dev
```

Open `http://localhost:3000` and sign in at `/login` with `demo@example.com` / `secret`.

### Add features as you go

```bash
bunx guren add auth            # Authentication
bunx guren add resource posts --fields "title:string,body:text"  # CRUD resource
bunx guren add queue           # Background jobs
bunx guren add mail            # Email sending
bunx guren add cache           # Cache layer
bunx guren add notifications   # Multi-channel notifications
bunx guren add storage         # File storage
bunx guren add events          # Events & listeners
bunx guren add broadcasting    # Real-time (SSE)
bunx guren add schedule        # Cron scheduling
```

Run `bun run codegen` after adding features to regenerate types.

---

## What you get

- **Laravel-style MVC** — routes, controllers, and an Eloquent-inspired Model API
- **Inertia.js + React** — SPA-like UX without a separate frontend app
- **Drizzle ORM** — swap database backends through an adapter (PostgreSQL / SQLite)
- **End-to-end type safety** — `bunx guren codegen` generates types from schema to frontend props
- **Batteries included** — auth, queues, mail, cache, notifications, storage, broadcasting, scheduling
- **AWS Lambda ready** — deploy serverless via `@guren/server/lambda`

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
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends Model<typeof posts> {
  static table = posts
}

const post = await Post.findOrFail(1)
```

---

## Documentation

- [Official docs](https://gurenjs.vercel.app/) — tutorials, API reference, guides
- [examples/blog](./examples/blog) — reference implementation
- [ROADMAP.md](./ROADMAP.md) — development plans

---

## Requirements

- [Bun](https://bun.sh/) v1.1+
- Docker (for the bundled PostgreSQL container)

---

## Contributing

Issues, discussions, and pull requests are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and workflow.

## License

[MIT License](./LICENSE)
