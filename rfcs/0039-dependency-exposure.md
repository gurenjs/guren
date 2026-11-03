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
  Dockerfile `guren deploy` renders pins only `oven/bun:1`.
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
checks (its `ASSUMPTIONS.md`), and confining effects to declared boundaries.

### Existing implementation to reuse

| Capability | Source | Use here |
| --- | --- | --- |
| Advisory scan | `audit-deps.ts` (`bun audit --json`, `unavailable` never a pass) | Input to the exposure report |
| Bare specifier to package name | `arch-check.ts` (`isBareSpecifier`, `packageNameFromSpecifier`, private) | Moves to `import-resolution.ts` as the one rule |
| Relative and `@/` import resolution | `import-resolution.ts` (`resolveImportPath`) | Follows app-internal imports to their packages |
| Package import bans | `guren.arch.ts` `disallowPackages` | Effect boundary presets (§8) |
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
| M4 | Runtime version report (§6) |
| M5 | Data exposure and the effect boundary presets (§7, §8) |
| M6 | Trust boundary section in every report (§9) |

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

The Renovate `minimumReleaseAge` and Dependabot `cooldown` settings govern bot
PRs only. The bunfig gate also covers `bun add` from a person or an agent, so
it is the default; the docs recommend setting both.

### 3. Dependency tree

`packages/cli/src/dependency-tree.ts`, pure: `readBunLock(text)` parses the
text lockfile (`lockfileVersion: 1`, JSON with trailing commas) and
`dependencyTree(lock, appWorkspace)` returns:

```ts
interface DependencyTree {
  coverage: Coverage                 // RFC 0032's shape
  packages: Array<{
    name: string
    version: string
    integrity?: string               // the lockfile's sha512
    direct: boolean
    depth: number                    // 0 for a direct dependency
    via: string[]                    // direct dependencies it is reachable through
    path: string[]                   // one shortest path, direct dependency first
    scopes: Array<'prod' | 'dev' | 'optional' | 'peer'>
  }>
}
```

A package reachable only through `devDependencies` is `dev`, and the production
image (`bun install --production`) does not contain it. In a workspace, the
app's own entry under `workspaces` is the root. A binary `bun.lockb` or a
missing lockfile is `unavailable` with its reason, never an empty tree.

`guren deps:why <name> [--json]` prints the tree for one package: its
versions, every `via`, and one path per direct dependency.

### 4. Import edges and placement

`guren deps:exposure [--json] [--package <name>]` emits a document of its own
rather than new graph kinds:

```ts
interface DependencyExposure {
  schemaVersion: 1
  graphSnapshot: string              // the RFC 0032 snapshot id it joined
  coverage: Record<'tree' | 'imports' | 'placement' | 'graph', Coverage>
  packages: Array<{
    name: string
    version: string
    via: string[]
    placement: Array<'server' | 'client' | 'ssr' | 'build' | 'test'>
    carrier: 'app' | 'framework'
    importedBy: Array<{
      file: string
      line: number
      chain: string[]                // app files from a graph node's file to the import
      nodes: string[]                // RFC 0032 node ids reaching this file
    }>
    routes: Array<{ node: string; method: string; path: string; name?: string; authentication?: 'required' | 'guest-only' }>
  }>
}
```

The reader:

- Collects runtime bare specifiers from app source by AST: static `import`,
  `export … from`, and `import()` with a literal argument. Type-only imports are
  skipped. A non-literal `import()` makes `imports` partial with the file named.
  `node:` and `bun:` specifiers are listed under the runtime (§6), not as
  packages.
- Maps a specifier to its package through `packageNameFromSpecifier`, moved out
  of `arch-check.ts` into `import-resolution.ts` so both readers share it.
- Follows relative and `@/` imports with `resolveImportPath`, so a package a
  service imports is attributed to every controller, model, page, middleware
  and policy file that reaches the service. `chain` records the files between.
- Joins those files to graph nodes by `file`, and nodes to routes through
  `handles`, `renders` and `usesMiddleware`. `authentication` is copied from the
  route node.

Placement comes from where the importing file sits: `server` for anything the
server entry reaches (controllers, models, middleware, policies, validators,
routes, config, providers), `client` for `resources/js/`, `ssr` for a client
file in the SSR entry's reach, `build` for `vite.config.ts`, `drizzle.config.ts`
and `scripts/`, `test` for `tests/` and `*.test.ts`. When a client build
exists, the Vite build manifest confirms `client`, recorded as its own evidence
source (`build-manifest`) rather than RFC 0032's `registered`, which means an
introspected registration.

A package that only `@guren/*` (or another framework package) pulls in is
`carrier: 'framework'`. hono and drizzle-orm reach every route, so these are
reported once with `routes` empty and a note, never spread over each route.

The names say what was read. `importedBy` means an import exists on a path
from that file; it does not mean the vulnerable function runs. A route that is
not listed may still reach the package through a reader limit, which
`coverage` names. Following RFC 0032, nothing here becomes a pass or fail.

