# Guren Framework

## Overview
Guren is a Laravel-inspired fullstack TypeScript framework running on Bun. It combines Hono for HTTP handling, Drizzle ORM for database operations, and Inertia.js for seamless frontend integration.

**Status:** Stable (v2). Breaking changes only in major releases.

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
with `scripts/test-packages.ts` (which backs `test:bun`). Runtime dependencies
and required peers determine build order. Optional plugin
peers are loaded on demand and do not impose build order. The CLI reads shared
contracts from the server package; core supplies the public facade and CLI bin.
Any dependency cycle fails the build with an explicit error.

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
bunx guren context              # Project context map (markdown); routes from the introspected app, `--no-introspect` for the routes file
bunx guren context --json       # Project context map (JSON)
bunx guren context User         # Entity-centric bundle: model, routes, pages, resource, policy, linked docs (--module to disambiguate, "app" = root)
bunx guren docs:graph           # OKF docs relation graph (--entity/--path narrows; --json for agents)
bunx guren model:list           # List models with relationships
bunx guren model:list --format json  # Models as JSON
bunx guren tool:list            # Agent tools this app exposes (RFC 0016); --json for the raw derivation
bunx guren tool:inspect posts.store  # One tool's full derivation: input, output, authorization, annotations
bunx guren introspect --json    # Manifest of the registered, unbooted app (RFC 0026): providers and how each registered, routes with resolved middleware and controller files, session/auth/cache/storage/queue/attachments; runs register() and the route registrars in a GUREN_INTROSPECT=1 child (routes are never mounted), never boot() or listen() (--timeout <s>, --app <dir>)

# Integrity checking
bunx guren check                # Validate route↔controller↔page consistency, console command registration, route registrar wiring (every routes/*.ts reached from the registrar that would mount it — the entry registrar for the project's, the registrar defineModule({ routes }) names for modules/*/routes/), route paths using `:name*` (not a Hono wildcard — it registers a parameter named literally `name*`), route contracts (`params` schema keys and `bind` keys against the parameters their path declares), agent routes (`.agent()` metadata: a route with no name, an illegal or duplicated tool name, a non-read-only tool with authentication but no authorization; warns on a tool name some clients drop (outside `[A-Za-z0-9_-]{1,64}`, the `agent.toolName` fix; advisory, so `--ci` and `gate` pass), missing output/body schemas, an Inertia response, a read-only tool whose action mutates — declared or GET/QUERY-default — and any verdict blocked by a handler body it does not read), in-process agents (RFC 0029 §8, content-activated on `Agent` subclasses of `@guren/plugin-ai`: a literal `appTools([...])` name no `.agent()` route derives, a name outside the class's `static scopes` in the RFC 0016 grammar, a scope entry outside that grammar, no `aiPlugin()` call in the app, an audit trail configured in both `aiPlugin()` and `mcpPlugin()`; a non-literal `appTools()` argument or `scopes` is reported unverifiable, never passed), Postgres timestamp time zones, configureAttachments() table bindings, Attachable models in apps with no configureAttachments(), attachments delivery wiring (delivery configured but registerAttachmentRoutes() unmounted; serve: 'redirect' on a disk whose driver cannot presign), session wiring (a `database` store bound to a table the schema does not export; a `SessionConfig` no provider binds), deferred Inertia props (a `defer()`, or `always(defer())`, passed in `this.inertia()` for a key the page's `Props` declares without `?` or `| undefined`: `InertiaPropInput` admits a deferred value for a required prop, so it typechecks while the initial visit hands the component `undefined`; content-activated on a controller importing `defer` from `@guren/core`; a spread, a non-literal props argument in an action that calls `defer()`, and a `Props` the reader cannot close (`extends`, a generic) are reported unverifiable, never passed; advisory, so `--ci` and `gate` pass), architecture boundaries, doc links, and the deploy-runtime verdicts (in-memory session/OAuth/cache stores, a Bun-only `ScryptHasher`, filesystem provider discovery: the same three `guren doctor` reports, for an app that declares a deploy plugin or the Lambda adapter; advisory, so `--ci` and `guren gate` never fail on them), and a `db/schema.ts` whose hand-kept aggregate object omits a table the same file declares, or, for the root's, a module table it neither lists (imported by name) nor hands to that module's own aggregate by a spread (gating only where the file identifies that object — named `schema`, read by a `typeof` (a non-empty object only; `{}` counts only by name), or, for a module's, spread by name into an identified root object; a spread object the reader cannot follow is reported unverifiable, never passed; on shape alone it is advisory, since a grouping of table shorthands looks the same) (informational; only --arch/--docs/--spec set the exit code)
bunx guren check --json         # Check results as JSON; a finding that regenerating files clears carries `fix: { kind: 'command', args }` (codegen, spec:generate)
bunx guren check --fix          # Run each distinct `fix` once (generated files only), then check again and report that run with `fixes`; exits non-zero when a fix command fails or leaves its findings reported; refused under `--ci`
bunx guren check --arch         # Architecture boundary checks only (guren.arch.ts) — fast path for edit hooks
bunx guren check --docs         # Doc-link checks only: OKF frontmatter (type/entities/related) + body markdown links + @docs tags + `(AC-…)` citations against test titles (advisory warns; exits non-zero on failures)
bunx guren check --spec         # Spec drift checks only: docs/spec/ vs regenerated views (exits non-zero on failures)
bunx guren check --prototype    # Prototype wiring checks only (RFC 0021): fixture entries vs. the route graph, createApp({ prototype }) (exits non-zero on failures)
bunx guren check --i18n         # Translation catalog checks only: lang/<locale> key parity + interpolation placeholders (exits non-zero on failures)
bunx guren check --plan         # Implementation-plan checks (RFC 0030 §8), only under this flag: approved, unclosed plans with drifted elements (the plan:status overlay) or a command the allowlist refuses, two such plans changing one app target, plans sharing a slug; advisory, so it exits 0. Imports db/schema.ts and every validator file, which plain check never does
bunx guren spec:generate        # Generate spec views (er/domain/screens/modules) into docs/spec/ — deterministic, committed, drift-gated
bunx guren check --changed      # Restrict file-scanning checks to files changed vs. the merge base with main
bunx guren audit                # Security audit: validation/auth on mutating routes, raw SQL, secrets, mass assignment, CSRF exemptions (app source, plus a scan of installed Guren-facing packages — the only surface that sees a plugin's); agent-exposed routes (RFC 0016) get the stricter treatment — an unverifiable body-validation warn becomes a fail, and destructiveHint: false on an action that deletes, updates, or force-writes warns; in-process agents' local tools (RFC 0029 §2.4) are listed under their own heading (`aiLocalTools` in JSON), with a warn when a tool's `execute` writes through a Model whose table an `.agent()` route also uses
bunx guren audit --json         # Audit results as JSON (exits non-zero on failures)
bunx guren doctor --next        # Doctor report + actionable next steps

