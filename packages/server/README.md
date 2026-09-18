# @guren/server

The HTTP layer of [Guren](https://guren.dev/), a Bun-first fullstack TypeScript framework with Laravel-style conventions. Routing, controllers, middleware, auth, sessions, queues, mail, events, and the AWS Lambda adapter, built on [Hono](https://hono.dev/).

## Application code should not import this package

Install and import [`@guren/core`](https://www.npmjs.com/package/@guren/core) instead. It re-exports this package's whole public API, so there is one import specifier to learn and one to keep working across releases:

```bash
bun add @guren/core
```

```typescript
import { Controller, Router, createApp } from '@guren/core'
```

Starting a new app? Scaffold one, and this is wired up for you:

```bash
bunx create-guren-app my-app --auth
```

It is published separately because the framework is released as independently versioned packages, not because application code is meant to reach for it. Depend on it directly only when you are writing a Guren plugin against the HTTP layer.

## What is in here

| Area | Contents |
|------|----------|
| HTTP | `Application`, `Router`, `Controller`, middleware, exception handling, CSRF, CORS, rate limiting |
| Auth | Sessions, guards, password hashing, API tokens, OAuth, authorization policies |
| Subsystems | Queues, mail, events, notifications, cache, broadcasting, storage, scheduling, i18n, logging, health checks |
| Runtimes | `@guren/server/lambda` for AWS Lambda, `@guren/server/redis` for Redis-backed stores |

Develop on Bun; deploy to Bun, AWS Lambda on the Node.js runtime, Vercel, or Cloudflare Workers. The default password hasher writes `node:crypto` scrypt on every runtime, so a hash written on Bun verifies on Node.js.

## Documentation

[guren.dev/docs](https://guren.dev/docs)

## License

MIT
