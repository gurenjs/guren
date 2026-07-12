# Why Guren

An honest look at where Guren fits — compared with Hono, Next.js, and Laravel — and why it is built the way it is.

## The Short Version

- **Choose Guren** when you are building a fullstack app — auth, database, forms, background jobs, mail — and want it all wired together, typed end to end, in one TypeScript codebase.
- **Choose plain Hono** when you are building a small, stateless API service and want nothing else in the way.
- **Choose Next.js** when your product is content-heavy and React-rendering-first: marketing sites, e-commerce storefronts, apps built around React Server Components.

Guren also invests heavily in one thing most frameworks do not: making your project easy for **AI coding agents** to understand, extend, and verify. More on that below.

## Compared with Hono

Guren's HTTP layer *is* Hono. Every request goes through Hono's router, so you stay in the same performance class — Guren adds a thin MVC layer on top, not a new server.

What Hono deliberately leaves out, Guren ships:

| You need | With plain Hono | With Guren |
|----------|-----------------|------------|
| Database access | Pick an ORM, wire it up yourself | `Model.where().orderBy().get()` on Drizzle, out of the box |
| Validation | Call your schema library per handler | `this.validateBody(schema)` — 422 responses handled for you |
| Authentication | Assemble sessions, hashing, middleware | `bunx guren add auth` scaffolds the whole flow |
| Frontend | Separate SPA + hand-rolled API layer | Inertia-powered React pages with typed props |
| Background jobs, mail, events, cache | Choose and integrate libraries | Built-in subsystems, opt-in via providers |
| Testing | Compose your own harness | `TestApp` with fluent assertions |

If your service is a handful of JSON endpoints, plain Hono is a great choice — and because Guren is Hono underneath, growing from one into the other is natural rather than a rewrite. The difference shows up as the app grows: every row in that table is glue code you would otherwise write, test, and maintain yourself.

## Compared with Next.js

Next.js and Guren answer different questions. Next.js is React-first: rendering strategy (RSC, streaming, ISR) is the core abstraction, and the backend grows out of the frontend. Guren is server-first: an MVC application in the Laravel tradition, where React is the view layer, delivered through Inertia.

In practice this changes how a feature gets built:

- **One mental model.** A feature is a route, a controller, a model, and a page. There is no client/server component boundary to reason about, no `'use client'` decisions, and no API route layer between your data and your React props.
- **No hand-written data plumbing.** The controller passes typed props straight to the page component. Renaming a database column produces TypeScript errors from the model all the way into the React page.
- **The backend is a first-class citizen.** Queues, scheduled jobs, mail, broadcasting, and policies are framework subsystems — not features you assemble from third-party services around a rendering framework.

Next.js remains the better fit when server-rendered React itself is the product — heavy content sites, granular per-component streaming, or teams committed to the RSC ecosystem.

## Compared with Laravel and Rails

If you come from Laravel or Rails, Guren will feel like home: controllers, models, middleware, policies, resources, jobs, and `make:*` generators all behave the way you expect. What changes is the language boundary — there isn't one:

- **One language end to end.** No PHP-to-JavaScript context switch between backend and frontend. Your validation schemas, models, and page props are all TypeScript.
- **Types cross the wire.** Laravel's DX with static guarantees: the compiler checks that the props a controller sends match what the React page declares.
- **A modern runtime.** Bun executes TypeScript natively — no transpile step in development, fast startup, and a built-in test runner.

## Built for AI Coding Agents

Most frameworks were designed for humans reading documentation. Guren is additionally designed for agents working inside your repository — three properties make the difference:

**Agents can discover the project cheaply.** `bunx guren context` emits a compact map of your routes, models, controllers, and pages (add `--json` for machine-readable output). An agent gets accurate project understanding from one command instead of crawling the tree, which keeps its context window small and its assumptions correct. `bunx guren model:list` does the same for the data model.

**Conventions shrink the decision space.** Controllers live in `app/Http/Controllers`, models in `app/Models`, pages in `resources/js/pages` — and `bunx guren make:feature Post --fields "title:string,body:text"` scaffolds a complete, consistent CRUD slice. When there is one obvious place and one obvious shape for everything, generated code lands right the first time far more often.

**Mistakes are caught mechanically, not by review alone.** Three independent gates verify agent-written code:

```bash
bunx guren check    # routes ↔ controllers ↔ pages stay consistent
bunx guren audit    # missing validation/auth on mutating routes, raw SQL, secrets
bun run typecheck   # typed page props and route contracts fail the build on drift
```

Because page props, route params, and request bodies are all typed contracts, an agent that hallucinates a prop name or forgets a validation schema gets a compile error or a failing check — before you read a single line of the diff.

The result: less context to load, fewer degrees of freedom to get wrong, and mechanical verification of what was produced. That loop — discover, generate, verify — is what makes agent-driven development on Guren dependable rather than hopeful.

## When Not to Choose Guren

No framework is the right answer everywhere. Reach for something else when:

- **Your product is rendering-centric.** Granular streaming SSR, per-component caching, and the RSC ecosystem are Next.js's home turf.
- **You want a micro-footprint service.** A webhook receiver or an edge function does not need MVC — plain Hono is lighter.
- **Your team is committed to another runtime.** Guren is Bun-native by design. Serverless deployment on Node.js runtimes is supported, but the primary development experience assumes Bun.

## Next Steps

- [Quickstart](./getting-started.md) — scaffold a project and see it running in about five minutes.
- [First Steps](./first-steps.md) — trace one request through every layer in ten minutes.
- [Architecture](./architecture.md) — how routing, controllers, models, and Inertia fit together.
- [CLI Reference](./cli.md) — every command, including the inspection commands agents rely on.
