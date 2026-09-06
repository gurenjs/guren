# Guren Framework

## Overview
Guren is a Laravel-inspired fullstack TypeScript framework running on Bun. It combines Hono for HTTP handling, Drizzle ORM for database operations, and Inertia.js for seamless frontend integration.

**Status:** Stable (v1.0). Breaking changes only in major releases.

## Monorepo Structure

```
packages/
├── core/           # Framework entry point, aggregates other packages
├── server/         # HTTP server (Hono), routing, controllers, middleware, auth
├── orm/            # ORM abstraction with Drizzle adapter, Model API
├── cli/            # CLI commands (make:*, db:*, routes:types, AI agent commands)
├── testing/        # Testing utilities for controllers and HTTP
├── create-app/     # Project scaffolding tool
└── inertia-client/ # Frontend React + Inertia.js integration

examples/
└── blog/           # Reference application

web/                # Documentation site
```

## Development Commands

```bash
# Build all packages (required after code changes)
bun run build

# Run tests
bun run test:bun      # Framework unit tests (packages auto-discovered)
bun run test:bun:list # Print which packages test:bun covers
bun run test:bun cli  # Narrow to one or more packages
bun run test:examples # Example app tests
bun run test          # Full test suite

# Type checking
bun run typecheck

# Lint (oxlint, type-aware; the oxlint binary is a Node shim, so Node must be on PATH)
bun run lint
bun run lint:fix      # apply the safe auto-fixes, then re-lint

# Development server (blog example)
bun run dev

# Database
bun run db:up         # Start PostgreSQL container
bun run db:up:mysql   # Start MySQL container (the ORM's MySQL integration test
                      # skips unless MYSQL_URL is set)
bun run db:down       # Stop containers
bun run db:migrate    # Run migrations
bun run db:seed       # Run seeders
```

## Build Order & Troubleshooting

`bun run build` runs `scripts/build-packages.ts`, which discovers every package
under `packages/` that has a `build` script, topologically sorts them by their
`dependencies`/`peerDependencies`, and builds them in dependency order —
independent packages run in parallel (`--sequential` opts out). **New packages
(plugins included) need no script wiring** — they are picked up automatically.

```bash
bun run build:list    # print the resolved order without building
```

Discovery and the topological sort live in `scripts/workspace-packages.ts`, shared
with `scripts/test-packages.ts` (which backs `test:bun`). The one manual knob there
is `ignoredEdges`: `@guren/cli` and `@guren/core` depend on each other, so core's
edge on cli is dropped to break the cycle. Any *other* cycle fails the build with
an explicit error.

The same module also answers "what version did this manifest declare at a git
rev" (`manifestAtRev` / `versionOf`), which is how the release gates in
`scripts/` tell a version that moved from one that did not. `versionOf` carries
the rule that an unreadable manifest is *not* a version — a gate that lets one
stand in for a number silently stops gating.

**Stale `.d.ts` issue:** If DTS build fails (e.g., `@guren/core` cannot find `@guren/server` types), old `dist/` artifacts are likely interfering. Run:
```bash
bun run build:clean   # remove each package's dist/ then build
```

**Rule:** Always use `bun run build:clean` instead of `bun run build` when:
- Building after switching branches
- Building after pulling large changes
- DTS build fails with "could not find declaration file" errors

## Package-Specific Builds

```bash
bun run build server   # Build @guren/server only
bun run build cli orm  # Build a subset, still in dependency order
```

Named shortcuts (`bun run build:server`, `build:orm`, `build:cli`, …) remain for
the long-standing packages.

## AI Agent Commands

Commands designed for AI coding agents to understand, validate, and generate code:

