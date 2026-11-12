---
name: feature
description: "Generate a whole CRUD entity in one go (model, controller, pages, routes, tests, factory, resource): \"CRUD\", \"full feature\", \"build out X\". One component is the scaffold skill."
---

# Feature Skill

`make:feature` writes everything a CRUD entity needs except the three things it
prints as next steps: the table, the route registration and the migration. The
feature is done when those are in, `bunx guren codegen` has run, and
`bunx guren gate` exits 0.

> When filling in generated code, follow the API rules in `__RULES_DIR__/` (orm-models, controllers-http, routes-codegen, testing) and, for signatures they leave out, their full references in `__SKILLS_DIR__/guren-api/reference/`.

## Workflow

### 1. Generate all components

```bash
bunx guren make:feature <Name> --fields "title:string,body:text,published:boolean"
```

`store`, `update` and `destroy` require a signed-in user unless `--public` is
passed. `--test` adds a controller test, `--factory` a model factory, and
`--policy` a policy the mutating actions enforce.

Add `--module <name>` to scaffold the feature inside an existing `modules/<name>/` directory instead of the project root — app/ files move under `modules/<name>/`, but pages stay top-level, namespaced by module name (`resources/js/pages/<name>/...`), not colocated.

When the person wants clickable screens before any backend, use prototype mode:
`bunx guren add prototype` once, then `make:feature <Name> --fields "…" --prototype`
writes the pages and fixture entries with no controller or table, and
`bun run dev:prototype` serves them. Re-running `make:feature` without the flag
promotes the feature. Guide: https://guren.dev/docs/guides/prototype-first

This generates Validator, Resource, Controller, Views (Index/Show/New/Edit), and Model in one step with:
- Typed page props (no `any`)
- `route()` helper for all URLs
- `ApiRoutes` for form data types
- A validation error under each form field, read from `form.errors`

**One piece at a time**, when the entity needs only some of them:

```bash
bunx guren make:model <Name>
bunx guren make:controller <Name>
bunx guren make:view <names>/Index
bunx guren make:view <names>/Show
bunx guren make:view <names>/New
bunx guren make:view <names>/Edit
bunx guren make:route <names>
bunx guren make:test controllers/<Name>Controller   # the runner is detected from the project
bunx guren make:factory <Name> --model=<Name>
bunx guren make:seeder <Name>
bunx guren make:resource <Name> --model=<Name>
bunx guren make:validator <Name> --fields "<name:type,...>"
```

Don't hand-write the Validator — `make:validator` emits the same file `make:feature` does, so the schema names stay in sync with what the generated controller imports. Pass the same `--fields` you would pass `make:feature`; omit it to get an empty payload schema to fill in.

The Validator is needed for both controller validation and route body schema binding.

### 2. Add the table

Add the table to `db/schema.ts` (see Schema Example below). `make:feature` says
so in its next steps, or reports that the schema already declares it.

### 3. Register the routes

`make:feature` prints the block to add to `routes/web.ts` (the module's routes
file with `--module`). Paste it as printed: the mutating routes carry their Zod
`body` schema, which is what codegen types the forms from, and the `auth`
middleware unless the feature is `--public`.

```typescript
import <Name>Controller from '../app/Http/Controllers/<Name>Controller.js'
import { <Name>PayloadSchema } from '../app/Http/Validators/<Name>Validator.js'

const authRouter = router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
authRouter.group('/<names>', (<names>) => {
  <names>.get('/', [<Name>Controller, 'index']).name('<names>.index')
  <names>.get('/create', [<Name>Controller, 'create']).name('<names>.create')
  <names>.get('/:id', [<Name>Controller, 'show']).name('<names>.show')
  <names>.get('/:id/edit', [<Name>Controller, 'edit']).name('<names>.edit')
  <names>.post('/', { name: '<names>.store', body: <Name>PayloadSchema }, [<Name>Controller, 'store']).middleware('auth')
  <names>.put('/:id', { name: '<names>.update', body: <Name>PayloadSchema }, [<Name>Controller, 'update']).middleware('auth')
  <names>.delete('/:id', { name: '<names>.destroy' }, [<Name>Controller, 'destroy']).middleware('auth')
})
```

