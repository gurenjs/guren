# RFC: Application Modules and Architecture Boundary Checking

**Author:** Urata Daiki
**Date:** 2026-07-23
**Status:** Draft

## Problem

Guren applications currently have a single flat structure: one
`routes/web.ts` registrar, one `app/Http/Controllers` directory, one
`app/Models` directory, one `db/schema.ts`. This works well up to a few
dozen routes, but nothing in the framework helps an application stay
maintainable as it grows:

1. **No unit of decomposition.** `RouteRegistration` is a single function
   (`packages/server/src/http/Application.ts`), and while users can compose
   registrars manually inside it, there is no convention for splitting an
   application into bounded contexts. A 500-route application converges on
   one giant `routes/web.ts` and one giant `db/schema.ts` because that is
   the only shape the tooling recognizes.
2. **Active Record has no boundaries.** `Post.where(...)` is callable from
   anywhere. Without an enforced boundary, a billing feature can silently
   mutate inventory models directly. Nothing catches this today — not the
   type system, not `guren check`, not code review conventions.
3. **Conventions without enforcement decay.** Teams (and AI coding agents)
   can be told "don't import module internals" in `CLAUDE.md` or a rules
   file, but prose rules are violated the moment they leave the context
   window. The lesson from large Rails codebases (Shopify's packwerk) and
   PHP (deptrac) is that boundaries hold only when a machine checks them
   on every change.

The third point matters doubly for Guren's positioning as an
agent-friendly framework: an AI agent's feedback loop is only as good as
what the tooling can verify. `guren check` and `guren audit` already
verify route/controller/page consistency and security posture; there is
no equivalent for architectural structure.

## Proposed Solution

Two features that share one set of conventions, shipped in dependency
order:

- **Part 1 — `guren check --arch`:** dependency-boundary verification
  driven by a `guren.arch.ts` config file. Standalone; no module system
  required. Ships first.
- **Part 2 — Application modules:** a `defineModule()` API plus a
  `modules/` directory convention that the CLI's discovery, generators,
  and arch checker all understand. When modules are present, boundary
  rules are derived automatically with zero configuration.

Both parts are purely additive. No existing API changes.

### Part 1: Architecture boundary checking

#### Rule definition: `guren.arch.ts`

A project-root config file, loaded by the CLI the same way
`config/database.ts` is loaded today (Bun import via the shared runtime
helpers):

```typescript
import { defineArchRules } from '@guren/cli/arch'

export default defineArchRules({
  layers: {
    domain: 'app/Domain/**',
    http: 'app/Http/**',
    models: 'app/Models/**',
  },
  rules: [
    // The domain layer must not depend on the HTTP layer.
    { from: 'domain', disallow: ['http'] },
    // Controllers may not import drizzle-orm directly; go through Models.
    { from: 'http', disallowPackages: ['drizzle-orm'] },
  ],
})
```

- `layers` maps a layer name to one or more globs (string or string
  array), matched against project-relative paths.
- `rules` entries support:
  - `from` — layer name (or inline glob) the rule applies to
  - `disallow` — layer names (or inline globs) that files in `from`
    must not import
  - `disallowPackages` — bare package specifiers that files in `from`
    must not import
  - `message` — optional custom suggestion shown on violation
  - `severity` — `'fail'` (default) or `'warn'`. Exists for gradual
    adoption: when introducing a new boundary into an existing
    codebase, teams start at `warn` to surface violations without
    breaking CI, then promote to `fail` once the count reaches zero
    (the rollout pattern packwerk validated with its
    `enforce_dependencies` levels).

This vocabulary is **frozen by design**. Anything that requires more
than classifying direct imports — transitive graph analysis, custom
module resolution, path rewriting, allow-list inheritance — is
permanently out of scope; users who need it should layer
dependency-cruiser on top. The ceiling is stated here so feature
requests can be answered by pointing at the RFC instead of relitigating
scope per issue.
- `defineArchRules` is an identity function providing types, exported
  from a new `@guren/cli/arch` subpath export. It lives in the CLI
  package (not `@guren/core`) because arch rules are a build-time
  concern with no runtime footprint — the same reasoning that keeps
  `drizzle.config.ts` importing from `drizzle-kit`.

#### Checker implementation

New `packages/cli/src/arch-check.ts`:

1. Discover source files under the configured layer globs (reusing
   `discovery.ts` walking utilities).
2. Parse each file with Babel (`@babel/parser`, already a CLI
   dependency via `model-parser.ts` / `page-props-extractor.ts`) and
   collect static `import` / `export ... from` specifiers.
3. Resolve specifiers to project-relative paths. Initial scope:
   relative imports and the `@/` alias (read from `tsconfig.json`
   paths). Dynamic `import()` with non-literal arguments and deep
   re-export chains are **not** followed.
4. Classify importer and importee into layers via glob matching and
   evaluate the rules.

Results are emitted as the existing `CheckResult` shape
(`packages/cli/src/check.ts`) and merged into the `guren check` report,
so `--json` output, exit codes, and the doctor integration work
unchanged.

**Severity policy:** a confirmed rule violation is `fail`. An import
specifier the resolver cannot resolve is `warn`, never `fail` — false
failures poison an AI agent's edit loop, so the checker must err toward
under-reporting with a visible warning rather than blocking on
uncertainty.

#### CLI surface

```bash
guren check              # existing checks + arch checks when config/modules exist
guren check --arch       # arch checks only (fast path for edit hooks)
guren check --changed    # restrict any checks to files changed vs the merge base
```

- Arch checks activate automatically when `guren.arch.ts` exists or a
  `modules/` directory exists (see Part 2). No flag needed for CI.
- `--changed` is a new shared option implemented in
  `packages/cli/src/changed-files.ts` (git diff against the merge base
  with `main`, falling back to `HEAD`), reusable by `guren audit`. It
  exists so the agent-harness `check-after-edit` hook can run per-edit
  without full-project scans.
- The agent harness template's `check-after-edit.ts` hook and the
  `dev-workflow` skill are updated to use `guren check --arch --changed`.

### Part 2: Application modules

#### Runtime API: `defineModule()`

Modeled directly on `definePlugin()`
(`packages/server/src/container/definePlugin.ts`) — a module is "a
plugin that lives inside your application and can register routes":

```typescript
// modules/billing/index.ts
import { defineModule } from '@guren/core'
import { registerBillingRoutes } from './routes'
import { BillingServiceProvider } from './providers/BillingServiceProvider'

export const billingModule = defineModule({
  name: 'billing',
  prefix: '/billing',              // URL prefix for all module routes
  routes: registerBillingRoutes,   // RouteRegistration (existing type)
  providers: [BillingServiceProvider],
})
```

```typescript
// src/app.ts
import { createApp } from '@guren/core'
import { billingModule } from '../modules/billing'

const app = createApp({
  routes: registerWebRoutes,
  providers: [/* ... */],
  modules: [billingModule],
})
```

Type sketch:

```typescript
export interface ModuleDefinition {
  /** Diagnostic name; also the expected directory name under modules/. */
  name: string
  /** URL prefix applied to all module routes via router.group(). */
  prefix?: string
  /** Route registrar, invoked after options.routes during boot. */
  routes?: RouteRegistration
  /** Providers appended to the application's provider list. */
  providers?: ServiceProviderConstructor[]
}

export function defineModule(definition: ModuleDefinition): GurenModule
```

`Application` gains an optional `modules?: GurenModule[]` option.
During boot it appends each module's providers to the provider list and
invokes each module's `routes` registrar after `options.routes`.
Internally this introduces **no new execution path** — modules decompose
into the existing provider and route-registration flows. `defineModule`
lives in `@guren/server` and is auto-exported from `@guren/core` via the
existing `export *`.

`prefix` is sugar over wrapping the registrar in
`router.group({ prefix })`, but it is deliberately declarative: tooling
(`guren context --scope`, the arch checker) can read a module's URL
surface statically without executing the registrar. **Route names are
not prefixed automatically** — name prefixing would ripple into the
generated `ApiRoutes` types in ways that are hard to scope, so module
authors name routes explicitly (e.g. `billing.invoices.index`).
Instead, `guren check` gains cross-module duplicate route-name
detection: a name collision breaks typed-route generation, so it is
guarded by detection rather than forced renaming.

Modules are listed explicitly rather than auto-discovered from the
filesystem, for the same reason providers are explicit on serverless
targets (auto-discovery requires Bun; explicit lists work everywhere,
including Lambda bundles).

#### Directory convention

A module mirrors the top-level application layout:

```
modules/
└── billing/
    ├── index.ts            # public API — the ONLY sanctioned cross-module import target
    ├── routes.ts
    ├── app/
    │   ├── Http/Controllers/
    │   ├── Models/
    │   └── Policies/
    ├── db/schema.ts
    └── tests/
```

**Pages are not colocated in the initial scope.** Inertia pages stay
under the top-level `resources/js/pages/`, namespaced by a module-named
subdirectory as an interim convention:

```
resources/js/pages/billing/Invoices/Index.tsx   → pages.billing.Invoices.Index
```

Colocation (`modules/billing/resources/js/pages/`) touches page-name
namespacing, the Vite glob, codegen scanning, and Inertia resolution —
too much risk to couple to the module system's first release. The
interim convention is forward-compatible: page names are already
path-derived, so a future colocation feature can generate identical
page names for `modules/billing/resources/js/pages/Invoices/Index.tsx`,
making the later migration a file move with no reference changes.

`packages/cli/src/discovery.ts` extends its walk roots to include
`modules/*/app/...`. Because `check`, `audit`, `context`, `model:list`,
and `doctor` all sit on top of `discovery.ts`, this single change makes
every existing agent command module-aware.

#### Generators

- **`guren make:module <name>`** scaffolds the directory skeleton, an
  `index.ts`, an empty route registrar, and patches two aggregation
  points using the existing `patch-helpers.ts` machinery:
  1. `db/schema.ts` gains `export * from '../modules/<name>/db/schema'`
  2. `src/app.ts` gains the module import and `modules: [...]` entry

  The schema aggregation stays a hand-visible re-export rather than a
  generated `db/schema.gen.ts` aggregator: a generated file would have
  to exist before drizzle-kit reads the schema, adding a codegen
  ordering dependency and a new failure mode ("migration is empty
  because codegen didn't run"). Since `make:module` maintains the
  re-export automatically, the manual cost is near zero. Coverage is
  machine-verified instead of machine-generated: `guren check` gains a
  check that every `modules/*/db/schema.ts` is re-exported from
  `db/schema.ts` (catching modules created by hand). This mirrors the
  RFC's overall stance — enforce conventions with checks rather than
  adding codegen surface.
- **All `make:*` generators gain `--module <name>`**, which only
  switches the output root from the project root to
  `modules/<name>/`. Template content is unchanged.
- Drizzle config templates are updated to document that `drizzle-kit`
  accepts a schema glob (`./db/schema.ts` plus
  `./modules/*/db/schema.ts`) for projects that prefer per-module
  migration generation over the re-export aggregation.

#### Derived boundary rules (zero-config)

When a `modules/` directory exists, the arch checker adds implicit
rules even if `guren.arch.ts` is absent:

1. A file inside `modules/<a>/` may not import from `modules/<b>/`
   **except** `modules/<b>/index.ts` (the module's public API).
2. Top-level application code may import any module's `index.ts` but
   not module internals.

Violations report as `fail` with the suggestion "import from
`modules/<b>` (its index.ts) or move the shared code into the module's
public API." Explicit `guren.arch.ts` rules compose with (never
replace) the derived rules; an `allow` escape hatch is deliberately
omitted from the initial scope to keep the contract simple.

### What this RFC does NOT cover

- **Codegen scaling** (per-module `.guren/` artifacts, incremental
  regeneration). Internal performance work with no public type changes;
  it follows as ordinary PRs once modules land. The public shapes of
  `ApiRoutes`, `PagePropsMap`, and the generated manifests are frozen
  regardless.
- **DDD preset for the agent harness** (`agent:init --preset ddd`).
  Additive template content that builds on `guren.arch.ts`; no API
  design required.
- **Extracting modules into packages.** A `modules/<name>/` directory
  intentionally shares the shape of a future workspace package, but
  package extraction tooling is out of scope.

## Alternatives Considered

**External dependency tools (dependency-cruiser, eslint-plugin-boundaries).**
Mature, but they require users to adopt and configure a separate
toolchain, their output does not integrate with `CheckReport`/`--json`,
and an ESLint-based approach assumes ESLint is present (Guren templates
do not ship it). Built-in checking keeps the zero-config promise for AI
agents and reuses the Babel infrastructure already in the CLI. The rule
vocabulary is deliberately small; teams needing full graph analysis can
still layer dependency-cruiser on top.

**Modules as workspace packages (npm/bun workspaces).** True package
boundaries are stronger, but they impose build orchestration, break the
`@/` alias ergonomics, complicate Drizzle schema aggregation, and make
`make:*` generators target-aware in invasive ways. The directory
convention gets 80% of the maintainability at near-zero adoption cost,
and does not preclude later extraction.

**Auto-discovering `modules/` at boot.** Less boilerplate, but it
reintroduces the Bun-only filesystem scanning problem that explicit
provider lists were chosen to avoid on Lambda, and it makes the
application's composition invisible to bundlers.

**TypeScript project references for boundary enforcement.** Compile-time
enforcement is attractive, but project references require per-module
tsconfigs, break the single-typecheck workflow, and produce notoriously
opaque errors — a poor fit for agent feedback loops.

## Migration Path

Purely additive; no breaking changes and no migration required.

- `@guren/server` minor release: `defineModule`, `modules` option.
- `@guren/cli` minor release: `check --arch`, `--changed`,
  `make:module`, `--module` flags, discovery extension.
- Existing flat applications continue to work unchanged. Adopting
  modules is incremental: `guren make:module billing`, move files,
  `guren check` verifies the result.

## Resolved Design Questions

Decisions folded into the proposal above, recorded here with their
rationale so discussion can challenge them directly:

1. **URL prefix: yes; route-name prefix: no.** `defineModule` accepts
   `prefix` (declarative, statically readable by tooling). Route-name
   prefixing is rejected for the initial scope because it ripples into
   generated `ApiRoutes` types; cross-module duplicate route-name
   detection in `guren check` guards the actual failure mode instead.
2. **Page colocation: deferred.** Ships after the module system, with
   the interim `resources/js/pages/<module>/` convention documented in
   `make:module`. Forward-compatible because page names are
   path-derived either way.
3. **Schema aggregation: hand-visible re-exports maintained by
   `make:module`, verified by `guren check`.** A generated aggregator
   was rejected to avoid a codegen-ordering dependency in the migration
   workflow.
4. **Rule vocabulary: frozen** at `layers` / `disallow` /
   `disallowPackages` / `message` / `severity`. Transitive analysis and
   custom resolution are permanently out of scope (use
   dependency-cruiser).

## Open Questions

1. **Page colocation design, when it lands.** The namespacing scheme
   (`modules/billing/resources/js/pages/Invoices/Index.tsx` →
   `pages.billing.Invoices.Index`) and the Vite glob/codegen changes
   need their own design pass; this RFC only fixes the compatibility
   constraint (generated page names must not change).
2. **Revisiting route-name prefixing.** If duplicate-name collisions
   turn out to be frequent in practice, an opt-in name prefix may be
   worth the type-generation complexity. Deferred until there is
   field evidence.