```bash
# Project introspection
bunx guren context              # Project context map (markdown)
bunx guren context --json       # Project context map (JSON)
bunx guren context User         # Entity-centric bundle: model, routes, pages, resource, policy, linked docs (--module to disambiguate, "app" = root)
bunx guren docs:graph           # OKF docs relation graph (--entity/--path narrows; --json for agents)
bunx guren model:list           # List models with relationships
bunx guren model:list --format json  # Models as JSON
bunx guren tool:list            # Agent tools this app exposes (RFC 0016); --json for the raw derivation
bunx guren tool:inspect posts.store  # One tool's full derivation: input, output, authorization, annotations

# Integrity checking
bunx guren check                # Validate route↔controller↔page consistency, console command registration, route registrar wiring (every routes/*.ts reached from the registrar that would mount it — the entry registrar for the project's, the registrar defineModule({ routes }) names for modules/*/routes/), route paths using `:name*` (not a Hono wildcard — it registers a parameter named literally `name*`), route contracts (`params` schema keys and `bind` keys against the parameters their path declares), agent routes (`.agent()` metadata: a route with no name, an illegal or duplicated tool name, a non-read-only tool with authentication but no authorization; warns on missing output/body schemas, an Inertia response, a read-only tool whose action mutates — declared or GET/QUERY-default — and any verdict blocked by a handler body it does not read), Postgres timestamp time zones, configureAttachments() table bindings, Attachable models in apps with no configureAttachments(), attachments delivery wiring (delivery configured but registerAttachmentRoutes() unmounted; serve: 'redirect' on a disk whose driver cannot presign), session wiring (a `database` store bound to a table the schema does not export; a `SessionConfig` no provider binds), architecture boundaries, doc links, and the deploy-runtime verdicts (in-memory session/OAuth/cache stores, a Bun-only `ScryptHasher`, filesystem provider discovery: the same three `guren doctor` reports, for an app that declares a deploy plugin or the Lambda adapter; advisory, so `--ci` and `guren gate` never fail on them) (informational; only --arch/--docs/--spec set the exit code)
bunx guren check --json         # Check results as JSON
bunx guren check --arch         # Architecture boundary checks only (guren.arch.ts) — fast path for edit hooks
bunx guren check --docs         # Doc-link checks only: OKF frontmatter (type/entities/related) + body markdown links + @docs tags (exits non-zero on failures)
bunx guren check --spec         # Spec drift checks only: docs/spec/ vs regenerated views (exits non-zero on failures)
bunx guren check --i18n         # Translation catalog checks only: lang/<locale> key parity + interpolation placeholders (exits non-zero on failures)
bunx guren spec:generate        # Generate spec views (er/domain/screens/modules) into docs/spec/ — deterministic, committed, drift-gated
bunx guren check --changed      # Restrict file-scanning checks to files changed vs. the merge base with main
bunx guren audit                # Security audit: validation/auth on mutating routes, raw SQL, secrets, mass assignment, CSRF exemptions (app source, plus a scan of installed Guren-facing packages — the only surface that sees a plugin's); agent-exposed routes (RFC 0016) get the stricter treatment — an unverifiable body-validation warn becomes a fail, and destructiveHint: false on an action that deletes, updates, or force-writes warns
bunx guren audit --json         # Audit results as JSON (exits non-zero on failures)
bunx guren doctor --next        # Doctor report + actionable next steps

# Agent harness (in scaffolded apps)
bunx guren agent:init           # Install AI agent harness (CLAUDE.md, .claude/ rules, skills, hooks, .mcp.json)
bunx guren agent:sync           # Refresh framework-managed harness files to the latest version (lists replaced files, skips up-to-date ones)
bunx guren agent:sync --dry-run # Report what a sync would write, replace, or prune without changing any file
bunx guren agent:sync --prune   # Also delete managed-directory files that left the harness (reported-only by default)

# Code generation
bunx guren guidelines           # Auto-generate project-specific coding guidelines
bunx guren guidelines -o .claude/rules/project-guidelines.md  # Write to file
bunx guren make:feature Post --fields "title:string,body:text,published:boolean"  # CRUD scaffold (store/update require auth by default)
bunx guren make:feature Post --fields "title:string,body:text" --test  # With test file
bunx guren make:feature Post --fields "title:string" --public  # Skip auth checks in mutating actions
bunx guren make:feature Post --fields "title:string" --policy  # Also generate a policy and enforce it in store/update
bunx guren make:feature Post --fields "title:string" --attach "cover:one,images:many"  # Attachable model + attach-aware store/destroy (requires `guren add attachments` first; RFC 0013 Part 4)
bunx guren make:policy Post     # Authorization policy scaffold (app/Policies)
bunx guren make:validator Post --fields "title:string,body:text"  # Zod schemas (route params, list query, payload) in app/Http/Validators
bunx guren make:adr "Billing cycle is end-of-month"  # Numbered ADR under docs/adr with linkable frontmatter (entities/related)

# Application modules (RFC 0002) — self-contained modules/<name>/ directories
bunx guren make:module Billing              # Scaffold modules/billing/{index.ts,routes.ts,db/schema.ts}, wire into src/app.ts
bunx guren add session                      # Database-backed sessions: schema table + migration, config/session.ts, SessionProvider, sessions:prune (RFC 0020; `guren add auth` runs it)
bunx guren make:controller Invoice --module billing  # Most make:* commands accept --module to scaffold inside a module instead of the project root
```

