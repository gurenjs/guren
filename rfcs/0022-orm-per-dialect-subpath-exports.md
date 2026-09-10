# RFC: Per-dialect subpath exports for `@guren/orm`

**Author:** 7nohe
**Date:** 2026-09-10
**Status:** Draft — recommendation: **reject the subpath split for now**,
revisit at the next planned `@guren/orm` major; the additive `workerd`
conditional root (Design B) is viable and is the maintainer's call (see
"Decision"). Written up because the measurement is the transferable part, and
it should not be repeated. Reviewed by Codex on 2026-09-10; its corrections and
the `workerd` alternative are folded in.

## Problem

`drizzle-orm` splits its drivers correctly: `drizzle-orm/bun-sqlite/driver.js`
holds the only static `import { Database } from "bun:sqlite"`, and
`drizzle-orm/d1` imports nothing runtime-specific. A graph that reaches only
`drizzle-orm/d1` cannot contain `bun:sqlite`.

`@guren/orm` undoes that split at its root barrel. `packages/orm/src/index.ts`
re-exports all five factories, and each factory holds a *literal* dynamic import
that reaches its client: `import('bun:sqlite')`, `import('postgres')`,
`import('mysql2')` directly, and `import('drizzle-orm/aws-data-api/pg')` whose
driver imports `@aws-sdk/client-rds-data` at module scope. A dynamic import is
still a graph edge: a bundler resolves the specifier whether or not the branch
can run. So an app that only ever calls `createD1Database()` still has every
client in its module graph, and a Workers bundle fails on the first one it
cannot resolve.

The mitigation today is stubbing, not avoidance: `DEV_ONLY_MODULES` and
`SQL_CLIENT_MODULES` in `packages/core/src/internal/deploy-build.ts`, applied as
`wrangler.jsonc` `alias` entries on Cloudflare and as `Bun.build` `onResolve`
plugins on Lambda and Vercel. On Cloudflare the alias list is baked into the app's committed
`wrangler.jsonc`, which the scaffold writes once and never overwrites; a stub the
build stops needing (or starts needing) is then a hand-edit nothing regenerates.
`@guren/plugin-cloudflare`'s CHANGELOG records the one case that bit
(the App MCP transport alias).

## Measurement

