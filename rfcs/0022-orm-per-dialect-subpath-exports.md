# RFC: Per-dialect subpath exports for `@guren/orm`

**Author:** 7nohe
**Date:** 2026-09-10
**Status:** Draft — recommendation: **Reject for now**, revisit at the next
planned `@guren/orm` major (see "Decision"). Written up because the measurement
is the transferable part, and it should not be repeated.

## Problem

`drizzle-orm` splits its drivers correctly: `drizzle-orm/bun-sqlite/driver.js`
holds the only static `import { Database } from "bun:sqlite"`, and
`drizzle-orm/d1` imports nothing runtime-specific. A graph that reaches only
`drizzle-orm/d1` cannot contain `bun:sqlite`.

`@guren/orm` undoes that split at its root barrel. `packages/orm/src/index.ts`
re-exports all five factories, and each factory holds a *literal* dynamic import
of its client (`await import('bun:sqlite')`, `import('postgres')`, `import('mysql2')`,
`import('@aws-sdk/client-rds-data')`). A dynamic import is still a graph edge: a
bundler resolves the specifier whether or not the branch can run. So an app that
only ever calls `createD1Database()` still has every client in its module graph,
and a Workers bundle fails on the first one it cannot resolve.

The mitigation today is stubbing, not avoidance: `DEV_ONLY_MODULES` and
`SQL_CLIENT_MODULES` in `packages/core/src/internal/deploy-build.ts`, applied as
`wrangler.jsonc` `alias` entries on Cloudflare and as esbuild `onResolve` stubs on
Lambda and Vercel. On Cloudflare the alias list is baked into the app's committed
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
| D | C **plus** `import { Model } from '@guren/orm'` | none | **fails**: the same five | — |
| E | D | all 5 stubs | ok | 54.5 KiB |

Three things follow.

1. **The split works in isolation** (C). The prototype is small and the build
   output has the right shape.
2. **Additive subpaths deliver nothing to a real app** (D). One value import of
   the root barrel re-merges the whole graph, and every Guren app makes that
   import without writing it: `@guren/core`'s explicit allowlist re-exports the
   five factories from `@guren/orm`, and `@guren/server`'s auth
   (`AuthenticatableModel.ts`) imports `Model` from the root barrel as a value.
   `defineModel` in the app's own models lands on the same barrel. So the stubs
   stay required until the factories *leave* the root barrel — a breaking change
   on `@guren/orm` *and* `@guren/core`.
3. **Size is not the payoff** (A vs C). The stubbed worker carries no client
   code at all — none of the stub text, no `postgres-js` or `mysql2` identifiers
   survive tree-shaking. The 4.2 KiB difference is barrel residue, not clients.

## Proposed Solution (the shape, if and when it is done)

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
- **Route `@guren/core` / `@guren/server` internals through a factory-free entry
  (`@guren/orm/model`) while keeping the root barrel.** Insufficient on its own:
  the app's own `defineModel` import and core's allowlist re-export still reach
  the root. It becomes moot once the factories leave the root.

## Decision

Reject for now. The win is real but arrives only at a coordinated major of
`@guren/orm` and `@guren/core`, after a two-minor deprecation window, and it
deletes roughly one module of stub machinery while leaving the alias mechanism in
place for the modules that are dev-only regardless of database. No such major is
planned, and shipping the additive half early adds five public entry points that
`contributing/api-stability.md` then has to honour while delivering nothing a
user can observe.

When an `@guren/orm` major *is* planned, step 1 above should land one minor
before it so the codemod has a target, and this RFC moves to Discussion with the
measurement re-run against that release.

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
