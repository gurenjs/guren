---
name: guren-api
description: Guren framework API documentation, code patterns, and examples. Covers all subsystems — Controllers, Models, Routes, Middleware, Authentication, Authorization, Events, Jobs, Queue, Mail, Cache, Validation, Broadcasting, Notifications, Storage, Scheduling, I18n, Encryption, Health Checks, Error Handling, Container/ServiceProvider, Console Commands, and API Resources. Use when user asks "how to", "how does", "example of", "what is", or needs help understanding any Guren API.
---

# Guren API Documentation Skill

You are a documentation assistant for the Guren framework.

## Your Role

Help users understand and use Guren framework APIs by providing examples, patterns, and source file locations.

## Core Subsystems

### Controllers
Source: `packages/core/src/mvc/Controller.ts`

```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'

const PostIdParamSchema = z.object({ id: z.coerce.number().int().positive() })
const CreatePostSchema = z.object({ title: z.string().min(1), body: z.string().min(1) })

export default class PostController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia('Posts/Index', { posts })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)  // throws 422
    const post = await Post.findOrFail(id)                  // throws 404
    return this.inertia('Posts/Show', { post })
  }

  async store() {
    const data = await this.validateBody(CreatePostSchema)  // throws 422
    const user = await this.auth.userOrFail()               // throws 401
    await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

**Validation helpers** (Zod duck-type — any schema with `safeParse()` works):
- `this.validateBody<T>(schema): Promise<T>` — parse request body
- `this.validateQuery<T>(schema): T` — parse query parameters
- `this.validateParams<T>(schema): T` — parse route parameters

All throw `ValidationException` (HTTP 422) on failure.

**Auth helpers:**
- `this.auth.user<T>()` — returns user or null
- `this.auth.userOrFail<T>()` — returns user or throws `AuthenticationException` (401)

### Models
Source: `packages/orm/src/Model.ts`

```typescript
import { Model } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends Model<typeof posts.$inferSelect> {
  static table = posts
}

// Usage
await Post.find(1)                              // returns null if not found
await Post.findOrFail(1)                        // throws ModelNotFoundException (404)
await Post.where('published', true).get()
await Post.create({ title: 'Hello' })
```

`ModelNotFoundException` (source: `packages/orm/src/ModelNotFoundException.ts`) carries `statusCode: 404` and is automatically rendered as HTTP 404 by the ExceptionHandler.

### Routes
Source: `packages/core/src/mvc/Route.ts`

```typescript
import { Route } from '@guren/core'

Route.get('/posts', PostController.index)
Route.post('/posts', PostController.store)
Route.resource('/posts', PostController)

Route.middleware(['auth']).group(() => {
  Route.get('/dashboard', DashboardController.index)
})
```

### Middleware
Source: `packages/core/src/http/middleware/`

```typescript
import { defineMiddleware } from '@guren/core'

export const logRequest = defineMiddleware(async (ctx, next) => {
  console.log(ctx.req.method, ctx.req.url)
  await next()
})
```

### Authentication
Source: `packages/core/src/auth/`

```typescript
import { requireAuthenticated } from '@guren/core'

Route.middleware([requireAuthenticated]).group(() => {
  // Protected routes
})

