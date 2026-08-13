# __APP_TITLE__

A blog built with [Guren](https://guren.dev) — posts CRUD, session authentication,
and a seeded demo account, ready to run.

## Quick Start

```bash
bun install
bun run db:make      # generate the first migration from db/schema.ts
bun run db:migrate
bun run db:seed      # demo@example.com / secret, plus two sample posts
bun run dev
```

Visit `http://localhost:3333`, then sign in as `demo@example.com` with the
password `secret` and publish a post from `/posts/create`.

If you scaffolded with PostgreSQL or MySQL, run `bun run db:up` first to start
the database container.

## What's Included

- `/` — landing page with the latest posts
- `/posts` — paginated post list, `/posts/:id` — a single post
- `/posts/create`, `/posts/:id/edit` — write and edit, signed in only
- `QUERY /posts/search` — JSON search endpoint using the HTTP QUERY method
  ([RFC 10008](https://www.rfc-editor.org/info/rfc10008/)): safe like GET, but
  the criteria travel in a JSON body. The posts page calls it through the
  generated typed client (`.guren/api-client.gen.ts`), or try it directly:

  ```bash
  curl --request QUERY http://localhost:3333/posts/search \
    --header 'content-type: application/json' \
    --data '{"keywords":["guren"]}'
  ```

- `/login`, `/register`, `/dashboard`, `/profile` — session authentication

Posts belong to their author. `app/Providers/AuthorizationProvider.ts` binds
`app/Policies/PostPolicy.ts` to the `Post` model, and `PostController` calls
`this.authorize()` in every mutating action, so nobody can edit someone else's
post. `app/Providers/AuthProvider.ts` shares the signed-in user with every page,
which is what `resources/js/components/Layout.tsx` reads to show the
Write/Dashboard/Log out controls.

## Project Structure

- `routes/web.ts`, `routes/auth.ts` — route definitions
- `app/Http/Controllers/` — request handlers
- `app/Http/Validators/` — Zod schemas, bound to routes and reused by the pages
- `app/Http/Resources/` — the shapes controllers hand to pages
- `app/Models/` — ORM models (`Post` belongs to `User`)
- `app/Policies/` — authorization rules
- `app/Providers/` — the auth model binding, shared page props, and the policy binding
- `resources/js/pages/` — React pages (rendered via Inertia.js)
- `db/schema.ts` — Drizzle table definitions
- `db/seeders/` — the demo user and sample posts

## Adding Features

```bash
bunx guren add queue          # background job processing
bunx guren add mail           # email sending
bunx guren add events         # event system
bunx guren add cache          # caching layer
bunx guren add notifications  # notification channels
bunx guren add storage        # local/public disks
bunx guren add broadcasting   # realtime channels
bunx guren add schedule       # task scheduling
```

## Favicon

`public/favicon.svg` ships as a placeholder and is linked from `src/app.ts` via
`setInertiaDocument({ head })`, which is the only path that reaches the
production document — `public/index.html` is not read by the server. Replace the
file to change the icon, or edit the `head` markup to add more tags.

Files at the root of `public/` are served by the Bun runtime. On Node-based
deployments (AWS Lambda, for example) serve them from a CDN instead.

## Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server (Bun + Vite) |
| `bun run build` | Build for production |
| `bun run preview` | Start the built app with the Bun production server |
| `bun run db:make` | Generate a migration from `db/schema.ts` |
| `bun run db:migrate` | Run database migrations |
| `bun run db:seed` | Seed the database |
| `bun run codegen` | Regenerate route/page types |

Run `bun run build` before `bun run preview` so the production server can read
the generated manifests from `public/assets`.