### 5. Advisory findings with exposure and a fix path

Each `deps:*` finding in `guren audit --json` gains:

```ts
exposure?: DependencyExposure['packages'][number]
fix?: {
  status: 'available' | 'unavailable'
  reason?: string
  steps: Array<
    | { kind: 'update'; package: string; to: string }          // a direct dependency
    | { kind: 'override'; package: string; to: string; note: string }
    | { kind: 'cooldown-exclude'; entry: string; publishedAt: string }
  >
}
```

The severity stays what `bun audit` reported. The fix path is computed from the
npm registry packument (`versions`, `time`, each version's dependency ranges)
under the scan's timeout:

1. If the package is direct, `update` to the newest version outside
   `vulnerable_versions`.
2. If it is transitive, find for each `via` the newest version of that direct
   dependency whose range admits a fixed version, and `update` it.
3. If no direct dependency release admits one, `override`, with a note that
   Bun's `overrides` replace the range and do not move a peer the lockfile has
   already resolved (measured in #1154).
4. If the fixed version is younger than the app's `minimumReleaseAge`, add a
   `cooldown-exclude` step with `name@version`, exempting that version only.

A registry that does not answer makes the fix `unavailable` with its reason,
never a guessed version. The text report prints the routes and the steps under
each advisory.

The development MCP server gains `guren_get_dependency_exposure`, read-only,
with the same bounded output rule as `guren_get_application_graph`. The docs
add a scheduled workflow running `guren audit --json` and failing on a new
advisory, so a disclosure is noticed the day it is published rather than at the
next deploy.

### 6. Runtime version

`guren deps:exposure` and `guren audit` report the runtime they can see: the
`Bun.version` of the process, `engines.bun` and `packageManager` from
`package.json`, and the base image tags in the app's `Dockerfile`. The report
says plainly that these are not checked against advisories, and the
`coverage.runtime` entry stays `unavailable` until an advisory source is chosen
(Open Question 3). The Dockerfile `guren deploy` renders moves from
`oven/bun:1` to the minor of the Bun running the command, so a rebuild cannot
change the runtime silently. The templates set no `engines.bun` today, so the
report usually shows only the process version and the image tag.

### 7. Data exposure

`guren audit` gains a column section built from `column-consumers.ts`. That
reader finds property reads today; this RFC extends it to a whole record passed
as a value, which it does not detect yet.

- For each model column, the Resources whose `toArray()` reads it, the
  controller actions that pass a record of the model to `this.inertia()` or
  `this.json()` without a Resource or `Model.serialize()`, and the pages that
  read it.
- A column is sensitive when the model lists it in `static hidden`, or its
  name matches `password`, `token`, `secret`, `hash`, `apiKey` or `otp`
  (case-insensitive, as whole camelCase or snake_case segments).
- A sensitive column reaching a response is `exposure-sensitive-column`, an
  advisory warn. A whole record passed raw counts as reading every column. The
  finding names the action, the route and whether the chain authorizes
  (`chainAuthorizes`).

This is an audit rule over its own static reader, not a verdict drawn from
graph edges. Records the reader cannot follow (across a call or a file, the
limit `column-consumers.ts` states) are listed as unread, never as safe.

### 8. Effect boundaries

No template ships a `guren.arch.ts` today. The templates gain one with two
rules using `disallowPackages`:

```ts
{ from: 'resources/js/**', disallowPackages: ['drizzle-orm', 'postgres', 'mysql2', '@guren/orm'], message: 'Pages run in the browser; load data in the controller.' },
{ from: 'app/Http/Controllers/**', disallowPackages: ['drizzle-orm'], severity: 'warn', message: 'Go through a Model so scopes, hidden columns and policies apply.' },
```

These are the nearest Guren gets to Nyxis's handlers that can only call
declared actions. `guren check`, and so `guren gate`, checks them. No template
controller and no `make:*` generator imports `drizzle-orm` today, so neither
rule fires on scaffold output; the second is a warn because a raw query is
sometimes the right call.

### 9. Trust boundary

Every `deps:exposure` and audit report ends with a section listing what its
results rest on without checking:

- the runtime version (§6);
- packages carried by the framework, attributed to no route;
- each reader's limits that applied in this run (non-literal imports, records
  followed no further than one file);
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
3. Where do Bun advisories come from? Candidates are the GitHub advisory
   database for `oven-sh/bun` and the Bun release notes; neither has been
   checked for completeness.
4. Should the trust boundary section also be written to `docs/spec/`? It would
   be drift-gated there, and every dependency bump would touch it.
5. Is a name list the right default for sensitive columns, or should a schema
   annotation be required?
6. Which Bun release introduced `minimumReleaseAge`, and does an older Bun
   ignore the key or fail on it? Only 1.4.4 was measured.