A D1-only worker, `@guren/orm` installed from a `bun pm pack` tarball into an
empty app (so resolution cannot walk into this repository's `node_modules`),
`postgres`/`mysql2`/`@aws-sdk` asserted absent, bundled with
`wrangler deploy --dry-run --outdir`. The subpath cases used a 55-line prototype:
`src/{postgres,mysql,sqlite,d1,aws-data-api}.ts` added as tsdown entries and
`./<dialect>` added to `exports`; `dist/d1.js` then imports only the shared
adapter chunk, never `dist/index.js`.

| Case | Worker imports | `alias` | Result | gzip |
|---|---|---|---|---|
| A | `createD1Database` from `@guren/orm` | all 5 stubs | ok | 45.5 KiB |
| B | same | none | **fails**: `bun:sqlite`, `postgres`, `mysql2`, `mysql2/promise`, `@aws-sdk/client-rds-data` | — |
| C | `createD1Database` from `@guren/orm/d1` | none | ok | 41.3 KiB |
| D | C **plus** `import { Model } from '@guren/orm'` | none | **fails**: the same five specifiers | — |
| E | D | all 5 stubs | ok | 54.5 KiB |
| F | D, with a `workerd` conditional root (Design B) | none | ok | 54.6 KiB |
| G | A, with the `workerd` root | all 5 stubs | ok | 41.3 KiB |

(Five specifiers, four client packages: `mysql2` and `mysql2/promise` are one.)

Four things follow.

1. **The split works in isolation** (C). The prototype is small and the build
   output has the right shape.
2. **Additive subpaths deliver nothing to a real app** (D). One value import of
   the root barrel re-merges the whole graph, and every Guren app makes that
   import without writing it: `@guren/core`'s explicit allowlist re-exports the
   five factories from `@guren/orm`, and `@guren/server`'s auth
   (`AuthenticatableModel.ts`) imports `Model` from the root barrel as a value.
   `defineModel` in the app's own models lands on the same barrel. So for the
   split alone, the stubs stay required until the factories *leave* the root
   barrel — a breaking change on `@guren/orm` *and* `@guren/core`. (A consumer
   that imports only `@guren/orm/d1` and never the root does gain; no Guren app
   is that consumer.)
3. **Size is not the payoff** (A vs C). The stubbed worker carries no client
   code at all — none of the stub text, no `postgres-js` or `mysql2` identifiers
   survive tree-shaking. The 4.2 KiB difference is barrel residue, not clients.
4. **A `workerd` conditional root avoids the stubs without a major** (F).
   wrangler resolves with the conditions `workerd`, `worker`, `browser`; pointing
   `exports["."].workerd` at a build of the barrel that keeps every export name
   but replaces the four non-D1 factories with shims removes all five edges for
   Workers while `@guren/core`'s re-exports keep linking. The same worker that
   fails in D bundles in F. Lambda and Vercel bundle with `Bun.build`, which does
   not select `workerd`, so their `unusedSqlClients` path is untouched — and it
   must stay, since there the client is load-bearing.

## Design A: per-dialect subpaths (the shape, if and when it is done)

Mirror drizzle's axis rather than invent a third one. `@guren/orm/drizzle/<dialect>`
is the *schema builder* barrel (drizzle's `<dialect>-core`); the factories are the
*driver* entries (drizzle's `d1`, `bun-sqlite`, `postgres-js`, `mysql2`,
`aws-data-api/pg`). Guren already names drivers by `DatabaseDialect`
(`'postgres' | 'mysql' | 'sqlite' | 'aws-data-api' | 'd1'`, the `--database`
vocabulary and the source file names), so:

```
@guren/orm/postgres      createPostgresDatabase, PostgresDatabase, PostgresDatabaseOptions, PostgresSeederContext
@guren/orm/mysql         createMySqlDatabase, …
@guren/orm/sqlite        createSqliteDatabase, …
@guren/orm/d1            createD1Database, D1DatabaseHandle, D1DatabaseOptions
@guren/orm/aws-data-api  createAwsDataApiDatabase, …
```

Each entry is the existing `src/<dialect>.ts`; `MigrationRunSummary` /
`MigrationStatusEntry` stay on the root. The full change, in release order:

1. **Minor (additive):** the five subpaths land; templates
   (`packages/create-app/templates/database/<driver>/config/database.ts`),
   `examples/*`, `web/config/database.ts` and the docs move to them. Bundles gain
   nothing yet, and the docs must say so — otherwise the subpath reads as a size
   fix that does not work. `DATABASE_FACTORIES` / `detectDatabaseDialects` keep
   working (they scan names, not specifiers).
2. **Deprecation window (≥ 2 minors, `contributing/deprecation-policy.md`):**
   `@deprecated` on the root re-exports, an entry in
   `packages/cli/src/deprecations.ts`, and a codemod in `codemods.ts` rewriting
   `import { createXDatabase } from '@guren/orm' | '@guren/core'` to the subpath.
3. **Major (`@guren/orm`, and therefore `@guren/core` — the allowlist is a value
   re-export, so `audit:core-semver`'s reasoning applies):** remove the five from
   both roots. Only now can `SQL_CLIENT_MODULES`, `unusedSqlClients`,
   `detectDatabaseDialects`, the `--database` flag, the `bun:sqlite` entry of
   `DEV_ONLY_MODULES`, four `wrangler.jsonc` aliases and four stub files be
   deleted, and the two `orm-bundle` probes rewritten to assert the *absence* of
   stubbing.

What does **not** go away at any step: the `vite`, `@guren/cli` and MCP SDK
stubs. The `alias` list in `wrangler.jsonc` therefore survives, and with it the
"hand-committed list nothing regenerates" failure class. The split shrinks that
list from nine entries to five; it does not remove the mechanism, and the guard
that actually catches a stale entry is the build's own check
(`cloudflare:build` failing on a transport alias the app no longer wants).

## Design B: a `workerd` conditional root

```jsonc
// packages/orm/package.json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "workerd": "./dist/index.workerd.js",
    "default": "./dist/index.js"
  }
}
```

`src/index.workerd.ts` re-exports everything `src/index.ts` does, from the same
modules, except that `createPostgresDatabase`, `createMySqlDatabase`,
`createSqliteDatabase` and `createAwsDataApiDatabase` are shims. The prototype
measured above threw at *call* time; the shipped shim must not: today's stub
throws only when an operation first imports the client, so construction, a
`closeDatabase()` before anything opened, and status paths that never load a
client all succeed. A config that constructs two handles at module scope and
picks at runtime (the `web/config/database.ts` shape, in the other order) must
keep working. So the shim preserves behaviour up to the first operation that
needs the client, then throws the message the stub carries now:
`UNAVAILABLE_ON_WORKERS.sqlite` for SQLite, `UNAVAILABLE_ON_WORKERS['sql-driver']`
for the other three. The workerd root keeps `import './instance-guard'` (the
prototype did) and `package.json#sideEffects` gains `./dist/index.workerd.js`,
or a bundler drops the guard; an export-name parity test cannot see either, so
the parity test also asserts the guard's marker is set.

What it buys, on Cloudflare only: `bun:sqlite` leaves `DEV_ONLY_MODULES`'s
Workers set and the four `SQL_CLIENT_MODULES` aliases go — five of the nine
`wrangler.jsonc` `alias` entries and five stub files. What it does not change:
`vite`, `@guren/cli` and the two MCP SDK entries stay, so the alias list and the
scaffold-once hazard stay; Lambda and Vercel keep `unusedSqlClients` because
their clients must be bundled. Apps that already committed the five aliases keep
working only if the build keeps writing the stub files they point at, so the
files stay for a deprecation window and the build reports the lines that can go
— the same mechanism as the App MCP transport alias.

Costs: a second root artifact to keep in parity with the barrel (a test that
diffs the two export-name sets), a runtime whose `createSqliteDatabase` is typed
as working (the `types` condition is shared) but is a shim, and one open
question below about the Vite SSR bundle. Roughly a day of work; no public API
change and no changeset above patch/minor.

## Alternatives Considered

- **Hide the edge instead of splitting** — a non-literal specifier
  (`import(clientName)`) so bundlers cannot follow it. Rejected: on Lambda and
  Vercel the client *must* be bundled (function directories ship without
  `node_modules`), so hiding the edge from every bundler breaks the load-bearing
  case to fix the dead one. Bundlers also warn on the pattern.
- **Keep the barrel, lazy-import the dialect module** —
  `createPostgresDatabase = (...) => import('./postgres.js').then(...)`. Rejected:
  `./postgres.js` is itself a literal edge to `postgres`; nothing changes.
- **Fold the factories into `@guren/orm/drizzle/<dialect>`.** Rejected: those
  barrels are the builder axis, imported by every `db/schema.ts`, including the
  D1 app's (`@guren/orm/drizzle/sqlite`). Putting `createSqliteDatabase` there
  would hand the D1 app the `bun:sqlite` edge through its schema file.
- **A compile-time constant** (`if (IS_WORKERS) … import('bun:sqlite')` folded by
  a `--define`) so the dead branch's import is never resolved. Works in esbuild,
  brittle across `Bun.build` and rolldown, and needs every bundler configured;
  Design B does the same job through resolution, which every bundler honours.
- **Route `@guren/core` / `@guren/server` internals through a factory-free entry
  (`@guren/orm/model`) while keeping the root barrel.** Insufficient on its own:
  the app's own `defineModel` import and core's allowlist re-export still reach
  the root. It becomes moot once the factories leave the root.

## Decision

**Design A: reject for now.** Its win arrives only at a coordinated major of
`@guren/orm` and `@guren/core`, after a two-minor deprecation window, and it
deletes roughly one module of stub machinery while leaving the alias mechanism
in place for the modules that are dev-only regardless of database. No such
major is planned, and shipping the additive half early adds five public entry
points that `contributing/api-stability.md` then has to honour while delivering
nothing a Guren app can observe. The strongest case for shipping it anyway: the
subpaths mirror stable source boundaries, and landing them early gives the
codemod a target well before the major instead of compressing that into the
release preceding it. That argument holds once a major is on the roadmap, not
before. When one is, step 1 above lands one minor ahead of it and this RFC
moves to Discussion with the measurement re-run.

**Design B: viable, additive, not decided here.** It is the measured route to
"avoidance rather than stubs" that needs no major (the compile-time constant
also needs none, but needs every bundler configured), and it is Workers-only by
construction. Whether five fewer alias lines and one fewer stub kind are worth a
second root artifact is the maintainer's call; this RFC records that it works
(case F) and what the shim must preserve.

Independently of this RFC: `cloudflare:build` never reads the app's dialect
today, so a `config/database.ts` that names only `createSqliteDatabase` bundles
clean and throws at the first request. `detectDatabaseDialects` already has the
answer; a warning belongs in the Workers build now, split or no split.

## Open Questions

None blocking the decision. For the eventual major:

- Should `@guren/core` re-export the subpaths at all (`@guren/core/orm/d1`?), or
  should apps import `@guren/orm/<dialect>` directly, the way `db/schema.ts`
  already imports `@guren/orm/drizzle/<dialect>`? `audit:core-first` forbids
  `@guren/server` references, not `@guren/orm` ones, and the templates already
  set the precedent for the direct import.
- Whether `instance-guard.ts` (the duplicate-copy warning, imported only by the
  root barrel) needs to run from the subpath entries as well. Today an app that
  reaches the root through `@guren/core` gets it anyway.
- For Design B: does the Vite SSR bundle `cloudflare:build` produces ever inline
  `@guren/orm`'s root? Vite resolves with its own `resolve.conditions`, not
  wrangler's, so a page graph that reached the ORM would carry the default root,
  edges and all, into a file wrangler then bundles. Page components import
  resource *types* today, which erase; the check is a grep of the SSR output for
  `bun:sqlite`. The fix would be `ssr.resolve.conditions` (Vite 8's SSR
  environment setting, not the client `resolve.conditions`), and only in the
  Cloudflare build: the Lambda and Vercel SSR builds must not see the shims.
