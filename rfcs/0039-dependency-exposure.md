# RFC: Dependency Exposure and Supply-Chain Defaults

**Author:** Guren contributors
**Date:** 2026-11-03
**Status:** Draft

## Problem

When an advisory for a package lands, the person on call needs three answers
quickly: does the app ship the affected version, which features does it reach,
and what change removes it. Guren answers the first one today and nothing else.

`guren audit` runs `bun audit --json` and turns each advisory into a finding
(`packages/cli/src/audit-deps.ts`). The advisory carries `url`, `title`,
`severity` and `vulnerable_versions`. It does not say which direct dependency
pulled the package in, whether the package runs on the server, in the browser
bundle or only at build time, or which routes import it. Most advisories hit a
transitive package, so the finding names something the app never imports.

Three related gaps sit next to this one:

- **Fresh releases are where compromised packages land.** A malicious publish
  is usually found and yanked within hours to days. A scaffolded app installs
  whatever is newest the moment `bun add` runs, and an agent runs `bun add`
  more often than a person does. No template sets Bun's release-age gate.
- **The runtime is invisible.** `bun audit` reports npm packages. A Bun
  advisory appears in neither the lockfile nor the audit, though the
  Dockerfile `guren deploy` renders pins only `oven/bun:1`. The three Bun
  advisories published in October 2026 are not in the global advisory
  database either (§6).
- **Data exposure has no report.** `hidden` columns are dropped by
  `Model.serialize()` and by `auth.user()` (the session guard sanitizes the
  user), and the blog example renders posts through Resources. A record from
  `Model.find()` is the adapter's row after casts and accessors, with nothing
  dropped (read from `packages/orm/src/Model.ts`), so a controller that passes
  one straight to `this.inertia()` sends every column. The shipped code avoids
  that; nothing reports it when application code does not, and no command says
  which columns reach which responses.

Nyxis (github.com/NyxFoundation/nyxis) approaches the last gap from the other
end: handlers can only call actions on an authorization layer, and a Lean proof
shows no request sequence reads beyond a principal's permissions. Guren
controllers are arbitrary TypeScript, so that proof is out of reach. Two of its
practices transfer: an explicit list of what the guarantee trusts rather than
checks (its `ASSUMPTIONS.md`), and confining effects to declared boundaries,
which Guren can approach only as conventions on direct imports (§8).

### Existing implementation to reuse

| Capability | Source | Use here |
| --- | --- | --- |
| Advisory scan | `audit-deps.ts` (`bun audit --json`, `unavailable` never a pass) | Input to the exposure report |
| Bare specifier to package name | `arch-check.ts` (`isBareSpecifier`, `packageNameFromSpecifier`, private) | Moves to `import-resolution.ts` as the one rule |
| Relative and `@/` import resolution | `import-resolution.ts` (`resolveImportPath`) | Follows app-internal imports to their packages |
| Package import bans | `guren.arch.ts` `disallowPackages` | Direct-import conventions (§8) |
| Application Graph v1 | RFC 0032, `application-graph.ts` | Nodes and routes the exposure joins onto |
| Column reads | `column-consumers.ts` (controllers, resources, pages) | Data exposure (§7) |
| Route authorization on the chain | `authorization-audit.ts` (`chainAuthorizes`) | Data exposure verdicts |
| Reading installed packages' JS | `csrf-exemption-audit.ts` | Precedent for scanning `node_modules` with partial coverage |
| Template dependency generation | `scripts/sync-template-deps.ts`, `audit:template-deps` | Cooldown exclusion list (§2) |

## Proposed Solution

### 1. Scope and delivery order

| Milestone | Delivers |
| --- | --- |
| M1 | Cooldown defaults in scaffolds; `guren doctor` and `guren upgrade` for existing apps (§2) |
| M2 | Lockfile dependency tree and `guren deps:why` (§3) |
| M3 | Import edges, placement and `guren deps:exposure`; advisory findings carry exposure and a fix path (§4, §5) |
| M4 | Runtime advisory check against `oven-sh/bun`'s repository advisories (§6) |
| M5 | Data exposure and the direct-import conventions (§7, §8) |
| M6 | Trust boundary section in every report (§9) |

M3 ships the coverage, attribution and snapshot fields with the first exposure
output; M6 only adds the summary section built from them.

M1 stands alone and can ship before the rest is accepted, since it changes only
scaffold output and two advisory checks.