## Coding Conventions

### TypeScript
- **Strict mode** enabled (`strict: true`)
- **ES2022** target with ESNext modules
- **Bundler** module resolution
- Use **Bun native APIs** where applicable
- **No CommonJS** - ESM only

### File Organization
- Test files: `*.test.ts` alongside source files
- Index exports: Each package has `src/index.ts` as main entry
- Type declarations: Generated via tsdown build (`@guren/server` emits them with `tsc -p tsconfig.build.json`)

### Naming
- **Classes:** PascalCase (e.g., `UserController`, `PostModel`)
- **Files:** kebab-case for utilities, PascalCase for classes
- **Variables/functions:** camelCase
- **Constants:** UPPER_SNAKE_CASE for true constants

### Comments
- Code shows *how*; a comment carries only what the code cannot: a constraint, a pitfall, a unit, a cross-file sync obligation, a measured number, an RFC/issue reference. No narration of the next line, no section banners, no change history
- The full rule and the size limits live in `.claude/rules/coding-standards.md` (Comments); the `guren/comment-*` oxlint rules (`bun run lint`, and the PostToolUse hook after every edit) enforce the mechanical half

### Imports
```typescript
// Use package aliases
import { Controller } from '@guren/server'
import { Model } from '@guren/orm'

// Relative imports within same package
import { helper } from './utils'

// In application code (templates, examples, scaffolds), `@/` resolves
// from the project root (tsconfig paths + Guren Vite plugin alias)
import { pages } from '@/.guren/pages.gen'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
```

## Architecture Patterns

### Controllers
```typescript
import { Controller } from '@guren/core'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'

const CreatePostSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
})

const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export class PostController extends Controller {
  async index() {
    const posts = await Post.all()
    return this.inertia(pages.posts.Index, { posts })
  }

  async show() {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)  // throws 404 automatically
    return this.inertia(pages.posts.Show, { post })
  }

  async store() {
    const data = await this.validateBody(CreatePostSchema)  // throws 422 on failure
    const user = await this.auth.userOrFail<UserRecord>()  // throws 401 if unauthenticated
    const post = await Post.create({ ...data, authorId: user.id })
    return this.redirect('/posts')
  }
}
```

**Controller validation helpers** (accepts any Zod-like schema with `safeParse`):
- `this.validateBody(schema)` — parse request body, throw `ValidationException` (422) on failure
- `this.validateQuery(schema)` — parse query parameters
- `this.validateParams(schema)` — parse route parameters

### Models
```typescript
import { defineModel } from '@guren/orm'
import { posts } from '@/db/schema'

export class Post extends defineModel(posts) {
  // Relationships, scopes, etc.
}

// Usage
const post = await Post.find(1)          // returns null if not found
const post = await Post.findOrFail(1)    // throws ModelNotFoundException (404)
const all = await Post.where('published', true).get()
```

### Routes
```typescript
import { Router, requireAuthenticated } from '@guren/core'

export function registerWebRoutes(baseRouter: Router): void {
  // aliasMiddleware() returns a Router carrying the alias name in its type —
  // capture it, or a later .middleware('auth') will not compile.
  const router = baseRouter.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))

  router.get('/posts', [PostController, 'index'])
  router.post('/posts', [PostController, 'store'])

  router.middleware('auth').group((auth) => {
    auth.get('/dashboard', [DashboardController, 'index'])
  })
}
```