# Implementation plans (RFC 0030)
bunx guren plan:render comments.plan.json   # Validate a plan against the app and write it as one self-contained HTML page (--app <dir>, -o, --locale)
bunx guren plan:approve comments.plan.json  # Approve a plan (RFC 0030 §4): refuses while a §2 check fails, a question is open, or the tree is dirty or git status fails (the plan, its rendered page, its approvals/decisions files, their temp files and .guren/plans/ excepted, compared as real paths). A draft's baseline is stamped once, here, and written into the plan file: rev from `git rev-parse HEAD` (no repository or no commit is a refusal) and contextHash, one hash per element the §2 checks judge by name; a section other than validators that cannot be read refuses unless --allow-unstamped. A plan that carries a baseline (a revision carries its parent's) is never restamped, and on it a collision or absence is not a refusal for an element stamped at the state the plan starts it from and read now exactly as the plan leaves it (its own built work, `builtByPlan` in the report; plan:render shows those as passes). Records { hash, approvedAt, approvedBy, readings } beside the plan: approvals.json for a docs/plans/<slug>/plan.json, else <slug>.approvals.json. `readings` is how each planned property of every `alter` read (the app is read with detail when the plan has one), the earliest under the same baseline carried over, so a revision approved after the work keeps the reading from before it; re-approving a hash writes nothing unless its entry lacks a reading, which it then adds and replaces none. plan:next, plan:verify, plan:waive and plan:close refuse a plan with a baseline whose current hash no approval names, a draft with approvals beside it (its baseline was deleted), or a plan whose approvals file will not read; other drafts keep their behaviour. Warns without refusing on an `alter` whose readable readings on the approval entry all read `match` (`heldAlters` in `--json`; an `unknown` is not held), since no such property can show its change (--app <dir>, --json)
bunx guren plan:status comments.plan.json   # Which plan elements exist in the code: planned/present/wired/drifted/unjudged/blocked per element, per-property match/differ/unknown, and the "planned, not checkable" list (--app <dir>, --json). Observational: imports the routes file and db/schema.ts, boots nothing, exits 0 whatever the status, and for a plan with a baseline reports `approval` (approved, unapproved, baseline-removed or unreadable) rather than refusing. Lays what plan:verify recorded under .guren/plans/ over the result: verified while the fingerprinted files still hash the same, drifted once one does not. For a plan with a baseline it also reports freshness per element: fresh, stale (what the scanners read for it is neither what was stamped nor what the plan's own end state predicts), unstamped (no hash at approval) or unjudged (its section cannot be read now), with the elements naming each stale one
bunx guren plan:verify comments.plan.json --step task/entity/model.comment/http  # Run a step's verify commands (codegen, typecheck, db:migrate, guren check, the tests as `bun test --reporter=junit` on the files carrying its acceptance ids) and record the outcome (verified/failed/blocked/incomplete) with a fingerprint under .guren/plans/<slug>.state.json (git-ignored), plus the marked step's files touched and lines changed (`work`, a `work:` line in the text; `plan:status --json` lists them under `verification.work`). Every step in task order without --step; --timeout <s> per command, --ci exits 1 when a step did not verify. Executes: bun test boots the app, db:migrate opens the database; what cannot run here is blocked, never failed. Refuses, before anything runs, a plan with a baseline no approval names. For an approved plan it also reports the baseline's freshness and the stale context of the steps it ran (`staleContext`), never folded into their outcome
bunx guren plan:waive comments.plan.json policy.comment --reason "the policy lands in the next plan"  # Accept elements of an approved plan incomplete, in the decision log beside the plan (committed): decisions.json for a docs/plans/<slug>/plan.json, else <slug>.decisions.json. A waiver names the plan hash, so a revision inherits none; plan:status reads it as `waived` unless the element is already verified, plan:verify leaves it out of the step's judgement, and the loop moves past a stall. plan:next lists a step's waived elements apart from the ones to implement, and both it and the Stop hook report a log they could not read. --remove deletes a waiver by element id alone, so a revision can withdraw one it dropped; everything else refuses a draft, a plan whose current hash no approval names, an element the plan does not declare or plan:status does not judge, and a missing --reason. --app <dir> is what the reported log path is relative to
bunx guren plan:next comments.plan.json     # The next step to implement (RFC 0030 §7): its elements verbatim, behaviours and verify commands, never the whole plan. Marks the step under .guren/plans/, with the commit HEAD names as where its work is measured from (kept when the same step is marked again), so the harness Stop hook (gate-on-stop.ts) verifies it on every stop, blocks up to three continuations while it is not verified, then records it stalled with the reason; the next plan:next reports the stall and returns the step again. For an approved plan it reads the app (imports the routes file) and holds a step on stale context (§4): the step owning a stale element, naming one, or owning a column/action of a stale model/controller, reported with the §2 checks re-run for it, and the steps waiting behind it; every step left held returns no step and still exits 0, keeping a mark stalled on a held or waiting step for the next run. Spawns nothing, never reads the app for a draft, refuses a plan with a baseline no approval names before it reads or marks anything, then any plan, draft or approved, carrying a command the `commands` allowlist refuses, and a dirty tree unless it is the marked step's own (--app <dir>, --json)
bunx guren plan:close comments.plan.json    # Close an approved plan (RFC 0030 §7): refuses unless its current hash is in the approvals beside it and every element outside `existing` is verified or waived, judged by the same planStatusFile() plan:status prints (a state file or decision log that will not read refuses too). Writes docs/plans/<slug>.md (type: plan, entities, closed: true, plan_hash, the approval as the verified event) and, per model the plan adds/alters/renames, blocks fenced by `<!-- guren:plan <slug> <hash> <section> -->` in docs/entities/<Entity>.md (created with OKF frontmatter when absent): Purpose, Rules citing `(AC-…)` ids, Decisions, Non-goals, History. Found by slug and section, so a re-run is byte-identical and a revision replaces its parent's blocks; text outside the markers and an existing doc's frontmatter are never touched, and markers it cannot rewrite safely (unclosed, duplicated, inside a code fence, after a fence that never closes) refuse the close with nothing written. Deletes nothing: the plan, approvals and decision log stay committed. Prints a make:adr command per waiver (--app <dir>, --json, --dry-run)

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
bunx guren make:feature Post --fields "title:string" --factory  # Also generate a model factory in db/factories
bunx guren make:feature Post --fields "title:string" --public  # Skip auth checks in mutating actions
bunx guren make:feature Post --fields "title:string" --policy  # Also generate a policy and enforce it in store/update
bunx guren make:feature Post --fields "title:string" --attach "cover:one,images:many"  # Attachable model + attach-aware store/destroy (requires `guren add attachments` first; RFC 0013 Part 4)
bunx guren make:feature Post --fields "title:string" --prototype  # Prototype-first (RFC 0021): pages, validator, page-data type, fixture entries; no backend. Re-run without the flag to promote (requires `guren add prototype`)
bunx guren add prototype                    # Prototype mode: fixture module, dev:prototype/build:prototype scripts, client + app wiring (RFC 0021); --remove reverses the wiring
bunx guren make:policy Post     # Authorization policy scaffold (app/Policies)
bunx guren make:validator Post --fields "title:string,body:text"  # Zod schemas (route params, list query, payload) in app/Http/Validators
bunx guren make:adr "Billing cycle is end-of-month"  # Numbered ADR under docs/adr with linkable frontmatter (entities/related)

# Application modules (RFC 0002) — self-contained modules/<name>/ directories
bunx guren make:module Billing              # Scaffold modules/billing/{index.ts,routes.ts,db/schema.ts}, wire into src/app.ts
bunx guren add ai --provider anthropic      # In-process AI agents (RFC 0029): config/ai.ts, the provider key in config/env.ts, aiPlugin(), bun add of the packages (--no-install prints it), and the ai_conversations/ai_messages tables + migration + database conversation store when db/schema.ts exists (--no-conversations skips)
bunx guren make:ai-agent SupportTriager --tools tickets_show --output --test  # In-process agent in app/Ai/Agents; --tools checked against the derived agent tools; --test scripts it with fakeAi(). Not make:agent (RFC 0017's durable Workers agent)
bunx guren ai:eval support-triage --reps 2 --max-cost-usd 5  # Run one eval against the real model (RFC 0029 §10): tests/evals/<flow>.eval.ts, results under .claude/hillclimb/<flow>/<variant>/. Opt-in, never part of check or gate
bunx guren add session                      # Database-backed sessions: schema table + migration, config/session.ts (a definition when config/env.ts exists, else with SessionProvider), sessions:prune (RFC 0020; `guren add auth` runs it)
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
import { defineModel } from '@guren/core'
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
- `bunx guren codegen` generates four artifacts in `.guren/`: `pages.gen.ts`, `routes.gen.ts`, `data.gen.ts`, `api-client.gen.ts` (plus `agents.gen.ts` for apps whose routes declare `.agent()`). It reads the routes file; `--introspect` takes the route set from the introspected app (RFC 0026 §5), still rendering each route from the routes file's Zod
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
- `Hash` (`DefaultHasher`) is the default hasher and writes `node:crypto` scrypt on every runtime; Argon2id rows are verified by prefix where `Bun.password` exists and rehashed to scrypt at the next login. `createApp({ auth: { hasher: 'argon2' } })` opts into Bun.password for Bun-only deployments. Never construct `ScryptHasher` or select `'argon2'` in code a Node runtime will run
- Static assets should be served via CloudFront/S3, not Lambda
- Use Redis-backed session/cache/queue stores (not in-memory)
- List providers explicitly in `createApp()` (auto-discovery requires Bun)

## Key Files