### 2. Cooldown defaults

Bun filters versions published more recently than `install.minimumReleaseAge`
(seconds) during resolution, for direct and transitive dependencies alike. It
affects only new resolution; entries already in `bun.lock` stay as they are.
`minimumReleaseAgeExcludes` exempts a package by name (every version) or by
`name@version` (that version only). Source: the bunfig and `bun install` pages
of the Bun docs, read 2026-11-03.

Measured on Bun 1.4.4 in a scratch app outside the workspace, with
`minimumReleaseAge = 259200`:

| Dependency and exclusions | Result |
| --- | --- |
| `@guren/core: "1.26.0"` (published the day before), no exclusions | `bun install` exits 1: `No version matching "1.26.0" … (blocked by minimum-release-age)` |
| same, excluding `@guren/core` | exits 1 on the transitive `@guren/server@^2.34.0` and `@guren/cli@^2.35.0` |
| same, excluding `"@guren/*"` | exits 1 as in the first row: a scope pattern is not honoured |
| same, excluding `@guren/core`, `@guren/server`, `@guren/cli`, `@guren/orm` | installs core 1.26.0, server 2.35.0, cli 2.35.1 |
| `@guren/core: "^1.24.0"`, no exclusions | installs, falling back to core 1.25.0 and server 2.31.1 |

So the gate fails an install whose range only young versions satisfy, applies
to transitive packages, and takes exact names only.

Every create-app template gains a `bunfig.toml`:

```toml
[install]
# 3 days. Patched versions younger than this need an explicit exclusion; see
# `guren audit`'s fix path.
minimumReleaseAge = 259200
minimumReleaseAgeExcludes = [
  "@guren/cli",
  "@guren/core",
  "@guren/inertia-client",
  "@guren/orm",
  "@guren/server",
  "@guren/testing",
]
```

The template ranges are written at `changeset version` to the version being
released, so without exclusions `create-guren-app` fails to install for three
days after every release, as the first row shows. `smoke:starter:npm` and
`guren upgrade` stall the same way. The list is the closure of `@guren/*`
packages reachable from the template's dependencies in the release being cut
(the default template's is above; `@guren/server` arrives through
`@guren/core`, and the api-only template has no `@guren/inertia-client`). An
exact name per package is required, since the scope pattern does nothing.
`sync:template-deps` writes the list from the same manifest read that writes
the ranges, and `audit:template-deps` fails CI when they disagree.

Excluding them means a compromised `@guren/*` publish is not delayed; that risk
sits with the release process (provenance, 2FA), not with each app.

The exact `drizzle-orm` and `drizzle-kit` pins hit the same wall: a release that
adopts a drizzle version younger than the gate scaffolds apps that cannot
install. `sync:template-deps` refuses such a pin by reading the version's
publish time from the registry (the pin today, `1.0.0-rc.4`, was published on
2026-06-27).

The gate also delays the fix for an advisory. §5 handles that by naming the
exact `name@version` exclusion, never by turning the gate off.

For existing apps:

- `guren doctor` reports `supply-chain-cooldown` (advisory) when the app's
  `bunfig.toml` sets no `minimumReleaseAge`. A value of `0` is the author's
  choice and passes.
- `guren upgrade` offers to add the block, as it does for other configuration
  autofixes. `guren doctor --fix` stays limited to generated files.