### Middleware
```typescript
import { defineMiddleware } from '@guren/core'

export const requireAuth = defineMiddleware(async (c, next) => {
  if (!c.get('user')) {
    return c.redirect('/login')
  }
  await next()
})
```

### Application Bootstrap
1. Export a route registrar from `routes/web.ts`
2. Create the app with `createApp({ routes, providers })`
3. Call `app.boot()` then `app.listen()`

### Database Configuration
- PostgreSQL via Docker Compose (service: `postgres`)
- Port: `54322` (non-standard to avoid conflicts)
- Credentials: `guren/guren/guren` (user/pass/db)
- Connection string: `postgres://guren:guren@localhost:54322/guren`

**Database workflow:**
1. Schema defined in `db/schema.ts` using Drizzle
2. `config/database.ts` calls `createPostgresDatabase` to expose `configureOrm`, migration, and seeding helpers
3. ORM configured via `DatabaseProvider` (internally calls `bootModels()` to run `configureOrm`/`seedDatabase` once)
4. Models reference schema tables via static `table` property

### End-to-End Type Safety
- `bunx guren codegen` generates four artifacts in `.guren/`: `pages.gen.ts`, `routes.gen.ts`, `data.gen.ts`, `api-client.gen.ts` (plus `agents.gen.ts` for apps whose routes declare `.agent()`)
- **Route Schema Binding**: Attach Zod schemas to routes via `RouteContractOptions` (`body`, `params`, `query`); codegen extracts schema types and generates typed `body` fields in `ApiRoutes`
- **Route Model Binding**: `bind: { id: Post }` in route options + `this.model(Post)` in controllers for typed, auto-resolved model instances
- **Page Props**: Define `interface Props` in page components; codegen extracts them via Babel AST into `PagePropsMap` for compile-time validation in `this.inertia()`
- **Data Types**: `JsonResource` subclasses with typed `toArray()` are exported as `Data.Post`, `Data.User`, etc.
- **API Client**: `createApiClient<ApiRoutes>()` provides typed `request()` with route name autocomplete, param checking, and body types
- **Bidirectional Forms**: `RouteBody<ApiRoutes, 'posts.store'>` and `RouteErrors<PostForm>` from `@guren/inertia-client/typed-forms`
- **Typed Components**: `createTypedLink(routeManifest)` and `createTypedForm(routeManifest)` provide `<Link route="posts.show" params={{ id: 1 }}>` with compile-time route name and param checking
- **Vite HMR**: The Vite plugin watches `routes/web.ts`, `resources/js/pages/`, and `app/Http/Resources/` — changes trigger automatic codegen

## Testing

### Framework Tests
Uses Bun's native test runner:
```typescript
import { describe, test, expect } from 'bun:test'

describe('Feature', () => {
  test('should work', () => {
    expect(true).toBe(true)
  })
})
```

### Controller Tests
```typescript
import { TestApp } from '@guren/testing'

test('index returns posts', async () => {
  const app = await TestApp.create()
  await app.get('/posts').assertOk()
})
```

## Commit Convention