Where `<Name>` is PascalCase singular (e.g., `Post`) and `<names>` is kebab-case plural (e.g., `posts`).

### 4. Migrate and run codegen

```bash
bun run db:make && bun run db:migrate   # drizzle-kit writes the migration from db/schema.ts
bunx guren codegen                      # typed route helpers and API client types in .guren/
```

With `--policy`, also register the policy in a provider's `boot()`, as the
command prints; an unregistered policy denies every request.

## Type Safety Patterns

Generated views follow these patterns for end-to-end type safety:

### Form pages (New/Edit) — derive types from ApiRoutes

```typescript
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

type <Name>FormData = RouteBody<ApiRoutes, '<names>.store'>

// Form submission uses route() helper
form.post(route('<names>.store'))
form.put(route('<names>.update', { id: <name>.id }))
```

### List/Detail pages — typed props from Resource

```typescript
import type { PaginatedPageProps } from '@guren/core'
import type { <Name>ResourceData } from '@/app/Http/Resources/<Name>Resource'
import { route } from '@/.guren/routes.gen'

interface Props extends PaginatedPageProps<<Name>ResourceData> {}

// Navigation uses route() helper
<Link href={route('<names>.show', { id: <name>.id })}>
```

### Validation errors — read from `form.errors`

A failed `validated()` or `validateBody()` redirects back with the errors flashed into the shared `errors` prop, and `useForm` exposes them as `form.errors`. Each field renders its own message and points its control at it:

```tsx
<input id={fieldIds.title} /* … */ aria-invalid={form.errors.title ? true : undefined} aria-describedby={form.errors.title ? `${fieldIds.title}-error` : undefined} />
{form.errors.title && <p id={`${fieldIds.title}-error`} className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
```

Do not pass `errors` from the `edit()` or `create()` action: page props override shared ones, so an `errors: {}` there erases the flashed errors before the page sees them.

### Models — define fillable for mass assignment protection

Always add `fillable` to generated models. This is the second defense layer after Zod validation — it prevents unintended fields from reaching the database even if the controller validation is bypassed or misconfigured:

```typescript
export class <Name> extends defineModel(<names>, {
  fillable: ['title', 'body'],  // only these fields pass to create()/update()
}) {}
```

Prefer the `defineModel` option over `static fillable = [...]` — the option is typed against the table's columns, so a typo is a compile error (a `static` declaration still works and shadows the option).

List only the columns a request may set. A column the server chooses (the owner `authorId`, a parent `postId`) stays out of `fillable` and is written with `set`, beside the validated data:

```typescript
const data = await this.validateBody(<Name>PayloadSchema)
const user = await this.auth.userOrFail<UserRecord>()
const post = await <Name>.create(data, { set: { authorId: user.id } })
```

Never use `forceCreate()` / `forceUpdate()` to add an owner to request data, and never spread request input into `set`.

For User models, credential columns (`passwordHash`, `rememberToken`) are denied from
mass assignment by `AuthenticatableModel` itself — never list them in `fillable`:

```typescript
export class User extends defineModel(users, {
  base: AuthenticatableModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  fillable: ['name', 'email', 'password'],
}) {}
```

## Generated Structure

For feature "Post":

```
app/
├── Http/Controllers/PostController.ts
├── Http/Resources/PostResource.ts
├── Http/Validators/PostValidator.ts
├── Models/Post.ts
└── Policies/PostPolicy.ts                 ← with --policy
db/
├── factories/PostFactory.ts               ← with --factory
└── migrations/<folder>/migration.sql      ← written by `bun run db:make`, not by make:feature
resources/js/pages/posts/
├── Index.tsx    ← typed props, route() links
├── Show.tsx     ← typed props, route() links
├── New.tsx      ← ApiRoutes form type, form.errors per field, route() submit
└── Edit.tsx     ← ApiRoutes form type, form.errors per field, route() submit
tests/controllers/PostController.test.ts   ← with --test
```

## Schema Example

```typescript
// db/schema.ts
export const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  content: text('content'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})
```

On PostgreSQL, always give timestamp columns `{ withTimezone: true }`. A
`timestamp without time zone` stores a bare wall clock, so `defaultNow()`
records it in the database session's zone while the app reads it back as UTC,
and any client other than the app sees a different instant.