- An app's exclusion list is the closure of the first-party packages it
  installs, which grows past the template's set once it adds a plugin. `guren
  upgrade` (which moves every installed `@guren/*` dependency), `guren add` and
  `guren plugin` rewrite the list from the installed manifests, and
  `supply-chain-cooldown` reports a first-party package missing from it.

The Renovate `minimumReleaseAge` and Dependabot `cooldown` settings govern bot
PRs only. The bunfig gate also covers `bun add` from a person or an agent, so
it is the default; the docs recommend setting both.

### 3. Dependency tree

`packages/cli/src/dependency-tree.ts`, pure: `readBunLock(text)` parses the
text lockfile (`lockfileVersion: 1`, JSON with trailing commas) and
`dependencyTree(lock, appWorkspace)` returns one entry per installed package
instance, since one package can be installed at several versions:

```ts
interface DependencyTree {
  coverage: Coverage                 // RFC 0032's shape
  packages: Array<{
    id: string                       // `${name}@${version}`
    name: string
    version: string
    integrity?: string               // the lockfile's sha512
    direct: boolean
    depth: number                    // 0 for a direct dependency
    paths: Record<string, string[]>  // per direct dependency: one shortest path to this instance
    declaredAs: Array<'prod' | 'dev' | 'optional' | 'peer'>
    installedInProduction: boolean   // reachable from `dependencies` or `optionalDependencies`
  }>
}
```

`declaredAs` and `installedInProduction` describe the manifest and
`bun install --production` only. They say nothing about what the build ships:
a dev-only package a page imports is bundled into `public/` and reaches the
browser through the production image all the same, which is why §4 judges
placement from imports and the build output, never from `declaredAs`. In a
workspace, the app's own entry under `workspaces` is the root. A binary
`bun.lockb` or a missing lockfile is `unavailable` with its reason, never an
empty tree.

`guren deps:why <name> [--json]` prints every installed instance of the
package and, for each, its path from every direct dependency.

### 4. Import edges and placement

`guren deps:exposure [--json] [--package <name>]` emits a document of its own
rather than new graph kinds:

```ts
interface DependencyExposure {
  schemaVersion: 1
  snapshot: { id: string; graph: string; capturedAt: string; consistency: 'stable' | 'changed' }
  coverage: Record<'tree' | 'imports' | 'placement' | 'graph' | 'runtime', Coverage>
  packages: Array<{
    id: string                       // the DependencyTree instance
    placement: Array<{
      at: 'server' | 'client' | 'ssr' | 'build' | 'test'
      evidence: 'import' | 'build-manifest'
    }>
    attribution: 'routes' | 'framework' | 'none-found' | 'unknown'
    note?: string
    importedBy: Array<{
      file: string
      line: number
      chain: string[]                // app files from a graph node's file to the import
      nodes: Array<{ node: string; relation: string }>
    }>
    routes: Array<{ node: string; method: string; path: string; name?: string; authentication?: 'required' | 'guest-only' }>
  }>
  runtime: Array<{ source: 'process' | 'engines' | 'packageManager' | 'dockerfile'; value: string; exact: boolean }>
}
```

`attribution` is what an empty `routes` means: `framework` for a package only
the framework pulls in, `none-found` when every reader that could have found an
import ran to completion and found none, and `unknown` when a reader limit in
`coverage` could hide one.

The reader:

- Collects runtime bare specifiers from app source by AST: static `import`,
  `export … from`, and `import()` with a literal argument. Type-only imports are
  skipped. `node:` and `bun:` specifiers are listed under the runtime (§6), not
  as packages.
- Marks `imports` partial, naming the file, for each construct it cannot
  follow: a non-literal `import()`, `require()`, `new Worker()` or
  `import.meta.glob()`, a relative or `@/` import that does not resolve, and a
  file that does not parse.
- Maps a specifier to its package through `packageNameFromSpecifier`, moved out
  of `arch-check.ts` into `import-resolution.ts` so both readers share it.
- Follows relative and `@/` imports with `resolveImportPath`, so a package a
  service imports is attributed to every graph node file that reaches the
  service. `chain` records the files between.
- Joins those files to graph nodes by `file`, then to routes along every
  relation the graph has: a controller through `handles`, a page through
  `renders`, middleware through `usesMiddleware`, a model through `binds` and
  through the controllers whose files reach it, a policy through `authorizes`
  to the controller action and on through `handles`, a validator through
  `validates` (a route's contract directly, a controller's through `handles`).
  The relation each node was reached by is kept. An `unresolved` graph entry on
  the way makes the package `unknown` rather than dropping the route.
  `authentication` is copied from the route node.

Placement comes from where the importing file sits: `server` for anything the
server entry reaches (controllers, models, middleware, policies, validators,
routes, config, providers), `client` for `resources/js/`, `ssr` for a client
file in the SSR entry's reach, `build` for `vite.config.ts`, `drizzle.config.ts`
and `scripts/`, `test` for `tests/` and `*.test.ts`. When a client build
exists, the Vite build manifest confirms `client` with `evidence:
'build-manifest'`, its own source rather than RFC 0032's `registered`, which
means an introspected registration.

A package that only `@guren/*` (or another framework package) pulls in has
`attribution: 'framework'`. hono and drizzle-orm reach every route, so these
are reported once with a note, never spread over each route.

The tree, the import scan and the graph are read as one snapshot, as RFC 0032
requires of the graph alone: the lockfile, every `package.json` read, and each
scanned source file are fingerprinted before and after collection, together
with the graph's own fingerprints. A change between the two readings makes
`consistency: 'changed'`. Exit codes follow `guren graph`: 0 for a complete,
stable snapshot, 1 with the partial document for incomplete coverage or a
changed snapshot, and 1 with a versioned error object when nothing could be
collected.

The names say what was read. `importedBy` means an import exists on a path
from that file; it does not mean the vulnerable function runs. Following RFC
0032, nothing here becomes a pass or fail.

### 5. Advisory findings with exposure and a fix path

`audit-deps.ts` keeps the structured advisories it parses today and drops after
deduplication: `bun audit` lists one entry per affected range, and the finding
keeps only the first. The ranges of one GHSA are unioned before anything below
uses them. The audit report gains, at report level:

```ts
dependencyExposure?: {
  snapshot: DependencyExposure['snapshot']
  coverage: DependencyExposure['coverage']
}
```

and each `deps:*` finding gains:

```ts
advisory: { ghsa: string; ranges: string[] }           // every affected range
exposures: Array<DependencyExposure['packages'][number]> // every installed instance in any range
fix?: {
  status: 'verified' | 'candidate' | 'unavailable'
  reason?: string
  steps: Array<
    | { kind: 'update'; package: string; to: string }
    | { kind: 'override'; package: string; to: string; note: string }
    | { kind: 'cooldown-exclude'; entry: string; publishedAt: string }
  >
}
```

The severity stays what `bun audit` reported. A fix is proposed from the npm
registry packument (`versions`, `time`, each version's dependency ranges),
under the scan's timeout:

1. For a direct instance, `update` to the newest version outside the union of
   ranges.
2. For a transitive instance, `update` along each of its `paths` the nearest
   dependency whose newer release no longer admits an affected version on that
   path.
3. Where no release does, `override`, with a note that Bun's `overrides`
   replace the range and do not move a peer the lockfile has already resolved
   (#1154 hit this).

A proposal is only a `candidate` until it is checked. The check copies the
app's manifest, lockfile and `bunfig.toml` to a temporary directory, applies
the steps, and runs `bun install --lockfile-only` there. The fix is `verified`
when the resulting lockfile has no instance of the package inside the union of
ranges. The copied `bunfig.toml` keeps the app's `minimumReleaseAge`, so a
step that needs a version younger than the gate, whether the patched package,
a parent being updated or a new intermediate package, fails the resolution;
each blocked version becomes a `cooldown-exclude` step with its exact
`name@version`, and the resolution runs again. Bun's own stability filter
(which can push resolution past a version the age alone would allow) is
covered the same way, because the check resolves with Bun rather than
predicting Bun. A registry that does not answer, a missing publish time, or a
resolution that fails for another reason leaves the fix `candidate` or
`unavailable` with the reason, never a guessed version.

The text report prints the routes, the attribution and the steps under each
advisory, and the report's coverage beside them.

The development MCP server gains `guren_get_dependency_exposure`, read-only,
with the same bounded output rule as `guren_get_application_graph`.

`guren audit` fails today only on a `fail` finding, and `bun audit` low and
moderate advisories are warnings, so a scheduled run of the plain command does
not fail on every advisory. The scheduled check gets its own flag:
`guren audit --deps-baseline <file>` exits 1 when a `deps:*` finding key is
absent from the baseline file (a previous run's JSON, or one the app commits),
and exits 1 with its own message when the dependency scan is `unavailable`, so
a registry outage is never read as "nothing new". The docs add a scheduled
workflow around it, so a disclosure is noticed the day it is published rather
than at the next deploy.

### 6. Runtime version

`guren deps:exposure` and `guren audit` check the runtime they can see: the
`Bun.version` of the process, `engines.bun` and `packageManager` from
`package.json`, and the base image tags in the app's `Dockerfile`.

Each version is checked against the repository advisories of `oven-sh/bun`
(`GET /repos/oven-sh/bun/security-advisories`), the only source that was
current when queried on 2026-11-03:

| Source | What it returned |
| --- | --- |
| `oven-sh/bun` repository advisories | 3 high advisories published 2026-10-23 and 24, each with `npm/bun` `vulnerable_version_range` (for example `>= 1.0.21, < 1.4.4`) and `patched_versions` `1.4.4` |
| GitHub global advisory database (`ecosystem=npm&affects=bun`) | 2 older advisories, one withdrawn; the 3 above return 404 |
| OSV.dev (`npm/bun`) | the same 2 as the global database |
| NVD keyword search | none |

`bun audit` and OSV read the global database, which had not picked up the
repository's advisories, so the runtime check reads the repository directly.
A version matches when `Bun.semver.satisfies(version, vulnerable_version_range)`
holds, and the finding (`deps:runtime:<ghsa>`) names `patched_versions` as the
fix. An image tag that names no exact version (`oven/bun:1`) is reported as
unpinned rather than matched. The endpoint answers without a token at 60
requests an hour; CI passes `GITHUB_TOKEN`. A request that fails makes
`coverage.runtime` `unavailable` with the reason, never a clean result.

The advisories above are relevant to Guren's own support range: 1.3.x is
best-effort, every 1.3.x release falls inside two of the three ranges, and
1.3.14 and later inside all three.

The Dockerfile `guren deploy` renders has two stages, `oven/bun:1` for the
builder and `oven/bun:1-slim` for production. Both move to the exact version of
the Bun running the command (`oven/bun:1.4.4` and `oven/bun:1.4.4-slim`), so the
runtime check can match them and a rebuild does not pick up another release.

A tag can still be re-pushed, so each reference also carries the digest of the
tag's multi-platform image index, read from Docker Hub when `guren deploy`
runs:

```dockerfile
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
```

Measured on 2026-11-03: an anonymous token from `auth.docker.io` and a
manifest request to `registry-1.docker.io` with the OCI index media type
return `application/vnd.oci.image.index.v1+json` and the
`Docker-Content-Digest` above, listing `linux/amd64` and `linux/arm64`. The
index digest is the one to pin, never a platform manifest's, or an arm64
build machine and an amd64 host would disagree. Docker resolves by digest and
keeps the tag for people to read; the runtime check reads the tag part.

When the registry does not answer, `guren deploy` writes the exact tag alone
and prints that the digest is missing, rather than failing the command. The
runtime check reports a tag without a digest as unpinned, as it does a tag
without an exact version. Moving to a newer Bun means running `guren deploy`
again, or letting Renovate (`pinDigests`) update the reference. The templates set no `engines.bun` today, so the report usually
shows only the process version and the image tags.

### 7. Data exposure

`guren audit` gains a column section. It starts from response sinks, not from
models: every props value passed to `this.inertia()`, every argument to
`this.json()`, and each Resource's `toArray()`. For each value the reader
records which model's columns it carries, using `column-consumers.ts` where
that reader identifies a record, and records the value as `unknown`, with its
expression and line, where it does not (`this.json(await service.loadUser())`).
`column-consumers.ts` finds property reads today; this RFC extends it to a
whole record passed as a value.

- A whole record passed to a sink carries every column.
- A value passed through `Model.serialize()` or `serializeMany()` carries the
  model's effective output columns: the `visible` list when it is non-empty
  (it takes precedence over `hidden`, `packages/orm/src/serialization.ts`),
  otherwise every column minus `hidden`, plus `appends`.
- A value from `auth.user()` carries the record minus the credential and
  `hidden` columns only when the introspected `auth` section reports the bound
  provider as the model provider (`ModelUserProvider.sanitize()` strips them).
  A custom provider may not implement `sanitize()`, and a provider bound only
  in `boot()` is past what introspection runs, so in both cases the user is
  `unknown`.
  The provenance is followed through aliases and destructuring, never inferred
  from a TypeScript type.
- A column is sensitive when the model lists it in `hidden`, or its name
  matches `password`, `token`, `secret`, `hash`, `apiKey` or `otp`
  (case-insensitive, as whole camelCase or snake_case segments).
- A sensitive column reaching a sink is `exposure-sensitive-column`, an
  advisory warn naming the action, the route and whether the chain authorizes
  (`chainAuthorizes`). An `unknown` value is listed as unread, never as safe.

This is an audit rule over its own static reader, not a verdict drawn from
graph edges. Against `examples/blog`, `DashboardController` passes
`auth.user()` straight to Inertia; the blog binds the model provider with
`auth.useModel()` in its `AuthProvider.register()`, so the rule reports nothing
there.

### 8. Direct-import conventions

No template ships a `guren.arch.ts` today. The templates gain one with two
rules using `disallowPackages`:

```ts
{ from: 'resources/js/**', disallowPackages: ['drizzle-orm', 'postgres', 'mysql2', '@guren/orm', '@guren/core', '@guren/server'], message: 'Pages run in the browser; load data in the controller and pass it as props.' },
{ from: 'app/Http/Controllers/**', disallowPackages: ['drizzle-orm'], severity: 'warn', message: 'Query through a Model, or move the raw query out of the controller.' },
```

These are conventions on direct imports, not an effect boundary. The arch check
reads a file's own runtime imports: it follows no app-local wrapper and no
dynamic `import()` (`packages/cli/src/arch/index.ts`), so a page can still reach
database code through a local module. Going through a Model does not by itself
hide columns or authorize a request either; §7 and `authorization-audit.ts` are
what report those. What the rules buy is that the common direct paths show up
in `guren check`, and so in `guren gate`. Nyxis gets the stronger guarantee
because its handlers cannot perform IO at all; an equivalent here would need
transitive checking through local modules and the `@guren/core` facade, which
this RFC does not propose.

No template controller and no `make:*` generator imports `drizzle-orm`, and no
template or blog page imports `@guren/core` or `@guren/server` at runtime, so
neither rule fires on scaffold output. The second rule is a warn because a raw
query is sometimes the right call.

### 9. Trust boundary

Every `deps:exposure` and audit report ends with a section listing what its
results rest on without checking:

- the runtime advisories, read from `oven-sh/bun`'s repository only (§6), and
  an image tag that names no exact version;
- packages carried by the framework, attributed to no route;
- each reader's limits that applied in this run (the constructs §4 marks
  partial, the response values §7 leaves `unknown`, graph entries left
  `unresolved`);
- fixes left as a `candidate` because the resolution check could not run;
- the lockfile's integrity hashes, which Bun checks at install, not Guren.

The list is generated from the run's `coverage` entries, so it cannot claim a
check the run did not make. Whether apps also commit it as a document is Open
Question 4.

## Alternatives Considered

**A `package` node kind in Application Graph v1.** `kind` is a closed enum and
`schemaVersion` is the literal `1`, so a strict consumer rejects a new kind,
and RFC 0032 keeps security verdicts out of graph edges. A separate document
keyed by the graph snapshot id leaves v1 untouched and lets packages move into
a v2 graph later if consumers want them there.

**An SBOM export only (CycloneDX or SPDX).** Standard tools such as
Dependency-Track match advisories against an SBOM well, but an SBOM knows
packages, not routes or pages. An SBOM export with the exposure as component
properties is a reasonable follow-on; it does not replace the join.

**Runtime tracing of loaded modules per request.** It would show code that
actually ran, but needs production instrumentation Bun does not offer per
request, and misses code paths the traffic did not take.

**Function-level reachability.** Commercial tools trace calls into the
vulnerable function. That needs the vulnerable symbols, which most GHSA records
do not carry, and full type information across `node_modules`. Out of scope.

**Formal verification in the style of Nyxis.** The proof depends on handlers
that cannot do IO. Guren would need a restricted handler language, which is a
different framework. §8 and §9 take what transfers.

## Migration Path

Additive. Existing apps are unchanged until they opt in: `guren doctor` reports
the missing cooldown and `guren upgrade` offers to write it. Graph v1 and the
existing `deps:*` finding keys are unchanged; the new fields are optional.

## Open Questions

1. Should `@guren/*` stay excluded from the cooldown (§2), or should the release
   train publish and wait three days before the templates reference it?
2. Three days or seven for the default age?
3. Should the runtime check also read the global database once it catches up,
   in case Bun files an advisory there and not in the repository? The two
   have disagreed only in the repository's favour so far.
4. Should the trust boundary section also be written to `docs/spec/`? It would
   be drift-gated there, and every dependency bump would touch it.
5. Is a name list the right default for sensitive columns, or should a schema
   annotation be required?
6. Which Bun release introduced `minimumReleaseAge`, and does an older Bun
   ignore the key or fail on it? Only 1.4.4 was measured.
7. Does `bun install --lockfile-only` apply `minimumReleaseAge` and the
   stability filter exactly as a full install does? §5's fix check relies on
   it; it has not been measured.