Follow [Conventional Commits](https://conventionalcommits.org):

```
<type>(<scope>): <summary>

<body>

<footer>
```

**Types:** `feat`, `fix`, `docs`, `test`, `refactor`, `build`, `ci`, `perf`, `chore`

**Scopes:** `server`, `orm`, `cli`, `testing`, `core`, `docs`

**Examples:**
```
feat(server): add rate limiting middleware
fix(orm): handle null values in where clause
docs: update authentication guide
```

## Serverless (AWS Lambda)

Guren supports AWS Lambda deployment via `@guren/server/lambda`:

```typescript
// lambda.ts
import app from './src/app'
import { createLambdaHandler } from '@guren/server/lambda'

await app.boot()
export const handler = createLambdaHandler(app)
```

**Key points:**
- `app.boot()` runs once at cold start; the handler reuses the booted app
- `Hash` (`DefaultHasher`) is the default hasher and already falls back to `node:crypto` scrypt off Bun; reach for `NodeHasher` explicitly only to pin the format. Never construct `ScryptHasher` in code a Node runtime will run
- Static assets should be served via CloudFront/S3, not Lambda
- Use Redis-backed session/cache/queue stores (not in-memory)
- List providers explicitly in `createApp()` (auto-discovery requires Bun)

## Key Files

| Path | Purpose |
|------|---------|
| `packages/server/src/http/Application.ts` | Main server class |
| `packages/cli/src/add-session.ts` | The `guren add session` blueprint (RFC 0020 §2): the per-dialect `sessions` table, `config/session.ts` + `SessionProvider`, the `SESSION_DRIVER` env entry, and `sessions:prune`. `make:auth` runs it before generating its migration, so one drizzle-kit run covers users and sessions — which is why `addSession({ migration: false })` exists |
| `packages/core/src/session-manager.ts` | `createSessionManager()` and the `database` session driver (RFC 0020 §1). The one place `SessionDrivers` gains `database`: the store wraps a drizzle table in an ORM `Model`, which `@guren/server` cannot do. Registered by a factory call rather than a module side effect, so a bundler dropping an unused import cannot drop the driver; `packages/core/tests/session-manager.test.ts` pins the augmentation surviving into the bundled `.d.ts`, which nothing else would notice losing |
| `packages/server/src/http/middleware/session-manager.ts` | `SessionManager` and the augmentable `SessionDrivers` registry (RFC 0020 §1): named stores, one default, lazy memoized resolution so a plugin's `registerDriver()` and a Workers binding may both arrive after construction. Bound under the container key `session`; `AuthServiceProvider` builds the session middleware on the first request from `manager.options` + `auth.sessionOptions`, and fails the boot when both name a store. Server ships `memory` and `redis`; `database` is core's to add, since server must not depend on the ORM |
| `packages/server/src/mvc/Controller.ts` | Base controller (validateBody/Query/Params) |
| `packages/server/src/mvc/Router.ts` | Instance-based route registry |
| `packages/server/src/errors/ExceptionHandler.ts` | Exception handler (duck-type statusCode) |
| `packages/orm/src/Model.ts` | Base model class (findOrFail) |
| `packages/orm/src/ModelNotFoundException.ts` | 404 exception for models |
| `packages/server/src/lambda/index.ts` | AWS Lambda adapter |
| `packages/server/src/auth/password/NodeHasher.ts` | Node.js-compatible password hasher |
| `packages/cli/src/bin.ts` | CLI entry point |
| `packages/cli/src/context.ts` | AI agent: project context map generation |
| `packages/cli/src/entity-context.ts` | AI agent: entity-centric context bundles (`guren context <Entity>`, RFC 0004) |
| `packages/cli/src/docs-index.ts` | AI agent: docs/ scanning (DocRef, entity index, `@docs` tags); facade over the parsers below |
| `packages/cli/src/docs-frontmatter.ts` | AI agent: the YAML-subset frontmatter parser (OKF fields) |
| `packages/cli/src/docs-links.ts` | AI agent: markdown link scanning shared by check, graph, and renderer |
| `packages/cli/src/docs-check.ts` | AI agent: doc-link validation (`guren check --docs`) |
| `packages/cli/src/i18n-types.ts` | AI agent: typed translation keys (`.guren/translations.gen.ts` from `lang/`) |
| `packages/cli/src/i18n-check.ts` | AI agent: translation catalog checks (`guren check --i18n`) |
| `packages/cli/src/make-adr.ts` | AI agent: numbered ADR scaffolding (`make:adr`) |
| `packages/cli/src/spec-generate.ts` | AI agent: spec view orchestration (`spec:generate`, RFC 0004) |
| `packages/cli/src/spec-check.ts` | AI agent: spec drift gate (`guren check --spec`) |
| `packages/cli/src/schema-parser.ts` | Shared Drizzle schema AST parser (tables, columns, FKs, dialect, column options) |
| `packages/cli/src/inflect.ts` | The one pluralization rule: collection, route slug, schema identifier, and table name for an entity. Every scaffolder and `guren check` derive names through it — a second rule is how the model's import and the schema's export drift apart |
| `packages/cli/src/drizzle-pins.ts` | The one rule keeping `drizzle-orm`/`drizzle-kit` on the copy `@guren/orm` installs. `guren upgrade` applies it to an installed app, `scripts/sync-template-deps.ts` to the scaffold templates — a second rule is how a scaffolded app ends up with two ORM copies in one process |
| `packages/cli/src/route-registrar.ts` | The one rule for what counts as an app's route registrar, and the patch that wires a scaffolded routes file into it. `load-routes.ts` resolves the same export names at runtime — a scaffolder that picked its own target patches a function the framework never calls, and the routes look wired while mounting nothing |
| `packages/cli/src/app-surface.ts` | The one rule for "this app cannot render an Inertia page". Scaffolders that emit a page component or wire into `routes/web.ts` refuse an API-only app through it. Positive evidence only — a scaffolder that guesses blocks commands that would have worked |
| `packages/cli/src/check.ts` | AI agent: integrity checking |
| `packages/cli/src/console-check.ts` | AI agent: console command registration checks (part of `guren check`) |
| `packages/cli/src/route-path-check.ts` | AI agent: route path checks — a `:name*` parameter, which reads as a Hono wildcard but registers a single-segment parameter named literally `name*` (part of `guren check`) |
| `packages/cli/src/routes-check.ts` | AI agent: route registrar wiring checks — a `routes/*.ts` its mounting registrar never calls, per scope: the app's entry for the project's `routes/`, the registrar `defineModule({ routes })` names for `modules/<name>/routes/` (part of `guren check`) |
| `packages/cli/src/route-contract-check.ts` | AI agent: route contract checks — a `params` schema key or `bind` key naming a parameter its path never declares. Reads *registered* definitions rather than the routes file's AST: the path a route registers is the joined one (group prefixes, `resource()` expansions), and a params schema is usually imported from elsewhere (part of `guren check`) |
| `packages/cli/src/agent-route-check.ts` | AI agent: agent-route checks — the wiring rules for routes declaring `.agent()` metadata (RFC 0016): the tool name is legal and unique, a non-read-only tool is covered by *authorization* rather than merely authentication, and the schemas an agent reads exist. Reads registered definitions like route-contract-check, and is content-activated: an app with no agent routes contributes nothing and never scans a controller (part of `guren check`) |
| `packages/cli/src/controller-methods.ts` | The one controller-action body scan *and* the vocabulary for judging what it returns (`CONTROLLER_MEMBER_KINDS`, the `this.<member>(` patterns), shared by `guren audit` and the agent-route checks. Comments and string contents are blanked before any regex runs; same-named controller classes are *reported* rather than resolved — a route carries a class name, not a file, so a body attributed to the wrong file can flip a verdict. Patterns naming a `Controller` member are spelled through `ControllerMemberName`, which is what puts them inside `controller-surface.test.ts`'s reach: a pattern defined outside it goes stale on a rename with nothing failing. It is also the one rule for *which members of a controller class are actions* (`classActionMembers`) — `Router` dispatches to `store = async () => {}` exactly as to `async store() {}`, and a scanner spelling its own `member.type === 'ClassMethod'` test silently reports every class-field action as absent rather than as unverified. `guren check`, `guren doctor`, `guren context`, `spec:generate`, and this scan all read it |
| `packages/cli/src/http-methods.ts` | The one HTTP-method classification (`describeMethod`): which verbs are safe, which carry a body. Shared by `guren audit`'s two per-route phases and the agent-route input rule — a second list is how a verb ends up body-carrying in one command and not the other |
| `packages/cli/src/deploy-runtime.ts` | The one deploy-runtime scan *and* its three verdicts (`judgeDeployRuntime`, `checkDeployRuntime`): in-memory stores, a Bun-only hasher, filesystem provider discovery on Workers/Lambda/Vercel. `guren doctor` maps them onto its checks, `guren check` onto advisory results, and the three deploy builds print them through `@guren/core/internal/deploy-check` (RFC 0020 Part 0), so one app cannot get three different answers. The scan reads *constructions* (`new DatabaseSessionStore(...)`) plus a `SessionConfig`-annotated object's selected `driver:` — that annotation is the anchor, since a cache config keys `stores` the same way. It never reads intent: a custom `SessionStore` passed as `store:`, or a `SESSION_DRIVER` the environment overrides, reads as unbacked, which is why the check result is advisory |
| `packages/cli/src/schema-check.ts` | AI agent: Postgres `timestamptz` schema checks (part of `guren check`) |
| `packages/cli/src/session-config.ts` | The one rule for reading a `SessionConfig` out of source (RFC 0020): which declarators are session configs (annotation *or* `satisfies`), what `default` selects (through `??`/`||`), and each store's `driver`. `guren check`'s session rules and the deploy-runtime verdicts both read it — a second reading is how one reports a backed store while the other skips the table it binds. The anchor is the *type*, never the file name: a cache config keys `default`, `stores` and `driver` identically, and `createSessionManager(config)` carries no literal since the scaffold passes the config by name across modules. `DEFAULT_SESSION_STORE_NAME` and `PER_PROCESS_SESSION_DRIVERS` come from the runtime rather than being restated here |
| `packages/cli/src/schema-binding.ts` | The one rule for "does this identifier name a table the app's schema exports": the `db/schema` specifier shapes, which schema module an import lands on (a module config must not pass on a table the root declares), and the import map. Shared by `configureAttachments()`'s table check and the session store's `database` driver |
| `packages/cli/src/sessions-check.ts` | AI agent: session wiring checks (RFC 0020 §2) — a `database` store bound to a table the schema does not export, and a `SessionConfig` whose binding provider `createApp()` does not register (the config is then never read and sessions stay in process memory — the file existing is not the question). Content-activated: an app with no session config contributes nothing |
| `packages/cli/src/attachments-check.ts` | AI agent: attachments wiring checks — a `configureAttachments()` binding a table the schema does not export, an `Attachable(...)` model in an app with no `configureAttachments()` at all, and the RFC 0015 delivery rules (`delivery` configured with no `registerAttachmentRoutes()` route in the loaded definitions; `serve: 'redirect'` on a non-presigning driver); all otherwise only fail at runtime (part of `guren check`) |
| `packages/cli/src/attachments-types.ts` | AI agent: cross-boundary attachment maps (`.guren/attachments.gen.ts` from `Attachable(...)` declarations, RFC 0013) |
| `packages/server/src/agent/derive.ts` | The one derivation of agent tools from route contracts (`deriveAgentTools`, RFC 0016). Runtime adapters and codegen both call it, so a generated manifest and a live server cannot advertise different schemas. Total by contract: a collision or an unnamed agent route is a warning plus a deterministic result, never a throw |
| `packages/cli/src/agents-types.ts` | AI agent: the agent tool manifest (`.guren/agents.gen.ts`) plus the codegen-only enrichment a `resource` hint needs — `definitions()` carries class names, the payload type behind them exists only in the CLI's AST extraction |
| `packages/cli/src/tool-list.ts` | AI agent: `tool:list` / `tool:inspect`, derived live from the route graph rather than read from the manifest |
| `packages/cli/src/arch-check.ts` | AI agent: architecture boundary checking (`guren.arch.ts`, see RFC 0002) |
| `packages/cli/src/arch/index.ts` | `defineArchRules()` + types, published as the `@guren/cli/arch` subpath |
| `packages/cli/src/changed-files.ts` | Git-diff-based file filtering shared by `check --changed` |
| `packages/cli/src/audit.ts` | AI agent: security audit (validation, auth, raw SQL, secrets) |
| `packages/cli/src/csrf-exemption-audit.ts` | AI agent: who exempts a path from CSRF verification. `declareCookielessAuthPath()` is public on `Application`, so an installed package can call it from `node_modules` — where the source scan never looks and no CLI command can see it, because nothing in the CLI boots an app. So this reads the JS each Guren-facing dependency ships. It names packages, never paths: the path is an argument computed at boot. A package it cannot read is `partial` coverage and its own warning — reporting "no exemptions" for a directory that would not open is the one answer worse than none (part of `guren audit`) |
| `packages/cli/src/oxlint/await-async-assertion.js` | The lint rule for a bare `expect(...).rejects` / `.resolves` statement, an assertion that can never fail its test. `typescript/no-floating-promises` cannot see it on a `bun:test` file (bun-types declares the chain as returning `void`) and oxlint's jest plugin does not recognise `expect` imported from `bun:test`, so this syntactic, import-agnostic rule closes the gap. `.oxlintrc.json` wires it; the header has the details |
| `packages/cli/src/guidelines.ts` | AI agent: dynamic guidelines generation |
| `packages/cli/src/model-list.ts` | AI agent: model introspection |
| `packages/cli/src/model-parser.ts` | AI agent: Babel AST model parsing |
| `packages/cli/src/make-feature.ts` | AI agent: CRUD feature scaffolding |
| `packages/cli/src/scaffold-templates.ts` | Loader for static scaffold templates shipped as real sources under `packages/cli/templates/scaffold/` (typechecked by `typecheck:templates`); flag-dependent output stays in `build*Template()` functions, and `tests/scaffold-output.test.ts` parse-gates both |
| `packages/cli/src/make-module.ts` | AI agent: application module scaffolding (`make:module`, see RFC 0002) |
| `packages/cli/src/discovery.ts` | AI agent: shared file discovery utilities (module-aware — scans `modules/*/` too) |
| `packages/server/src/container/defineModule.ts` | `defineModule()` + `GurenModule` type, auto-exported via `@guren/core` |
| `packages/cli/src/agent-harness.ts` | AI agent: harness installer (`agent:init` / `agent:sync`) |
| `packages/cli/templates/agent/` | AI agent: harness template (CLAUDE.md, .claude/ rules, skills, hooks) |
| `examples/blog/` | Reference implementation |

## Before Opening PRs

1. Run `bun run build` - ensure all packages compile
2. Run `bun run typecheck` - no type errors
3. Run `bun run lint` - oxlint with the type-aware rules; warnings fail too
4. Run `bun run test` - all tests pass
5. Run `bun run audit:core-first` - no `@guren/server` references in docs/templates
6. Run `bun run audit:docs` - docs reference valid commands and APIs
7. **If you touched `packages/create-app/templates/**` or `packages/cli/templates/**`:**
   also run `bun run audit:starter-template` and `bun run smoke:starter` /
   `smoke:starter:api`. The audits assert scaffold contents literally, so a
   change that reads as harmless (an added env var in a `dev` script) fails CI
   while `build`/`typecheck`/`test` stay green. The smokes scaffold a real app
   and take several minutes — judge them by exit code, not by wall time.
8. **If a template started using a framework API added in the same PR:** run
   `bun run smoke:starter:npm` — it installs `@guren/*` from the registry, and
   is expected to be red until the release ships that API.
9. Review `.claude/rules/common-pitfalls.md` - check for known gotchas
10. Follow commit message convention

## Claude Code Agents

Specialized subagents that run in isolated context for complex tasks:

| Agent | Trigger Words | Purpose |
|-------|---------------|---------|
| `code-review` | "review", "check my code" | Review code changes for quality, patterns, security |
| `test-writer` | "write tests", "add tests" | Generate comprehensive tests for existing code |

## Claude Code Skills

Available AI-powered skills that Claude can use automatically:

| Skill | Trigger Words | Purpose |
|-------|---------------|---------|
| `dev-workflow` | "build", "test", "typecheck", "pr check", "e2e", "dev server" | Build, test (smart/full), type check, pre-PR validation, E2E tests, dev server |
| `rfc-authoring` | "write an RFC", "propose a breaking change" | Draft an RFC per `contributing/rfc-process.md` |

Only these two. The application-facing skills (`guren-api`, `scaffold`,
`feature`, `db-manage`, `plugin-authoring`) live in the harness template under
`packages/cli/templates/agent/core/skills/` and ship to scaffolded apps, where
`bunx guren` resolves and framework sources do not. For framework API questions
here, read `docs/en/guides/` and `packages/*/src` directly.