| Path | Purpose |
|------|---------|
| `packages/server/src/http/Application.ts` | Main server class |
| `packages/server/src/http/request-container.ts` | The one place a middleware reaches the container of the `Application` serving its request (RFC 0023 §2): `CONTAINER_CONTEXT_KEY`, stamped by the app's first middleware, and `getRequestContainer(ctx)` / `tryGetRequestContainer(ctx)`. A bare Hono app carries no stamp, which is why the optional form exists |
| `packages/server/src/http/default-application.ts` | The ambient `Application` (RFC 0023 §3): what a helper with no handle to pass (`encrypt()`, `t()`, `Job.dispatch()`, `resolve()`) resolves from. Last-constructed wins, as `bun test` needs; a second construction beside a live default marks the choice ambiguous and the next ambient call warns once, naming `useAsDefaultApplication()`. `resetDefaultApplication()` is the test seam that replaces every `set*(undefined)` |
| `packages/cli/src/add-session.ts` | The `guren add session` blueprint (RFC 0020 §2): the per-dialect `sessions` table, `config/session.ts` (a `defineSessionConfig` definition in an app with `config/env.ts`, otherwise beside `SessionProvider`), the `SESSION_DRIVER` env entry, and `sessions:prune`. `make:auth` runs it before generating its migration, so one drizzle-kit run covers users and sessions — which is why `addSession({ migration: false })` exists |
| `packages/core/src/session-manager.ts` | `createSessionManager()` and the `database` session driver (RFC 0020 §1). The one place `SessionDrivers` gains `database`: the store wraps a drizzle table in an ORM `Model`, which `@guren/server` cannot do. Registered by a factory call rather than a module side effect, so a bundler dropping an unused import cannot drop the driver; `packages/core/tests/session-manager.test.ts` pins the augmentation surviving into the bundled `.d.ts`, which nothing else would notice losing |
| `packages/server/src/http/middleware/cookie-session-store.ts` | The `cookie` session driver (RFC 0020 §3): the whole session encrypted inside the cookie under the app key, so it needs no table, no Redis and no Workers binding. Implements `SessionStore.inline`, the optional capability the middleware forks on — `read`/`write`/`destroy` are never called, since there is no keyed store behind it. Refuses to encode past 4 KB rather than emitting a cookie the browser drops; a logout cannot revoke a copy the client already has, which is why anything revocable belongs in the database |
| `packages/server/src/http/middleware/session-manager.ts` | `SessionManager` and the augmentable `SessionDrivers` registry (RFC 0020 §1): named stores, one default, lazy memoized resolution so a plugin's `registerDriver()` and a Workers binding may both arrive after construction. Bound under the container key `session`; `AuthServiceProvider` builds the session middleware on the first request from `manager.options` + `auth.sessionOptions`, and fails the boot when both name a store. Server ships `memory` and `redis`; `database` is core's to add, since server must not depend on the ORM |
| `packages/server/src/mvc/Controller.ts` | Base controller (validateBody/Query/Params) |
| `packages/server/src/mvc/Router.ts` | Instance-based route registry |
| `packages/server/src/errors/ExceptionHandler.ts` | Exception handler (duck-type statusCode) |
| `packages/orm/src/Model.ts` | Base model class (findOrFail) |
| `packages/orm/src/ModelNotFoundException.ts` | 404 exception for models |
| `packages/server/src/lambda/index.ts` | AWS Lambda adapter |
| `packages/server/src/auth/password/NodeHasher.ts` | Node.js-compatible password hasher |
| `packages/cli/src/bin.ts` | CLI entry point, and the one place a finished command ends the process: a routes file or `db/schema.ts` a command imported may hold a timer or client open that nothing in the CLI closes, so every command built with `define-command.ts` exits once `run()` settles, through `process-exit.ts`, which waits for each stdout/stderr write first (Bun's `process.exit()` drops what is still queued on a pipe). `keepsProcessAlive()` exempts the commands that hand the process to a listener or REPL (`dev`, `tool:dev`, `console`); a plugin's command that succeeds is never ended here, since its lifetime is unknown (a failing one exits with its code, as before). A command does not end its own `run()` with `process.exit(0)` |
| `packages/cli/src/introspect.ts` | The CLI's reader of RFC 0026's manifest: `introspectApp(cwd, { timeoutMs })` spawns `introspect-child.ts` under `GUREN_INTROSPECT=1` with the app root as cwd (Bun loads `.env` as for `guren dev`), memoised per root and timeout per process (`fresh: true` runs a child of its own, which the gate asks for since the dev MCP server calls it for a whole session; `introspectRunner()` turns a `runCheck()`/`runAudit()` `introspect` option into one run shared by its callers; `CHECK_INTROSPECT_TIMEOUT_MS`, 10 s, through `checkIntrospection()`, is the one cap for every command that judges the app: `check`, `audit`, `doctor`, the gate, `plan:verify` and the deploy builds, so `check --ci` and the gate cannot disagree; `guren introspect`, `context` and `codegen --introspect` keep 30 s), and returns `ok` or a `failed` reason (`no-entry`, `import`, `timeout`, `crashed`, `old-server`). The child checks `Application.prototype.introspect` on the `@guren/core` the entry resolves *before* importing the entry, since a scaffolded `src/main.ts` boots at import and an older server would run the real boot; it resolves controller identity through `discoverControllerFiles()`, so server never restates the discovery rule, and writes its result to a temp file because app modules print to stdout. Type-only against `@guren/server`: the app may resolve an older one |
| `packages/cli/src/context.ts` | AI agent: project context map generation |
| `packages/cli/src/entity-context.ts` | AI agent: entity-centric context bundles (`guren context <Entity>`, RFC 0004) |
| `packages/cli/src/docs-index.ts` | AI agent: docs/ scanning (DocRef, entity index, `@docs` tags); facade over the parsers below |
| `packages/cli/src/docs-frontmatter.ts` | AI agent: the YAML-subset frontmatter parser (OKF fields) |
| `packages/cli/src/docs-links.ts` | AI agent: markdown link scanning shared by check, graph, and renderer |
| `packages/cli/src/docs-check.ts` | AI agent: doc-link validation (`guren check --docs`) |
| `packages/cli/src/i18n-types.ts` | AI agent: typed translation keys (`.guren/translations.gen.ts` from `lang/`) |
| `packages/cli/src/i18n-check.ts` | AI agent: translation catalog checks (`guren check --i18n`) |
| `packages/cli/src/make-adr.ts` | AI agent: numbered ADR scaffolding (`make:adr`) |
| `packages/cli/src/spec-generate.ts` | AI agent: spec view orchestration (`spec:generate`, RFC 0004). Reads the routes file only, never the introspected app: the views are committed, and `guren gate` and the edit hook regenerate them in process, which must give the same bytes whether or not the run introspects (RFC 0026 Part 2d) |
| `packages/cli/src/app-routes.ts` | The join of the introspected app's routes to the routes file's definitions that the Part 2d consumers read (RFC 0026 §5), on method, path, name and controller action, nth to nth, and nothing where the two sides count a key differently. `loadIntrospectedRouteDefinitions()` is what `guren context` and `codegen --introspect` read: the manifest decides which routes exist and in which order, and each joined route is the routes file's definition, whose Zod every renderer reads; an unmatched route (a provider's) comes from the manifest without schemas. `route-contract-check` joins through it for its Zod fallback, and `attachControllerRefs()` in `controller-methods.ts` through `joinRouteDefinitions()`, so a manifest reference reaches a registered definition by the same key and ambiguity rule. With `byModule` the join keys on each side's `module` too (the `defineModule()` name, which `loadRouteDefinitions()` records as `moduleIdentities` and the manifest holds), so a key two modules share never pairs by module order, which the CLI (directory order) and the app (`createApp({ modules })` order) need not share; `attachControllerRefs()` asks for it, the other callers do not yet. Codegen stays on the routes file by default, and so does `planAgentManifest()`, the rule for what codegen writes: `--introspect` output is one-shot, and a `.guren/agents.gen.ts` it wrote from provider-only tools reads as stale to `check` and `doctor`. A tool name two routes claim goes to the first registered, as `deriveAgentTools()` does at runtime |
| `packages/cli/src/spec-check.ts` | AI agent: spec drift gate (`guren check --spec`) |
| `packages/cli/src/schema-parser.ts` | Shared Drizzle schema AST parser (tables, columns, FKs, dialect, column options), and the one reading of an app's hand-kept aggregate object (`findSchemaAggregate`, which resolves a key or spread imported from `modules/<name>/db/schema` through `schema-binding.ts`) — `appendTableToSchema()` writes the key, `make:module` gives the module an aggregate and spreads it into the root's (`spreadModuleIntoSchema()`), `guren check` reports a missing one, and a second detection is how the writer and the checker come to disagree about which object is the aggregate |
| `packages/cli/src/schema-runtime.ts` | The runtime schema reader (RFC 0030 §6): imports `db/schema.ts` and asks drizzle's `getTableConfig()`, returning the static reader's `SchemaTable` shape for what that reader can only mark opaque (spread columns, helper builders, the columns callback, an extra config built elsewhere). `drizzle-orm` resolves from the schema file's directory with ESM conditions, so the reader and the schema share one module instance. A schema that cannot be imported is a per-file `unreadable` result, and `readSchemaTables()` falls back per table to the static reading with its opaque markers. It executes app code, so `guren check`, the spec views and the scaffolders stay on `parseSchemaTables()` |
| `packages/cli/src/inflect.ts` | The one pluralization rule: collection, route slug, schema identifier, and table name for an entity. Every scaffolder and `guren check` derive names through it — a second rule is how the model's import and the schema's export drift apart |
| `packages/cli/src/make-migration.ts` | `guren make:migration` and the one rule for which drizzle-kit runs: `findAppDrizzleKitBin()`, the copy the app installs (each `node_modules` from the app root up), never `bun x`, which falls through to npm's copy when the app has none. `make:migration`, the scaffolders' `generateSchemaMigration()` and `plan:verify`'s migration check (`resolveAppDrizzleKit()`, which also wants a config) all resolve through it and run it under `bunExecutable()` (which is also what lets a `drizzle.config.json` load). None ever fetches one: with none installed `make:migration` stops with an error naming `bun install`, the scaffolders fall back to a `db:make` hint, and `plan:verify` blocks |
| `packages/cli/src/drizzle-pins.ts` | The one rule keeping `drizzle-orm`/`drizzle-kit` on the copy `@guren/orm` installs. `guren upgrade` applies it to an installed app, `scripts/sync-template-deps.ts` to the scaffold templates — a second rule is how a scaffolded app ends up with two ORM copies in one process |
| `packages/cli/src/route-registrar.ts` | The one rule for what counts as an app's route registrar, and the patch that wires a scaffolded routes file into it. `load-routes.ts` resolves the same export names at runtime — a scaffolder that picked its own target patches a function the framework never calls, and the routes look wired while mounting nothing |
| `packages/cli/src/app-surface.ts` | The one rule for "this app cannot render an Inertia page". Scaffolders that emit a page component or wire into `routes/web.ts` refuse an API-only app through it. Positive evidence only — a scaffolder that guesses blocks commands that would have worked |
| `packages/cli/src/check.ts` | AI agent: integrity checking |
| `packages/cli/src/console-check.ts` | AI agent: console command registration checks (part of `guren check`) |
| `packages/cli/src/route-path-check.ts` | AI agent: route path checks — a `:name*` parameter, which reads as a Hono wildcard but registers a single-segment parameter named literally `name*` (part of `guren check`) |
| `packages/cli/src/routes-check.ts` | AI agent: route registrar wiring checks — a `routes/*.ts` its mounting registrar never calls, per scope: the app's entry for the project's `routes/`, the registrar `defineModule({ routes })` names for `modules/<name>/routes/` (part of `guren check`) |
| `packages/cli/src/route-contract-check.ts` | AI agent: route contract checks — a `params` schema key or `bind` key naming a parameter its path never declares. Reads *registered* definitions rather than the routes file's AST: the path a route registers is the joined one (group prefixes, `resource()` expansions), and a params schema is usually imported from elsewhere (part of `guren check`). With `guren check`'s introspection (asked for once a route declares a params schema or a binding) it judges `manifest.routes`: keys from the JSON Schema's `properties`, severity from `required`, which `permitsOmission()` must match (`tests/route-introspect.test.ts` pins one route per wrapper), and the routes file's Zod for the same route wherever the rendering is short of the schema; with no Zod there, a shortfall the walker notes is unreadable, never a pass (a key it drops with no note, `z.undefined()` and the like, goes unseen on a route with no joined definition) |
| `packages/server/src/mvc/prototype.ts` | The `prototype` route handler (RFC 0021 Part 2): a branded object, never a function, so `register()` detects it before contract wrapping and `mount()` resolves it once `.name()` has run. Enforces the route contract like an inline handler, then runs the fixture entry (`createApp({ prototype })`, loaded at boot only when a prototype route exists) with the real shared props over the fixture's. `state()` is per process and shared by every request, which is why `Application` refuses such routes in production without `GUREN_PROTOTYPE_ROUTES=1` |
| `packages/plugin-ai/src/eval-run.ts` | The eval runner (RFC 0029 §10), behind the `@guren/plugin-ai/eval` subpath and never imported by the plugin's root. What the framework owns is isolation, the real model call, and structured rows; the on-disk layout belongs to a reporter (`eval-reporter.ts` writes the `.claude/hillclimb/` one the claude-api harness reads). Cost is derived here rather than in a reporter, so every reporter sees the same number, and a provider with no `pricing` yields a row with no cost rather than a zero — the one difference that would make a variant look cheaper than it is. `guren ai:eval` resolves this module from the *app's* copy, so the `defineEval()` that wrote the definition and the `runEval()` that reads it are one installed package |
| `packages/cli/src/add-ai.ts` | `guren add ai` (RFC 0029 §8): the per-provider `config/ai.ts` templates under `templates/scaffold/ai/<provider>/`, the key declaration, `aiPlugin()` wiring, and `bun add`. The `ai` and `@ai-sdk/*` ranges it installs are `@guren/cli`'s own devDependencies, the copies `typecheck:templates` checks those templates against; `ai` must equal `@guren/plugin-ai`'s dependency, which `tests/add-ai.test.ts` pins. The conversation tables are patched into `config/ai.ts` after the template rather than templated, so the provider templates need no schema companion; `tests/add-ai.test.ts` runs the store against the SQLite tables, since the two agree only by column property name |
| `packages/cli/src/plan/verify.ts` | `PlanVerifier`, the executing half of RFC 0030 §6 behind `guren plan:verify`. Runs a step's verify commands through the `exec` seam (one run per command and per test-file set for the invocation; every list opens with `codegen`, so nothing is judged before the generated files exist, and its `guren check` reads the introspected app, capped at 10 s like the gate's), judges the tests from the junit report by file selection and never by `-t`, and fingerprints the files `plan:status` found the step's elements in (`PlanElementStatus.files`) plus the test files. `blocked` is the environment's (a script the app lacks, a tool the shell cannot find, a timeout, a database the migration output says is unreachable, a check that threw) and never a failed implementation, and a failed command leaves something to fix, so it names the step `failed` whatever else was blocked; `incomplete` is commands passing over an element not yet at `completesAt`. The status is asked for after the first `codegen`, and a whole-plan run skips a step whose record still stands. A data step's `db:migrate` first asks the app's own drizzle-kit (`resolveAppDrizzleKit()`, never `bun x`) for `generate --explain --output json`: uncovered statements fail it, a drizzle-kit that cannot answer blocks it |
| `packages/cli/src/plan/verification.ts` | The overlay both `plan:status` and `plan:verify` report through, so they cannot disagree: `applyVerification()` is pure and, given the records and what the files hash to now, lifts to `verified` or `drifted`; a record of another plan digest is stale, and an element none of whose files the record covers is never lifted, since that result could not expire. `recordStillHolds()` is the one rule for a step being done (the whole-plan skip, `plan:next`, the Stop hook): a verified record with nothing fingerprinted (`scaffold`, a `drop`, an element no reader finds a file for) stands on the plan digest alone, or the loop could never end; only the `drop` is lifted by it. A `drop` has no file and lifts on the step alone; any other element none of whose planned properties matched (existence, a mount or `unjudged`) lifts only while a behaviour of a standing step (`recordStands()`) reaches it: `behaviourReach()` in `plan/reach.ts` walks `listPlanReferences()` through the total `REFERENCE_CARRIES_BEHAVIOUR` table, which is where a new reference field is decided, and `behaviourCanReach()` is the same walk seeded with every element of a section a carrying reference names and the plan's behaviours: what no behaviour could reach (a column, a command, a side effect) is sent to `plan:waive` alone, by the unreached hold, `plan:close` and an `unjudged` `alter`'s reason in `status.ts`, which is why the walk sits in a leaf both import. An element lifted to `verified`, `drifted` or `waived` keeps no `reason`. Why an element is not lifted, and the command that moves it, is `plan/close-remedy.ts`'s (`describeCloseBlockers()`), which `plan:close` and `plan:next` both print. `overlayVerification()` is the one reading of `.guren/plans/`, and lays the decision log over the result as well, from a reading the caller may pass in: a `plan:verify` run must judge and report through one reading, or a record could leave out an element the report does not lift. It executes nothing, which is what keeps `plan:status` from importing `check.ts`. `recordDrift()` is the other half: a verified record of this digest whose waivers hold and whose only change is fingerprinted files, which `plan:verify` re-runs rather than `plan:next` handing out as work; `plan:verify --step` re-checks drifted earlier steps only after the step itself verified (commands are shared per run), never records `blocked` over a drifted record, and re-checks a drifted `tests:fail` step statically (`recheckTests()`: one test file still carries each id), leaving it drifted when that fails; re-checks stop at the first that runs commands and does not verify (a static one does not stop them), and a whole-plan run re-checks drifted steps only once every other step verified |
| `packages/cli/src/command-output.ts` | What `gate` and `plan:verify` share when spawning an app's scripts: `readScripts`, `resolveScriptCommand` (script, else fallback), and the findings shaping. The two classify a missing script and a failure differently (`fail` with a doctor hint in the gate, `blocked` in verify), so only the mechanics live here |
| `packages/cli/src/plan-check.ts` | `guren check --plan` (RFC 0030 §8), run only under that flag, since judging a plan imports `db/schema.ts` (`readSchemaTables`) and every validator file (`readSchemaIdentities`), which `check`, `gate`, `plan:verify`'s check step and the dev MCP must not pay for. The one plan discovery rule (the root's `*.plan.json`, and `plan.json` / `*.plan.json` under `docs/plans/`, `revisions/` skipped) and `isPlanInput()` for `--changed`; open = approved by `readPlanApprovalStanding()` (the gated commands' rule; a `baseline-removed` draft is reported) and not closed (`planDocClosedHash()` of `docs/plans/<slug>.md`); drift as `planStatusFile()` reports it; overlap keyed on `listPlanAppTargets()` names, never ids, tables app-wide, a changed column or action also claiming a parent another plan renames or drops. Every result is an advisory warn |
| `packages/cli/src/plan-next.ts` | `guren plan:next` (RFC 0030 §7): the first step in task order whose record does not stand, with what it covers and nothing of the rest, and the mark (`active` in the state file) the Stop hook reads. Spawns nothing; a draft never has the application read, an approved plan has it read without `detail` for the freshness hold of §4 (`plan/step-context.ts` decides what holds a step), and a load that throws holds nothing (the message suggests `codegen` on a fresh clone). Once every step is verified it instead reads the application once with `detail`, drafts included (so it imports `db/schema.ts` and the validator files), to list what `plan:close` would still refuse (`unverified`, each as `plan:close`'s refusal prints it, from `describeCloseBlockers()`); a read that fails is reported in `unverifiedUnreadable`, never fatal. A held step holds the rest of its task and every task waiting for it; `held` is the report's word, since `blocked` is the environment's. One step is one commit, so the only uncommitted work it accepts is the marked step's own, the state files excluded by pathspec. The entity context is not in it yet. A returned step whose record drifted carries `drifted` (the changed files) and is to be re-checked with `plan:verify --step`, not re-implemented |
| `packages/cli/src/plan/app-targets.ts` | The one derivation of which name each plan element is judged by against the application (RFC 0030 §2): a model's class and its table (a class rename leaves the table `existing`), a column in its model's table (none for an added model), an action as `Class.action` under the controller's name today, a route by its name and, for an `add`, its endpoint. `validate.ts` checks these targets and `freshness.ts` hashes them, so the stamp covers exactly what the checks judge |
| `packages/cli/src/plan/freshness.ts` | `stampContextHash()` and `judgeFreshness()` (RFC 0030 §4): one sha256 per element over the facts its targets read (whether the plan's root declares the name; for a table, matched by identifier or SQL name without its columns, which other roots do too; whether a column's table declares it and where else that table is; a route name's endpoints). A section that cannot be read stamps no entry and judges `unjudged`, never `fresh`; an element with no entry is `unstamped`. Fresh means the facts hash to the stamp or to the end state the plan alone predicts (`plannedEnd()`: add/rename present in its root, drop and a dropped parent's children gone, a route at its planned endpoint, a table name the plan adds or removes, and a dropped model's columns, in no other root); it never reads `plan:status`. A fresh verdict off its stamp carries `basis`: `built` when the stamp also equals the start state the plan predicts for the element as named now (`plannedStart()`: an add and a rename's new name absent, every other name present, a route present at its planned endpoint, an added route unregistered), else `end`; an `existing` or `alter` is never `built`, and `built` is what `settleBuiltFindings()` in `plan/validate.ts` lets `plan:approve` and `plan:render` settle. A same-root class another commit adds reads as the plan's own add. Every non-fresh element carries `affects`, the elements naming it, which is what `plan/step-context.ts` maps onto steps. The stamp is part of `planHash()`, so changing what it hashes renames every approved plan |
| `packages/cli/src/plan/step-context.ts` | `judgeStepContext()` (RFC 0030 §4): which derived steps depend on a non-fresh element, from `judgeFreshness()`'s `affects`, the steps' `elementIds`/`acceptanceIds`, and `planElementParents()` (a column's model, an action's controller), so it walks no reference of its own. One hop, never the closure (relationships and `covers` reach most of a plan). Only `stale` holds; `unstamped`/`unjudged` are reported as `unconfirmed` and hold nothing, and nothing unreadable releases a hold. `stepInProgress()` is the one rule for the step a session is on: the mark, stalled or not, whose own elements hold no step. `plan:next` and `plan:verify` call it; the Stop hook reads `plan:verify`'s `staleContext` |
| `packages/cli/src/plan-approve.ts` | `guren plan:approve` (RFC 0030 §4), the one writer of `baseline` and of the `alter` readings on the approval entry (`readAlterProperties()`, carried over by `approvalReadings()` within one baseline; outside the hash, since a late reading can only miss a change and a baseline is never restamped): a draft is stamped once and written back as the author's document plus the baseline, a plan that carries one is approved at the hash it has, its §2 collisions and absences on stamped elements the app reads as the plan leaves them settled by `settleBuiltFindings()` when `judgeFreshness()` calls the element `built` (stamped at the plan's predicted start, read now at its predicted end), so an edited plan can be re-approved mid-implementation. `plan/approvals.ts` keeps the record beside the plan through `plan/beside.ts`, the one rule for a plan's sibling files that the decision log uses too; a file that will not read is refused before the plan is touched. It is also the one approval gate: `readPlanApprovalStanding()` (approved, unapproved, baseline-removed, unreadable; `undefined` for a draft nobody approved) is what `plan:status` reports and the Stop hook stalls on, and `requirePlanApproval()` is the refusal the commands in `PLAN_APPROVAL_GATED_COMMANDS` share. A draft with approvals beside it is refused, so deleting `baseline` does not bypass the gate |
| `packages/cli/src/plan-close.ts` | `guren plan:close` (RFC 0030 §7). Completion is `planStatusFile()`'s overlaid elements, never a second rule, and approval is the plan's current hash in `plan/approvals.ts`. The text it writes is `plan/close-docs.ts`, pure: `readEntityDoc()` is the one marker rule, finding a block by slug and section whatever hash it names (narrowed to the hash, a re-close appends a second set) and naming markers it cannot rewrite safely, which refuse the close. Headings, section ends and markers are read through `markdownLines()` in `docs-links.ts`, the one fence rule. Writes go through `writeFileAtomic()`, and nothing is deleted. The refusal's lines come from `describeCloseBlockers()` in `plan/close-remedy.ts`, which `plan:next` lists too once every step is verified: per element the command that moves it (`plan:verify --step` of the owning step, preceded by a step whose behaviour reaches it when nothing matched; or `plan:waive` where `applyVerification()` would count no run, offering a behaviour beside it only where `behaviourCanReach()` holds), predicting that dead end from the task derivation and `behaviourReach()` before any run |
| `packages/cli/src/docs-acceptance.ts` | The acceptance-id half of the docs graph (RFC 0030 §7): `(AC-…)` citations in a doc body, `[AC-…]` in test sources (`bracketedTokens()`, the scan `plan:verify` selects files by), both judged by `isAcceptanceId()` from `plan/acceptance-status.ts`, and the rules heading `check --docs` and `plan:close` share. `docs:graph` draws `test` nodes with `verifies` edges to the citing docs and to the entity the id's segment names; `check --docs` warns, advisory so no gate counts it, on a citation no test carries, a test its entity's docs skip, and an uncited rule. The test tree is read only once some doc cites an id, through one `acceptanceTestsLoader()` the graph and the check share |
| `packages/cli/src/plan/decisions.ts` | The plan's decision log (RFC 0030 §6, §9): the waivers `plan:waive` writes, committed beside the plan, where `.guren/plans/` is git-ignored. Where it lives is `plan/beside.ts`'s rule, shared with the approvals: `decisions.json` beside a `plan.json`, `<slug>.decisions.json` beside any other plan, so two plans in one directory keep separate logs. A waiver carries the plan hash it was taken against, which is how a revision inherits none of them; `planWaiverHash()` is the one place a draft is refused a hash. A log that will not read is refused rather than replaced, unlike the state file: a rerun rebuilds a verification result and nothing rebuilds a decision |
| `packages/cli/src/plan-stop-hook.ts` | The plan half of the shipped Stop hook, `planStopHookFindings()`: verifies the marked step in process (a step whose record still stands is not re-run) and blocks the stop while it is not verified. A plan the approval gate refuses is not verified: the stop goes through and the mark is stalled with `cause: 'approval'`, which `plan:next` drops once the gate passes, giving the step a fresh mark; `plan:verify` judges the approvals again on the plan it reads itself. `judgeStopHook()` is the pure give-up rule: the step's stale context (the `staleContext` `plan:verify` reports, judged on the app it reads after `codegen`), the step or an element it owns `blocked`, the same record signature as the last blocked stop (only on a stop that follows one), or three continuations; a stall is written on the mark and sticks until `plan:next` reports it. `gate-on-stop.ts` runs the gate first, once per stop chain, then this on every stop. On a stop that verifies the marked step, the earlier steps `plan:verify` re-checks in that run spend no continuation; a verified step that broke one, could not re-check one, or left one for the next run lets the stop through, naming it |
| `packages/cli/src/plan/state.ts` | `.guren/plans/<slug>.state.json`: one record per step at the fingerprint it ran at, plus the `active` mark `plan:next` writes (its `from` is the commit the step's work is measured from) and the Stop hook counts continuations on, git-ignored through a self-ignoring `.gitignore` written beside it, since a committed "verified" is a claim nobody on a fresh clone has checked. A record names `planDigest()` of the plan it ran against (the plan hash when there is a baseline, the same computation over a draft), which is how `plan:status` tells a stale record from a drifted one. A file that will not read is reported and replaced whole on the next write |
| `packages/cli/src/plan/work.ts` | Files touched and lines changed per step (RFC 0030 §7, Part 3 item 3), the numbers Open Question 3's step width is retuned from. `measureStepWork()` diffs the working tree, untracked files included, against the mark's `from` (`git diff --numstat -z --no-renames`, under the app root; paths as git names them, never quoted or trimmed), leaving out the plan and its records, `.guren/`, lockfiles and drizzle-kit snapshots; a start that is gone from the history is unmeasured, never diffed. `stepWork()` is the one rule for which work a record carries: measured only for the marked step, settled at its first verified run, and carried unchanged by every later record, so a drift re-check under a fresh mark never replaces it. Anything it cannot measure is `measured: false` with a reason, never a zero. A measurement, not a gate: nothing reads it to refuse |
| `packages/cli/src/plan/references.ts` | The one table of "which plan element names which other element" (RFC 0030 §1): each path, the section its target has to be in, and how the reference reads in a finding. The §2 checks, the §5 task derivation and §4's dangling-name rule all read `listPlanReferences()` — a path one of the three knows and the others do not is how a revision passes a plan the checks then reject. `tests/plan-references.test.ts` holds the table to the schema's id-typed fields, so a new reference fails there rather than going unchecked. A flow's step ids and edge ends are that flow's own namespace, not references |
| `packages/cli/src/plan/command-allowlist.ts` | The one rule for a plan's `commands` (RFC 0030 §8): `guren <subcommand>` or `bunx guren <subcommand>`, unquoted, then arguments tokenized on spaces and `'`/`"` quotes over a closed character set (letters of any script, digits, `_-.,:/=@+%`, and a space or `?` inside quotes), so an escape, a shell metacharacter, a word opening with `=`, a control or invisible character, or an unbalanced quote refuses the command, as does an argument that is an absolute path or holds a `..` segment (each `=`-separated part judged). It bounds shell syntax and filesystem roots, not each generator's other flags. `refusedPlanCommands()` quotes a command through `quotePlanCommand()`, which also escapes what `JSON.stringify` leaves raw (DEL, C1, U+2028/2029, format characters). `PLAN_COMMAND_CLASSES` classifies every registry command, `add`'s blueprints as `add <name>`: only generators (`make:*` but `make:migration`, `lang:publish`, `add <blueprint>` but `add plugin`) pass, and a name it does not list is refused. `tests/plan-command-allowlist.test.ts` fails on a registry command it does not classify and on a classified name the registry lacks. `validate.ts` (a failing §2 check, so `plan:approve` refuses), `plan:next` (refuses before reading or marking, drafts included) and `check --plan` (advisory, for plans approved before) all judge through `refusedPlanCommands()` |
| `packages/cli/src/plan/status.ts` | `judgePlan(plan, appState)`, the pure half of `guren plan:status` (RFC 0030 §6): one state per element and a `match` / `differ` / `unknown` verdict per planned property. A property no reader sees is `unknown`, which never counts towards `present` and never satisfies a `drop`; an element with nothing readable is `unjudged` (an `alter` always, any other kind when it planned a property and has no mount point), a planned validator a readable action body does not validate with is a `differ` that holds the action at `present`, and a reader that failed here is `blocked` with the reason. An `alter`'s match counts only against the reading its approval recorded as `differ` or `unknown` (the third argument, `approvedReadings()` of the standing, passed by every caller); a match that already held or has no reading reads `unknown`, which is what keeps the verification overlay from lifting it without a behaviour. `verified` and `waived` are in the state type and never set here: `plan:verify` upgrades this result. `wired` is asked only of routes, actions, pages, validators and side effects, the kinds with a mount point; a side effect's is a use of the class, never a property, so it still closes only on a behaviour or a waiver |
| `packages/cli/src/plan/app-detail.ts` | What `plan:status` compares against, built by `loadPlanAppState({ detail: true })` from the same scans the §2 checks read (`app-state.ts`), so `plan:render` and `plan:status` cannot disagree about the app. Tables come from `readSchemaTables()` (runtime, static fallback per table), so only this path imports `db/schema.ts`. `mounts` is the evidence behind `wired`: the entry's `createApp({ routes, modules })` must import the routes file the CLI loaded, the export the loader picks, and `modules/<name>`; anything it cannot trace is `unconfirmed`, never mounted, and only the routes file the CLI loaded is evidence of it. `mounts.files` names the files those verdicts were read from (the entry, a module's descriptor): `status.ts` adds them, with the routes, controllers and use sites an element's `wired` rests on, to the element's `files`, so a change that unwires a verified element expires its record. Every entry carries the app root its file sits in, which `status.ts` compares with the plan element's `module` in both directions. A mention is never a use: a routes file's `identifiers` (imports excluded, the split `routes-check.ts` makes) only explains an unconfirmed verdict, while an action's `validates` and a route's `contractSchemas` are what `wired` may rest on. `contractSchemas` is object identity between a *registered* definition's `schemas` and the validator file's exports, not a `body` key in the source: an object literal nobody passes, a function nobody calls and a branch nobody reaches all carry one and register nothing. A route's `shadowed` is the other half of `wired`: an earlier registered route of its method (or `ALL`) that answers every request its path matches, by `routePathCovers()` in `mountRoutes()`'s order (entry, then modules). Two modules' routes, a path with a constraint or `*`, and a module's route while another module failed to load are unconfirmed, never passed, since the CLI loads modules in directory order and the application in `createApp({ modules })` order. Not modelled: hono answers every `HEAD` with the `GET` route before routing, so a `HEAD` route is never reached whatever the order (a plan cannot declare one) |
| `packages/cli/src/plan/property-status.ts` | A planned property's verdict (`PlanPropertyStatus`) and its constructors (`match`, `differ`, `unknown`, `existenceMatch`), the leaf `status.ts` and `field-status.ts` both build verdicts with. `restsOnReach()` in `verification.ts` is the one rule for which matches let a verified step lift an element without a behaviour: every `match` but an `existence` one (a key a schema declares, an ability a policy names); the overlay and `plan:close`'s remedies both ask it |
| `packages/cli/src/plan/policy-abilities.ts` | A policy's abilities for `plan:status` (RFC 0030 §6): the members `classActionMembers()` yields (the rule `Router` dispatch reads a controller by), or the keys of a `definePolicy({ … })` object. A name the class may hold unread is reported apart (a non-function field or a getter in `fields`; a computed name, a spread or a base class other than `Policy` as `open`), which the judge turns into `unknown` rather than `differ`. `DEFINE_POLICY_ABILITIES` restates the seven methods `definePolicy()` declares (a test pins it against the runtime class), since every other key is dropped. An ability's name is an existence match (`existenceMatch()`), which never lifts a policy without a behaviour: `make:policy` writes the standard names into every policy |
| `packages/cli/src/plan/side-effect-uses.ts` | Where the application's source dispatches, registers or sends a job, event, listener, mail or notification class: the evidence a side effect's `wired` rests on. AST-only, classes resolved through the import (barrels and namespace imports included), an instance followed through bindings scoped per block as ES modules scope them. A mention (an import, a type, `registerJob()`, a construction nothing sends) is kept apart and only explains the note, and so is a listener in an `on()` handler whose event is no event class (`unprovenIn`: a string event name reads the same as a route handler); a file that does not parse, or a `new AutoDiscovery()` for listeners, makes an absent use unprovable. Tests and the class's own file are never read as a use |
| `packages/cli/src/plan/impact.ts` | Impact (RFC 0030 §2), pure: per element whose change is `alter`/`rename`/`drop`, the consumers the static readers find (relationships, bound routes and their `ApiRoutes` entries and `deriveAgentTools()` tools, resources, policies, actions naming it, tests by file name) and, for a column, its reads from `column-consumers.ts`, the AST scan of controllers, resources and pages that follows a record or a list only from where the file ties it to the model, plus the column names a query on the model spells and the keys `create`/`update` write (listed as writes). `QUERY_METHOD_RESULTS` there classifies every public ORM query method, and a test fails on one it misses. Class names resolve per app root, so a module's model never lands in the root's Impact. Every list is a lower bound, and a reader that could not look is named on the entries resting on it. `impact-sources.ts` builds the input under `loadPlanAppState({ impact: true })`, which imports no `db/schema.ts`; `plan:render` asks for it only when the plan changes something existing. The breaking rule stays `planBreakingChanges()`; `impactBreakingChanges()` adds only an altered route or action whose app route publishes a tool the plan does not declare |
| `packages/cli/src/plan/field-readers.ts` | The two field readers behind `plan:status` (RFC 0030 §6), judged by the pure `field-status.ts`. A validator's fields are read off the export `app-detail.ts` imports, and every verdict beyond a key's existence rests on an allowlist that fails closed: the export is the object itself, unrefined; the field is `optional`/`nullable`/`default`/`prefault`/`nonoptional` over a leaf (`string`, `number`, `boolean`, `bigint`, `date`, `enum`, `z.coerce.*`) or over a pipe of two plain leaves (`.pipe(z.email())`, and `z.stringbool()` from zod 4.1); every check on the read leaf restricts (lengths, bounds, formats), an `overwrite` only ahead of them. Any other node on the path leaves type, `required` and rules `unknown`, naming the node. An entry must mean the same on every zod the apps admit (`^4`, from 4.0), since the reader runs against the app's own copy: check a new one against zod's own parsing on those versions before adding it. A pipe or codec is read for its type only; `nonoptional` over a fill and a null-accepting `z.coerce.*` leave `required` unknown, and a custom `.overwrite()` leaves rules unknown. A match on a key's existence alone carries `existence: true` (`existenceMatch()`), which `restsOnReach()` does not count as a matched property. The type is the walker's output side (`toJsonSchema()` from `@guren/server/internal/zod-json-schema`). A resource's payload is codegen's own reading (`readResourceDefinitions()` in `data-types.ts`, what `data.gen.ts` is emitted from), parsed into members; a payload codegen references rather than copies, or whose heritage is anything but one `Record<string, …>`, leaves an absent field `unknown` |
| `packages/cli/src/test-requests.ts` | Which routes the existing tests request (RFC 0030 §2): `TestApp` calls (`get`/`post`/`put`/`patch`/`delete`/`query`, the GET `withCsrf()` makes, `agent().call('tool')`) read by AST, so a comment or string is none, on a receiver the file itself types as a `TestApp` (annotation, factory, builder, namespace import, a same-file function annotated to return one), matched by name and not by scope. `REQUEST_METHODS`/`BUILDERS` are pinned to the `TestApp` class by `tests/test-requests.test.ts`. A request on what an imported helper returns, or with a path the file does not spell, is unresolved with its line and method, never guessed; a whole-segment interpolation fills a route parameter only. Route paths are lexed with `PATH_PARAM_PATTERN` and matched locally (hono is only a devDependency, which the same test compares against); an uncompilable constraint is `unknown`, never a miss. `routePathCovers(earlier, later)` asks the same matcher whether a route registered first answers every request of another, which is how `plan/app-detail.ts` finds a shadowed route; a later path with a constraint or `*` cannot be one request, so it is never `match`. Impact lists the requests reaching a route beside the tests named after its controller: `examples/blog` and `examples/api` test controllers without HTTP, so the scan finds no request there |
| `packages/cli/src/plan/page/` | The rendered plan's script (RFC 0030 §3) as TypeScript, typed against `Plan`, `PlanCheckResult` and the layout types; `payload.ts` is the one definition of what `render.ts` embeds and the page reads. `scripts/build-plan-page.ts` bundles `main.ts` into one classic script inside `index.html` and writes `assets/plan/index.html`, which is generated and gitignored; run from source, `assets.ts` composes the template on every call instead, so no test reads a stale build. Imports from outside `page/` are types, plus `../version.ts`: a value import of `schema.ts` would put zod in every rendered plan. `tests/plan-page-drift.test.ts` fails on a schema property the page never reads |
| `packages/cli/src/add-prototype.ts` | `guren add prototype` (RFC 0021 Part 3): the fixture template, the two scripts, the `startInertiaClient({ prototype })` string patch (anchored on `startInertiaClient({`), the `createApp({ prototype })` option through `addCreateAppOption`, the `GUREN_PROTOTYPE` env declaration. `--remove` reverses only what it inserted verbatim, so an edited script or line stays the author's |
| `packages/cli/src/make-feature-prototype.ts` | The prototype half of `make:feature` (RFC 0021 Part 3): the page-data type the pages import (`<Entity>Data`, aliased to `<Entity>ResourceData` so the page generators do not fork), the seed and the seven fixture entries appended at the `state: () => ({` and `routes: {` anchors the template ships (a fixture without them gets the blocks printed), and the promotion Resource typed against that same type. The state key is the route variable, not the PascalCase collection |
| `packages/cli/src/prototype-check.ts` | AI agent: prototype wiring checks (`guren check --prototype`, RFC 0021 §5) — a `prototype` route with no name or no fixture entry, a fixture entry naming no route, two named routes the client matcher cannot tell apart, `.agent()` on a fixture-backed route, `createApp()` without the loader. Reads the fixture by AST anchored on `definePrototype(`; a spread or computed key is reported as unreadable, never passed. Content-activated, and with `guren check`'s introspection it judges `manifest.routes`, so an entry naming a provider's route is no orphan |
| `packages/cli/src/ai-agent-scan.ts` | AI agent: the one reading of in-process agents (RFC 0029 §8) — `Agent` subclasses of `@guren/plugin-ai` found through the package's export (named or namespace import) or through a superclass whose *import* resolves to a class already found — a same-named class from another package is not that parent, their own and inherited `static scopes`, `appTools()` / `appToolDefinitions()` names (a spread, variable or computed element is `unreadable`, never a partial list), and the local tools `tools()` returns beside its `appTools()` spread. `guren check` and `guren audit` both read it |
| `packages/cli/src/ai-agent-check.ts` | AI agent: in-process agent checks (part of `guren check`) — names judged against `deriveAgentTools()` and `expandToolScopes()`, the same two functions `appTools()` calls at `as()`, so the check and the construction error cannot disagree. The audit-duplicate rule mirrors the runtime throw in `plugin-ai/src/plugin.ts`; approvals are not compared, since the two plugins never share a queue |
| `packages/cli/src/ai-local-tools-audit.ts` | AI agent: `guren audit`'s local-tool listing (RFC 0029 §2.4) and its one advisory, a Model write on a table an agent route's action also uses. Tables come from `extractTableIdentifier` on the models the two bodies reference. Findings carry a line, so `// guren-audit-ignore` is their suppression |
| `packages/cli/src/plugin-calls.ts` | The one reading of a first-party plugin factory call (`mcpPlugin({ … })`, `aiPlugin({ … })`) in app source: calls found through the package export's local aliases, each with the option keys it carries literally and whether an absent key is evidence. The approval-queue and audit-duplicate rules both read it |
| `packages/cli/src/agent-route-check.ts` | AI agent: agent-route checks — the wiring rules for routes declaring `.agent()` metadata (RFC 0016): the tool name is legal and unique, a non-read-only tool is covered by *authorization* rather than merely authentication, and the schemas an agent reads exist. Reads registered definitions like route-contract-check, or `manifest.routes` (through `manifestRouteTargets()`) when `guren check` introspects, which it asks for once a route declares `.agent()`; a verdict read from a controller body carries `evidence: 'static'`. Content-activated: an app with no agent routes contributes nothing and never scans a controller (part of `guren check`) |
| `packages/cli/src/controller-methods.ts` | The one controller-action body scan *and* the vocabulary for judging what it returns (`CONTROLLER_MEMBER_KINDS`, the `this.<member>(` patterns), shared by `guren audit` and the agent-route checks. Comments and string contents are blanked before any regex runs; on the static path same-named controller classes are *reported* rather than resolved, since a registered definition carries a class name, not a file, and a body attributed to the wrong file can flip a verdict. Patterns naming a `Controller` member are spelled through `ControllerMemberName`, which is what puts them inside `controller-surface.test.ts`'s reach: a pattern defined outside it goes stale on a rename with nothing failing. It is also the one rule for *which members of a controller class are actions* (`classActionMembers`) — `Router` dispatches to `store = async () => {}` exactly as to `async store() {}`, and a scanner spelling its own `member.type === 'ClassMethod'` test silently reports every class-field action as absent rather than as unverified. `guren check`, `guren doctor`, `guren context`, `spec:generate`, and this scan all read it. On the manifest path a route's `ControllerRef` resolved by identity reads `byExport` (`file#export` to the class, so `file#export.method` to the body; every name the file exports the class under) through `controllerMethodFor()`, the one lookup from a route to its body (a `name-only` reference is no export of a controller file the app loaded: it is `elsewhere`, with no body, when the routes file or the entry declares its name or when every same-named declaration is exported; otherwise it is read from an unexported one, or from one in a file whose import failed, which can hold the routed class only when the app evaluated that file under another path) (audit, agent routes, `guren context`; `plan:*` judges classes by name and module, never by route, and stays name-keyed); `collisionsReachedByName()` keeps a collision only for a class some route reached by name, and `withManifestControllerRefs()` (over `attachControllerRefs()`) gives registered definitions the manifest's reference through `app-routes.ts`'s join (module, method, path, name and action, nth to nth, nothing where the two sides count a key differently), which `guren context <Entity>` asks for on a collision a route reaches (the agent-route rules read `manifest.routes` through `manifestRouteTargets()` instead). The name-keyed `methods`, `classFiles` and `collisions` are what a caller that does not introspect reads (the edit hook, the dev MCP server, `--no-introspect`), and the key `plan:*` judges by, which is why a collision there is still reported rather than resolved |
| `packages/cli/src/http-methods.ts` | The one HTTP-method classification (`describeMethod`): which verbs are safe, which carry a body. Shared by `guren audit`'s two per-route phases and the agent-route input rule — a second list is how a verb ends up body-carrying in one command and not the other |
| `packages/cli/src/deploy-runtime.ts` | The one deploy-runtime reading *and* its three verdicts (`readDeployRuntime()` then `judgeDeployVerdicts()`, both behind `checkDeployRuntime`): a Bun-only hasher, in-memory stores, filesystem provider discovery on Workers/Lambda/Vercel. `guren doctor` maps them onto its checks, `guren check` onto advisory results, and the three deploy builds print them through `@guren/core/internal/deploy-check` (RFC 0020 Part 0), so one app cannot get three different answers. Once a deploy target is found it reads the introspected app (RFC 0026 §5, one `introspectApp()` per run): the auth manager's hashers by `requiresBun`, the selected session store's `perProcess` (a plugin driver's from its `gurenPlugin` manifest), a `memory` cache default. Without them (no introspection, a failed one, a section `manifest-section.ts` calls unverified, or no user provider registered while the source calls `auth.attempt()`/`auth.useModel()` or constructs a `ScryptHasher`, which a `useModel()` in `boot()` explains) the verdict is `deploy-password-hashing-unverified` / `deploy-runtime-stores-unverified` with `evidence: 'none'`, never a source judgement. The source scan holds what the manifest does not carry: target detection (the plugin in `package.json`, or the Lambda adapter imported in source), provider discovery (a discovered provider registers as `app.register`, like an explicit one), OAuth state stores, explicit `Memory*Store` constructions, a hand-mounted `createSessionMiddleware`, `autoSession: false`, and the backed stores a `sessionOptions.store` factory could build. It reads *constructions*, never intent. `checkDeployRuntime(cwd)` introspects by default (a `fresh` run of its own, capped at 10 s); `readDeployRuntime()` only when given `introspect`. `analyzeDeployRuntime()` and `judgeDeployRuntime()` are the deprecated public names (`deploy-runtime-analysis`). The manifest is read with the local `.env`, so every verdict stays advisory |
| `packages/cli/src/manifest-section.ts` | The one reading of RFC 0026 §5's fallback rule for a manifest section, which every check reading the introspected app goes through: described, or unverified when a provider threw (any section, since `auth` is always bound), a config was left unbound for an unset env key (`config-unverified` with its `key`, checked before the value since an unbound `session` still reads as `source: 'none'`), a deferred provider supplies it, or it is bound with no `describe()`. Stricter than the server's `readSection()` on purpose. A check with a static path falls back to it for an unverified section; only a fact with none becomes a `<key>-unverified` warn with `evidence: 'none'`, never a pass, built by `unverifiedResult()` (advisory, so no gate counts it). `introspectedSection()` is the form such a check calls: it asks for the run's introspection only then, so the check's own content is what starts the child, and hands back the section or the reason to judge from source |
| `packages/cli/src/schema-check.ts` | AI agent: Postgres `timestamptz` schema checks (part of `guren check`) |
| `packages/cli/src/session-config.ts` | Finds a `SessionConfig` in source (RFC 0020): an annotated *or* `satisfies` declarator, or the object a `defineSessionConfig()` resolver returns (RFC 0027 §2), and reads each store's `driver` and the identifier its `table` names. That is all `sessions-check.ts` needs from source: what activates the session rules, which config and export declare a store the manifest reports, and the table verdict for a config the app does not read or whose missing export fails the introspection. Which store is selected is the introspected app's to say (RFC 0026 §5). The anchor is the *type*, never the file name: a cache config keys `stores` and `driver` identically |
| `packages/cli/src/schema-binding.ts` | The one rule for "does this identifier name a table the app's schema exports": the `db/schema` specifier shapes, which schema module an import lands on (a module config must not pass on a table the root declares), and the import map. Shared by `configureAttachments()`'s table check and the session store's `database` driver. `attributeManifestTable()` is the same question for a table the introspected app names by SQL name (RFC 0026 §5), with which config it belongs to, for both checks: only a name the reader finds is evidence, since it sees each root's `db/schema.ts` only (not the other files `drizzle.config` lists) and names a `pgTableCreator()` table without its prefix |
| `packages/cli/src/sessions-check.ts` | AI agent: session wiring checks (RFC 0020 §2) — a `database` store bound to a table the schema does not export, and a `SessionConfig` no registered provider binds (the config is then never read and sessions stay in process memory — the file existing is not the question). Content-activated: an app with no session config contributes nothing, and introspects nothing. The binding is `session.source` from the manifest (`manager` binds it; `none`, no section, or `auth.sessionOptions.store` means the config is never read; a `session-configured-twice` warning is a fail), and without a manifest `sessions-binding-unverified`, advisory. Each `database` store's table is read by SQL name against the tables the schema declares, keyed as the source reading keys them; a SQL name the reader does not find keeps the source verdict when the source traces the table to a schema export, and is otherwise an advisory warn, never a fail. The source reading of the tables is kept for a config the app does not read and for a run with no manifest, since a missing named export is a link error that fails the introspection |
| `packages/cli/src/deferred-props-check.ts` | AI agent: deferred Inertia props (part of `guren check`) — a `defer()` value in a `this.inertia()` props literal for a key the page's `Props` declares as required. `InertiaPropInput<T>` admits `DeferredProp<T>` whatever `T` is, so `posts: defer(…)` typechecks against a required `posts: Post[]` and the initial visit hands the component `undefined`; the type-level fix (a conditional on `undefined extends T`) is a breaking change the server's `controller-inertia-types.test.ts` pins against, which is why this is a check. Reads the page once through `readPagePropMembers()` in `page-props-extractor.ts`, the same per-member reader `extractPagePropKeys` uses: a member declared beside an `extends` clause is judged, one the clause may declare is unreadable. A spread, or a non-literal props argument in an action that calls `defer()`, is unverifiable, never passed. Content-activated on the framework `defer` import; advisory throughout |
| `packages/cli/src/attachments-check.ts` | AI agent: attachments wiring checks — a `configureAttachments()` binding a table the schema does not export, an `Attachable(...)` model in an app with no `configureAttachments()` at all, and the RFC 0015 delivery rules (`delivery` configured with no `registerAttachmentRoutes()` route; `serve: 'redirect'` on a non-presigning driver); all otherwise only fail at runtime (part of `guren check`). Judged from the manifest's engine (`configured`, `table`, `disk`, `disks`, `delivery.mounted` together with the named route's controller) and the storage manager's drivers; a disk's `root` and `Attachable(...)` model detection stay on source. An engine configured only in `boot()` is past what introspection runs, so a call inside a function with no engine in the manifest is judged from its options in source, against the registered routes and storage drivers (`AttachmentsWiring.registered`); only when every call runs whenever its file loads, no source `import()`s it and no `createApp({ boot })` was skipped does `attachments-model:*` fail from the manifest. With no manifest at all the mount and the redirect disks are `attachments-delivery-unverified:*` / `attachments-serve-redirect-unverified:*`, advisory, while the table stays on source, where a missing export (which fails the introspection) is found. Table names follow the session rule (`attributeManifestTable()`): absence is never a fail, and a verdict no config file can carry is keyed on the rule alone, never dropped |
| `packages/cli/src/attachments-types.ts` | AI agent: cross-boundary attachment maps (`.guren/attachments.gen.ts` from `Attachable(...)` declarations, RFC 0013) |
| `packages/server/src/agent/derive.ts` | The one derivation of agent tools from route contracts (`deriveAgentTools`, RFC 0016). Runtime adapters and codegen both call it, so a generated manifest and a live server cannot advertise different schemas. Total by contract: a collision or an unnamed agent route is a warning plus a deterministic result, never a throw |
| `packages/cli/src/agents-types.ts` | AI agent: the agent tool manifest (`.guren/agents.gen.ts`) plus the codegen-only enrichment a `resource` hint needs — `definitions()` carries class names, the payload type behind them exists only in the CLI's AST extraction |
| `packages/cli/src/tool-list.ts` | AI agent: `tool:list` / `tool:inspect`, derived live from the route graph rather than read from the manifest |
| `packages/cli/src/arch-check.ts` | AI agent: architecture boundary checking (`guren.arch.ts`, see RFC 0002) |
| `packages/cli/src/arch/index.ts` | `defineArchRules()` + types, published as the `@guren/cli/arch` subpath |
| `packages/cli/src/changed-files.ts` | Git-diff-based file filtering shared by `check --changed` |
| `packages/cli/src/audit.ts` | AI agent: security audit (validation, auth, raw SQL, secrets). The route-level rules read the introspected app (RFC 0026 §5) when `guren audit` introspects (by default, unless `--no-introspect` or `--routes`, and only once the routes file registers a mutating or body-carrying route; `runAudit()` only with `introspect`, `true` or the run `guren gate` shares with its check stage): `manifestAuthVerdict()` judges the resolved `middleware[]`, where an authorization-only chain stays a warning (a guest reaches the gate with a `null` user) and a name nothing registers is a warning judged ahead of any guard (never passed), naming what introspection skipped that could register it (`skippedRegistrars()`). A failed introspection is one `introspection-unavailable` warning and a provider that threw sends the rules back to the routes file, whose path (`authMiddlewareVerdict()`, name-keyed bodies, every collision) is kept whole. Raw SQL, secrets, mass assignment and CSRF exemptions stay source scans |
| `packages/cli/src/authorization-audit.ts` | `guren audit`'s policy rule: a mutating controller route whose action body names a model with an `app/Policies/<Model>Policy.ts` (the name `make:policy` writes, never the `gate.policy()` binding) must show `this.authorize()`/`this.can()`, a gate asked by hand, the policy class, or an `authorization` middleware capability on the chain (`AuditedRoute.chainAuthorizes`, from the manifest or the routes file); an unread body is a warn, never a pass. Model and policy are paired within one app root, as `make:adr` and `plan` pair them. Advisory throughout, content-activated on the first policy; a `// guren-audit-ignore` in a comment above the action (`ControllerMethodInfo.leadingComments`) reports the finding `ignored` rather than dropping it. The model reference is import-aware (an alias, a default or a namespace import of the model file) and falls back to the bare name. Also the one place `GUEST_PATH_PATTERN` lives, which the authentication rule in `audit.ts` shares |
| `packages/cli/src/csrf-exemption-audit.ts` | AI agent: who exempts a path from CSRF verification. `declareCookielessAuthPath()` is public on `Application`, so an installed package can call it from `node_modules`, where the source scan never looks. Introspection (RFC 0026) registers the app without booting it, and its manifest carries no exemption list (Decision 4), so this reads the JS each Guren-facing dependency ships. It names packages, never paths: the path is an argument computed at boot. A package it cannot read is `partial` coverage and its own warning — reporting "no exemptions" for a directory that would not open is the one answer worse than none (part of `guren audit`) |
| `packages/cli/src/oxlint/nullish-env-default.js` | The lint rule for `process.env.FOO ?? 'default'`, which falls back only on `undefined` and so keeps a blank `FOO=` as `''` — a store, disk, host or port named `''`, or `Number('')` = 0. Reports a non-empty literal fallback only: `?? ''` is identical under either operator, and a non-literal fallback cannot be judged from syntax. Ships to scaffolded apps through `@guren/cli/oxlint`, because the defect it was written for lived in scaffold output |
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
   and `bun run audit:prose` if you touched `docs/` - AI-writing tells (em-dash
   density, filler vocabulary) and translated-English tells are banned; the
   judgment half is `.claude/rules/prose.md`
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
| `code-review` | "review", "check my code" | Review code changes for quality, patterns, security (opus; its description names when to pass `model: "fable"`) |
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