// In controller
const user = await this.auth.user()         // returns user | null
const user = await this.auth.userOrFail()   // throws AuthenticationException (401)
const isLoggedIn = await this.auth.check()  // returns boolean
```

Additional auth features:
- API Tokens: `packages/core/src/auth/api-token.ts`
- Email Verification: `packages/core/src/auth/email-verification.ts`
- Password Reset: `packages/core/src/auth/password-reset.ts`

## Extended Subsystems

### Authorization (Gate & Policy)
Source: `packages/core/src/authorization/`

- `Gate.ts` — Define abilities and policies
- `Policy.ts` — Resource-based authorization
- `middleware.ts` — Route-level authorization middleware

### Events & Listeners
Source: `packages/core/src/events/`

- `Event.ts` — Base event class
- `EventManager.ts` — Event dispatcher
- `Listener.ts` — Base listener class
- `builtin.ts` — Built-in framework events

Register events in `app/Providers/EventServiceProvider.ts`.

### Jobs & Queue
Source: `packages/core/src/queue/`

- `Job.ts` — Base job class with `handle()` method
- `QueueManager.ts` — Queue manager (memory, Redis drivers)
- `Worker.ts` — Queue worker process

Drivers: `packages/core/src/queue/drivers/`

### Mail
Source: `packages/core/src/mail/`

- `Mail.ts` — Base mailable class
- `MailManager.ts` — Mail manager

Transports:
- `MemoryTransport.ts` — For testing
- `ResendTransport.ts` — Resend API
- `SmtpTransport.ts` — SMTP

### Cache
Source: `packages/core/src/cache/`

- `CacheManager.ts` — Cache manager
- `TaggedCache.ts` — Tag-based cache invalidation

Stores:
- `MemoryStore.ts` — In-memory
- `FileStore.ts` — File-based
- `RedisStore.ts` — Redis

### Validation
Source: `packages/core/src/http/validation/`

- `Validator.ts` — Validation engine
- `rules.ts` — Built-in validation rules
- `FormRequest.ts` — Form request validation (`packages/core/src/http/FormRequest.ts`)

### Broadcasting
Source: `packages/core/src/broadcasting/`

- `BroadcastManager.ts` — Broadcast manager

Channels: `Channel.ts`, `PrivateChannel.ts`, `PresenceChannel.ts`
Drivers: `MemoryDriver.ts`, `RedisDriver.ts`

### Notifications
Source: `packages/core/src/notifications/`

- `Notification.ts` — Base notification class
- `NotificationManager.ts` — Notification dispatcher

Channels: `MailChannel.ts`, `SlackChannel.ts`, `DatabaseChannel.ts`, `MemoryChannel.ts`

### Storage
Source: `packages/core/src/storage/`

- `StorageManager.ts` — Storage manager

Drivers: `LocalDriver.ts`, `MemoryDriver.ts`, `S3Driver.ts`

### Scheduling
Source: `packages/core/src/scheduling/`

- `Schedule.ts` — Schedule definition
- `Scheduler.ts` — Scheduler runner
- `ScheduledTask.ts` — Individual scheduled task
- `CronParser.ts` — Cron expression parser

### I18n (Internationalization)
Source: `packages/core/src/i18n/`

- `I18nManager.ts` — I18n manager
- `Translator.ts` — Translation engine
- `pluralization.ts` — Pluralization rules

Loaders: `JsonLoader.ts`, `MemoryLoader.ts`

### Encryption
Source: `packages/core/src/encryption/`

- `Encrypter.ts` — Encrypt/decrypt values
- `Hash.ts` — Hashing utilities
- `Random.ts` — Secure random generation

### Health Checks
Source: `packages/core/src/health/`

- `HealthManager.ts` — Health check manager
- `HealthCheck.ts` — Base health check

Checks: `DatabaseCheck.ts`, `RedisCheck.ts`, `CacheCheck.ts`, `MemoryCheck.ts`, `StorageCheck.ts`, `CustomCheck.ts`

### Error Handling
Source: `packages/core/src/errors/`

- `ExceptionHandler.ts` — Global exception handler (supports duck-typed `statusCode` property)
- `HttpException.ts` — Base HTTP exception
- `debug-page.ts` — Debug error page

Exceptions: `NotFoundHttpException.ts`, `ValidationException.ts`, `AuthenticationException.ts`, `AuthorizationException.ts`, `MethodNotAllowedException.ts`

The ExceptionHandler automatically handles:
- `HttpException` subclasses → uses their status code
- Any error with a `statusCode` property (duck-typed) → uses that status code (e.g., `ModelNotFoundException` → 404)
- Other errors → 500 (message hidden unless debug mode)

### Container & Service Providers
Source: `packages/core/src/container/`

- `Container.ts` — IoC container
- `ServiceProvider.ts` — Base service provider

Built-in providers: `packages/core/src/providers/`

### Console Commands
Source: `packages/core/src/console/`

- `Command.ts` — Base command class
- `ConsoleKernel.ts` — Console kernel
- `Input.ts` / `Output.ts` — IO handling

### API Resources
Source: `packages/core/src/http/resources/`

- `Resource.ts` — API resource transformer
- `ResourceCollection.ts` — Collection of resources
- `Paginator.ts` — Offset-based pagination
- `CursorPaginator.ts` — Cursor-based pagination

### Database (Factory & Seeder)
Source: `packages/core/src/database/`

- `Factory.ts` — Model factory for testing
- `Seeder.ts` — Database seeder
- `SeederRunner.ts` — Seeder execution

### Logging
Source: `packages/core/src/logging/`

- `LogManager.ts` — Log manager
- `Logger.ts` — Logger instance

Channels: `ConsoleChannel.ts`, `FileChannel.ts`, `DailyFileChannel.ts`

### Redis
Source: `packages/core/src/redis/`

- `client.ts` — Redis client
- Session, rate-limit, API token, email verification, password reset stores

## Reference Locations

| Subsystem | Source Path |
|-----------|------------|
| Controllers | `packages/core/src/mvc/Controller.ts` |
| Models | `packages/orm/src/Model.ts` |
| Routes | `packages/core/src/mvc/Route.ts` |
| Auth | `packages/core/src/auth/` |
| Authorization | `packages/core/src/authorization/` |
| Events | `packages/core/src/events/` |
| Queue/Jobs | `packages/core/src/queue/` |
| Mail | `packages/core/src/mail/` |
| Cache | `packages/core/src/cache/` |
| Validation | `packages/core/src/http/validation/` |
| Broadcasting | `packages/core/src/broadcasting/` |
| Notifications | `packages/core/src/notifications/` |
| Storage | `packages/core/src/storage/` |
| Scheduling | `packages/core/src/scheduling/` |
| I18n | `packages/core/src/i18n/` |
| Encryption | `packages/core/src/encryption/` |
| Health Checks | `packages/core/src/health/` |
| Error Handling | `packages/core/src/errors/` |
| Container | `packages/core/src/container/` |
| Console | `packages/core/src/console/` |
| API Resources | `packages/core/src/http/resources/` |
| Database/Seeder | `packages/core/src/database/` |
| Logging | `packages/core/src/logging/` |
| Redis | `packages/core/src/redis/` |
| Example App | `examples/blog/` |
| API Example | `examples/api/` |
| Docs | `web/` |
