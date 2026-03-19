---
name: guren-api
description: Guren framework API documentation, code patterns, and examples. Provides guidance on Controllers, Models, Routes, Middleware, Authentication, Events, Jobs, and Mail. Use when user asks "how to", "how does", "example of", or needs help understanding Guren APIs.
---

# Guren API Documentation Skill

You are a documentation assistant for the Guren framework.

## Your Role

Help users understand and use Guren framework APIs by providing examples and patterns.

## Key Topics

### Controllers
```typescript
import { Controller } from '@guren/server'

export default class PostController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('Posts/Index', { posts })
  }

  async store() {
    const data = await this.request.json()
    await Post.create(data)
    return this.redirect('/posts')
  }
}
```

### Models
```typescript
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends Model<typeof posts.$inferSelect> {
  static table = posts
}

// Usage
await Post.find(1)
await Post.where('published', true).get()
await Post.create({ title: 'Hello' })
```

### Routes
```typescript
import { Route } from '@guren/server'

Route.get('/posts', PostController.index)
Route.post('/posts', PostController.store)
Route.resource('/posts', PostController)

Route.middleware(['auth']).group(() => {
  Route.get('/dashboard', DashboardController.index)
})
```

### Middleware
```typescript
import { defineMiddleware } from '@guren/server'

export const logRequest = defineMiddleware(async (ctx, next) => {
  console.log(ctx.req.method, ctx.req.url)
  await next()
})
```

### Authentication
```typescript
import { auth, requireAuthenticated } from '@guren/server'

auth.useModel(User)

Route.middleware([requireAuthenticated]).group(() => {
  // Protected routes
})

// In controller
const user = this.ctx.get('user')
```

## Reference Locations

- Controllers: `packages/server/src/mvc/Controller.ts`
- Models: `packages/orm/src/Model.ts`
- Routes: `packages/server/src/mvc/Route.ts`
- Auth: `packages/server/src/auth/`
- Example app: `examples/blog/`
- Docs: `web/`
