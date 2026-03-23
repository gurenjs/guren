# Build Your First Feature in 10 Minutes

This walkthrough uses the current Guren standard path: `@guren/core`, `bunx guren add ...`, page definitions, resource output, and generated route/page manifests.

## What You Will Build

A small posts feature with:

- authentication scaffolding
- a generated resource stack for posts
- typed route/page manifests
- a running SSR app with the default Guren flow

## 1. Create the App

```bash
bunx create-guren-app posts-app --mode ssr
cd posts-app
bun install
```

## 2. Add the Standard Feature Stacks

```bash
bunx guren add auth
bunx guren add resource posts
bunx guren add queue
bunx guren add mail
bunx guren add events
bunx guren add cache
bunx guren add notifications
bunx guren add storage
bunx guren add broadcasting
bunx guren add schedule
```

This gives you:

- `AuthProvider`, login/profile controllers, validators, routes, and page definitions
- `PostController`, `PostResource`, `PostValidator`, CRUD pages, and named routes
- `QueueProvider`, `MailProvider`, `EventProvider`, `CacheProvider`, `NotificationProvider`, `StorageProvider`, `BroadcastProvider`, and `app/Console/Kernel.ts` for the standard async/runtime features
- `.guren/pages.gen.ts` as the auto-generated source for Inertia page props (extracted from each page component's `Props`)

## 3. Generate Typed Manifests

```bash
bun run codegen
```

`codegen` writes:

- `.guren/routes.gen.ts` for runtime-aware named route helpers
- `.guren/pages.gen.ts` for typed page definitions
- `types/generated/routes.d.ts` for editor support

## 4. Prepare the Database

Make sure PostgreSQL is available, then run:

```bash
bun run db:migrate
bun run db:seed
```

## 5. Run the App

```bash
bun run dev
```

Visit:

- `/login` for the generated auth flow
- `/posts` for the generated resource flow

## 6. Understand the Contract Path

The default resource scaffold follows one contract graph:

1. `db/schema.ts` defines the Drizzle table
2. `app/Models/Post.ts` exposes the typed model
3. `app/Http/Resources/PostResource.ts` defines the response shape
4. Props are defined directly in each page component and auto-extracted to `.guren/pages.gen.ts` by codegen
5. `app/Http/Controllers/PostController.ts` validates input and returns resource output

For list pages, the standard shape is:

```ts
type Props = PaginatedPageProps<PostResourceData>
```

That means the page receives:

- `data`
- `pagination.meta`
- `pagination.links`

without rebuilding pagination state in the controller or UI.

## 7. Where to Edit Next

- Adjust `db/schema.ts` to add more post fields.
- Update `app/Http/Validators/PostValidator.ts` to change create/update rules.
- Update `app/Http/Resources/PostResource.ts` when the page/API output should change.
- Update `resources/js/pages/posts/*.tsx` to customize the UI.

## 8. The Recommended Mental Model

When adding new features, prefer this flow:

```bash
bunx guren add resource comments
bun run codegen
```

Then keep each layer focused:

- models describe data access
- validators parse inputs
- resources shape outputs
- page components define props
- controllers compose responses

That is the shortest path to the Rails/Laravel-style DX Guren is aiming for.
