# @guren/core

The framework entry point for [Guren](https://guren.dev/) — a Laravel-inspired fullstack TypeScript framework, built for Bun. Application code imports everything from this one package: routing, controllers, validation, authentication, the ORM surface, queues, mail, events, and the rest of the framework API.

```bash
bun add @guren/core
```

Starting a new app? Scaffold one instead — it wires all of this up for you:

```bash
bunx create-guren-app my-app --auth
```

## Usage

```typescript
import { Controller, Router, createApp } from '@guren/core'
import { Model } from '@guren/core'
import { z } from 'zod'

class PostController extends Controller {
  async store() {
    const data = await this.validateBody(
      z.object({ title: z.string().min(1), body: z.string().min(1) }),
    )
    const post = await Post.create(data)
    return this.redirect(`/posts/${post.id}`)
  }
}

export function registerWebRoutes(router: Router): void {
  router.post('/posts', [PostController, 'store'])
}
```

Boot the app with `createApp({ routes, providers })`, then `app.boot()` and `app.listen()`.

## Entry points

| Import | Contents |
|--------|----------|
| `@guren/core` | The framework API: controllers, routing, middleware, auth, models, queues, mail, events, notifications, cache, validation |
| `@guren/core/runtime` | Bun server helpers used by the scaffolded `bin/serve.ts` |
| `@guren/core/vite` | The Vite plugin: Inertia + React integration, codegen watching, SSR builds |
| `@guren/core/lambda` | AWS Lambda adapters: `createLambdaHandler`, `createSqsHandler`, `createScheduleHandler`, `createConsoleHandler` |
| `@guren/core/redis` | Redis-backed session, cache, and queue stores |

The `guren` CLI ships with this package too — `bunx guren` inside an app gives you scaffolding (`make:*`), codegen, migrations, and the integrity checks (`check`, `audit`, `doctor`).

## Documentation

Guides, API reference, and deployment docs (Cloudflare Workers, AWS Lambda, Vercel, Docker) live at [guren.dev/docs](https://guren.dev/docs).
