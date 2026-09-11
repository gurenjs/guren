# RFC: One Runtime Package

**Author:** 7nohe
**Date:** 2026-09-11
**Status:** Draft

## Problem

Guren publishes its runtime under two names. `@guren/server` holds the source;
`@guren/core` is the name every doc, template and plugin imports. The split was
meant to give application code one stable entry point while the server package
kept its own release line. What it produces instead is two version numbers for
one API, a dependency cycle, and a growing set of gates whose only job is to
keep the two names from contradicting each other.

What exists today (verified at `30a26e94`):

- **`@guren/core` is a re-export barrel plus the database-backed stores.**
  `packages/core/src/index.ts:1` is `export * from '@guren/server'`; lines
  2-90 are an explicit allowlist from `@guren/orm`; lines 91-127 export the
  stores and attachment engine that need the ORM (`session-store.ts`,
  `api-token-store.ts`, `oauth-state-store.ts`, `session-manager.ts`,
  `attachments/engine.ts`, all importing `Model` from `@guren/orm`). Every
  subpath is a shim over the matching server subpath: `runtime.ts`,
  `agent.ts`, `jsx-runtime.ts` are `export *`; `lambda.ts` and `redis.ts`
  restate server's names as allowlists; `vite.ts` re-exports the default.
- **The two versions are independent.** `packages/core/package.json:3` says
  `1.16.0`; `packages/server/package.json` says `2.21.0`. Core depends on
  server through a caret (`"@guren/server": "^2.21.0"`, `core/package.json:93`),
  so `changeset version` rewrites the range on a server major and leaves
  core's bump type alone. That is how server 2.0.0 (2026-08-05, RFC 0006
  removals) reached users as core 1.5.0, a minor, through every `^1.4.0`
  (`scripts/smoke/core-semver-audit.ts:5-8`, and the "core-semver" paragraph
  of `.claude/rules/common-pitfalls.md`). `audit:core-semver` exists to
  refuse that plan; the "fixed group is not the fix" paragraph exists to
  explain why the obvious changesets setting makes it worse. Release tags
  follow server (`v2.21.0`), so "the v2.21 release" names a core 1.16.0.
- **The cycle.** `packages/core/src/bin.ts:2` is `import '@guren/cli/bin'`,
  which makes `@guren/cli` a runtime dependency of core (`core/package.json:91`),
  while cli depends on core (`cli/package.json`, `"@guren/core": "^1.16.0"`).
  `packages/core/src/internal/deploy-check.ts:37` reaches cli a second time
  by lazy `import('@guren/cli')`. The build breaks the cycle by hand:
  `ignoredEdges` in `scripts/workspace-packages.ts:136-138` drops core's
  edge on cli, with a stale-entry warning at lines 200-207. Server has its
  own lazy `import('@guren/cli')` under `@ts-ignore`
  (`packages/server/src/mcp/McpServiceProvider.ts:27-31`), covered by
  `deps: { neverBundle: ['@guren/cli', 'zod'] }` in
  `packages/server/tsdown.config.ts:54`.
- **The rule that puts the database stores in core is already broken.** The
  stated reason is that server must not depend on the ORM: RFC 0003
  (`rfcs/0003-cloudflare-workers-plugin.md:563-567`), restated in
  `packages/core/src/session-manager.ts:23` and `CLAUDE.md:387`. But
  `packages/server/src/auth/AuthenticatableModel.ts:1` imports `Model` at
  runtime and extends it at line 5, and `packages/server/package.json`
  declares `"@guren/orm": "^2.7.1"` under `dependencies`. The boundary the
  stores were moved across does not exist; only the stores moved.
- **The core-first rule is enforced at the repo's edge and nowhere else.**
  `scripts/smoke/core-first-audit.ts:5-11` scans `README.md`, `docs`,
  `examples`, `web` and `packages/create-app/templates/default` (not
  `api-only`) for the string `@guren/server`. Inside `packages/`, the name is
  load-bearing: `@guren/testing` peer-depends on `"@guren/server": ">=2.14.0"`
  (required) beside an *optional* `"@guren/core": ">=1.8.0"`, and its
  `test-app.ts:409-413` and `agent.ts:50-53` try core, then server, then a
  bare Hono app. `@guren/plugin-lambda` declares an optional peer
  `"@guren/server": ">=2.20.0"` because `src/session/index.ts:12` must write
  `declare module '@guren/server'` to augment `SessionDrivers`; augmenting
  the name users import would not merge. `packages/cli/src/key-generate.ts:3`
  imports from server directly; `deprecations.ts:59` and
  `deploy-runtime.ts:228` scan for both names because either may appear.
- **Subpaths diverge.** Server's `exports` map has 28 entries (`.` plus 27
  subpaths); core's has 13 (`.` plus 12). Ten subpaths exist on both, two
  only on core (`/internal/deploy-build`, `/internal/deploy-check`), and 17
  only on server. Of those 17, the 13 per-subsystem entries (`/auth`,
  `/cache`, `/mail`, `/queue`, ...) have no first-party consumer outside
  `packages/server` and appear in no doc, because the core-first audit makes
  them unnameable; the root barrel (`packages/server/src/index.ts`, 1037
  lines, 102 export statements) already exports the same names, and
  `packages/server/tsdown.config.ts:5-8` explains that the per-entry chunks
  must share module state or `registerJob` through the root would be
  invisible to `./queue`.
- **The docs define stability by the name, not the package.**
  `contributing/api-stability.md` says a symbol is Stable when it is
  "re-exported from `@guren/core`", and `contributing/plugin-contract.md:159`
  lists three public entry points (`@guren/server`, `@guren/orm`,
  `@guren/core`). Two of the three are the same API under different version
  numbers.

### What it costs to keep the two names consistent

Everything below exists only because the runtime has two names. None of it
guards a behaviour a user can observe.

| Kind | Where (at `30a26e94`) | Why it exists |
|---|---|---|
| Gate | `scripts/smoke/core-semver-audit.ts` + test; `package.json:40`; `ci.yml:148`; head of `version-packages` (`package.json:61`) | a server major must become a core major |
| Gate | `scripts/smoke/core-first-audit.ts`; `package.json:29`; `ci.yml:116`, `release.yml:79`, `nightly-canary.yml:76` | docs must not name the package the code lives in |
| Gate (half) | `scripts/smoke/plugin-compat-audit.ts`: `rangeAtRelease` / `plannedVersions` | a plugin's `@guren/core` range moves when *server* crosses a major, while `compatibility` does not |
| Assertion | `starter-template-audit.ts:71`; `fresh-app.ts:284-285, 304-305, 432, 438, 445` | five restatements of the same "no `@guren/server`" rule |
| Build config | `ignoredEdges` + stale-entry warning, `workspace-packages.ts:136-138, 200-207` | the core↔cli cycle |
| Build config | `neverBundle: ['@guren/cli']`, `server/tsdown.config.ts:54` | the server⇢cli lazy import |
| Source | `packages/core/src/{bin,runtime,vite,lambda,redis,agent,jsx-runtime,jsx-dev-runtime}.ts`, `internal/{route-path,zod-compat,zod-json-schema}.ts` | eleven files whose only content is a re-export |
| Source | `core/package.json:5-8` `sideEffects` naming `bin`; `core/tests/core.test.ts:25-29` pinning the proxy | the bin lives in the wrong package |
| Test | `packages/core/tests/session-manager.test.ts` | a `declare module` augmentation must survive core's *bundled* `.d.ts` (server emits unbundled ones, `server/tsdown.config.ts:46-48`) |
| Fallback | `testing/src/test-app.ts:409-413`, `testing/src/agent.ts:50-53` | either name may be the one installed |
| Scanner | `cli/src/deprecations.ts:59`, `cli/src/deploy-runtime.ts:228` | either name may appear in app source |
| Peer | `plugin-lambda/package.json` optional `@guren/server` | module augmentation targets the declaring package |
| Prose | four paragraphs of `common-pitfalls.md` (core-first, core-semver, fixed group, "core is not on the release train") | explaining the above to the next contributor |

Fourteen mechanisms, two of them running on every CI job and one at the head
of every release.

## Proposed Solution

Publish one runtime package, **`@guren/core`**, containing what
`packages/server/src` and `packages/core/src` contain today. `@guren/server`
becomes a re-export shim for one major and is then retired.

### Direction: core is the package (A), not server (B)

Both directions end with one name. The migration cost decides it.

| | (A) `@guren/core` is real, `@guren/server` shims | (B) `@guren/server` is real, `@guren/core` retired |
|---|---|---|
| Root import lines to rewrite in-repo | 0 in docs/examples/templates | 401 (`docs/en`), 390 (`docs/ja`), 138 (`examples`), 38 + 44 (create-app and cli templates), 2 (`web/src`) |
| Manifests to repoint | `@guren/testing` (peer), `@guren/plugin-lambda` (peer), `@guren/cli` (drops server) | both templates, `@guren/openapi`, all 7 plugins, `web`, 3 examples, every user app since v1.0-alpha |
| Gates to invert | none (the "no `@guren/server`" grep keeps its meaning through the shim window) | `core-first-audit` and five smoke assertions flip sign |
| Name accuracy | `core` already carries the ORM allowlist, the Vite plugin, the JSX runtime | `server` would carry `Model`, `defineModel`, `createPostgresDatabase` |
| Users who wrote the discouraged name | codemod `@guren/server` → `@guren/core` | codemod in the other direction, for every user |

The only argument for (B) is that server holds the source and the git
history. `git mv packages/server/src packages/core/src` keeps both. (A) it is.

### Package graph after

| Package | Depends on (runtime) | Change |
|---|---|---|
| `@guren/core` | `@guren/orm`; lazy, undeclared `@guren/cli` (MCP provider, deploy-check) | absorbs server's source; loses `@guren/cli` and `@guren/server` from `dependencies` |
| `@guren/orm` | drizzle | unchanged |
| `@guren/cli` | `@guren/core`, `@guren/orm` | drops `@guren/server`; `key-generate.ts:3` imports from core |
| `@guren/testing` | peer `@guren/core` (required) | drops the server peer and the two fallback chains |
| `@guren/openapi` | `@guren/core` | range bump only |
| `@guren/inertia-client`, `create-guren-app` | none | unchanged |
| 7 plugins | `@guren/core` | range bump; `plugin-lambda` drops its server peer and augments `@guren/core` |
| `@guren/server` (shim, one major) | `@guren/core` | `export *` of the root and of every surviving subpath |

The declared graph becomes acyclic: `ignoredEdges` empties and the
stale-entry loop goes with it. The lazy core⇢cli imports stay as they are in
server today, so `neverBundle: ['@guren/cli', 'zod']` moves from
`server/tsdown.config.ts` to core's; it is not deleted.

### Source layout and the bin

- `packages/server/src/**` moves under `packages/core/src/` with `git mv`;
  core's eleven re-export files and `bin.ts` are deleted. Core adopts
  server's declaration strategy (`tsc -p tsconfig.build.json`, unbundled
  `.d.ts`), which retires the bundled-augmentation test.
- The `guren` bin is `@guren/cli`'s (`cli/package.json` already declares
  `"bin": { "guren": "./dist/bin.js" }`), and both scaffold templates
  already depend on `@guren/cli` (`templates/default/package.json:24`,
  `templates/api-only/package.json:23`). Core stops declaring a bin and
  drops its `sideEffects` entries; server's `"sideEffects": false` carries
  over.
- The module-level state the tsdown comment warns about (job registry, mail
  manager, queue driver) keeps sharing chunks exactly as it does now, since
  the entry set is the same package's.

### Subpaths: the rule, and which of the 29 survive

A subpath earns its place by one of three things; anything else lives on the
root, which is where the docs already import it from.

1. **It isolates a dependency the root must not pull.** `/redis` (ioredis),
   `/mcp` (`@modelcontextprotocol/sdk`, deliberately kept off the barrel at
   `server/src/index.ts:1031-1033`), `/lambda`, `/vite`.
2. **It targets a different runtime than the app graph.** `/agent`
   (browser-safe dispatch, RFC 0016 §3), `/jsx-runtime` and
   `/jsx-dev-runtime` (the `@jsxImportSource` target), `/runtime` (Bun
   helpers), `/encryption` (loaded lazily from a vitest setup file,
   `testing/src/vitest.ts:25`, where the root graph is not wanted).
3. **It is a contract shared with sibling packages but not app API:**
   `/internal/*`.

| Outcome | Subpaths | Count |
|---|---|---|
| Survive, already on core | `/runtime`, `/vite`, `/lambda`, `/redis`, `/agent`, `/jsx-runtime`, `/jsx-dev-runtime`, `/internal/deploy-build`, `/internal/deploy-check`, `/internal/route-path`, `/internal/zod-compat`, `/internal/zod-json-schema` | 12 |
| Survive, promoted from server | `/mcp`, `/encryption`, `/internal/request` | 3 |
| Dropped: root exports the same names (`server/src/index.ts:505-1008`) | `/auth`, `/authorization`, `/broadcasting`, `/cache`, `/events`, `/health`, `/i18n`, `/logging`, `/mail`, `/notifications`, `/queue`, `/scheduling`, `/storage` | 13 |
| Dropped: cross-package sharing is now intra-package | `/support/expiry` | 1 |

So `@guren/core` ends with 16 `exports` entries; the shim mirrors all 29 old
paths for one major (the dropped 14 pointing at the root) so that an import
that worked on server 2.x resolves on the shim and the codemod, not a 404,
tells the user where it went. The `core.test.ts:17-23` rule (expiry helpers
never public) survives as a test of the root barrel rather than of a
subpath.

### `@guren/core/internal/*`

Unchanged in name and in stability tier. The six internal subpaths exist so
`@guren/cli`, `@guren/openapi` and `@guren/testing` share one Zod → JSON
Schema rule and one request-body rule; after the move they are the package's
own modules published under the same paths, and `api-stability.md`'s
"Internal" tier keeps describing them.

### Versioning and the release sequence

This is a major for both names.

- **`@guren/core` goes to 3.0.0**, not 2.0.0: it continues the number the
  runtime is on (server 2.21.0), the release tag `v3.0.0` follows it
  (today's tags follow server), and the shim publishes as
  `@guren/server@3.0.0`, so the two names carry the same number for the
  whole shim window and "which version is installed" has one answer.
- Sequence, one release: (1) the source move and shim; (2) cli, testing,
  openapi and the seven plugins repoint (cli, testing, openapi as minors;
  plugins are 0.x, minors) with `compatibility: ">=3.0.0 <4.0.0"`; (3) gates
  and prose deleted (table below); (4) the codemod and `guren upgrade`
  changes (Migration Path); (5) `sync:template-deps` writes `^3.0.0` into
  the templates. `smoke:starter:npm` is red until the release ships, the
  documented state for a template using an unreleased API.
- **4.0.0** (or the next major, whichever is later): the shim's last version
  is published with an `npm deprecate` notice naming `@guren/core`, the
  package leaves the workspace, and the "no `@guren/server`" grep is deleted.

### Changesets

`.changeset/config.json` does not change. `fixed` stays `[]` (the measured
reasons in `core-semver-audit.ts:14-20` still hold: a fixed group snaps to
its highest member in both directions). The shim needs no changeset of its
own: `updateInternalDependencies: "patch"` bumps it on every core release,
which is the behaviour a shim wants. At retirement it moves into `ignore`.

### Plugin `compatibility`

All seven plugins declare a range against `@guren/core` and stop below 2.0.0
(`>=1.0.0 <2.0.0` for cloudflare, lambda, markdown, vercel; `>=1.14.0 <2.0.0`
for agents and mcp; `>=1.13.0 <2.0.0` for webmcp). Every one is rewritten in
the merge release, which is exactly the drift `audit:plugin-compat` catches
after `changeset version`. After the merge the field claims against the
package whose API the plugin actually calls, so the range and the field
describe one thing. `checkPluginCompatibility` (`plugin-manifest.ts:218-230`)
and `readCoreVersion` (`:201-206`) need no change: they already read
`node_modules/@guren/core/package.json`.

### What gets deleted

| Item | Fate |
|---|---|
| `audit:core-semver` (script, test, CI step, `version-packages` head) | deleted: no dependent bump to promote |
| `audit:core-first` | reduced to the single "no `@guren/server`" grep already in `starter-template-audit.ts:71`; deleted with the shim |
| `plugin-compat-audit.ts` `rangeAtRelease` and the dependency-driven `plannedVersions` | deleted: core's version moves only when core has a changeset. The range-subset probe stays |
| `ignoredEdges` and its stale-entry warning | deleted |
| `neverBundle` in `server/tsdown.config.ts` | moves to core's config |
| `packages/core/src/bin.ts`, 11 re-export files, `sideEffects`, `core.test.ts:25-29` | deleted |
| `session-manager.test.ts` bundled-`.d.ts` pin | deleted with the bundled declarations |
| `testing` fallback chains, `plugin-lambda` server peer | deleted |
| `deprecations.ts:59` and `deploy-runtime.ts:228` dual names | kept through the shim window (they are what finds the old name), then narrowed |
| `common-pitfalls.md` core-first, core-semver, fixed-group and release-train paragraphs; `api-stability.md` decision tree step 1; `plugin-contract.md:159` | rewritten to describe one package |

## Alternatives Considered

- **`fixed: [["@guren/server", "@guren/core"]]`.** Rejected for the reason
  `core-semver-audit.ts:14-20` measured against `changeset version`: the
  group is bidirectional and snaps to its highest member, so a server-only
  patch moved core 1.6.2 → 2.7.1 in the trial, crossing core's major line
  inside a release whose changelog reads "Patch Changes" and tripping every
  plugin's `<2.0.0`. Only one direction of the coupling is true, and
  changesets cannot express one direction.
- **Keep two packages; pin core to server exactly.** `"@guren/server": "2.21.0"`
  and a core release for every server release. It removes the silent-major
  case and nothing else: two version numbers to explain, the cycle, the
  eleven shims, the diverging subpaths, and augmentation still targeting the
  name users are told not to import. It also makes `updateInternalDependencies`
  publish a core patch for every server patch, which is a shim with extra
  steps.
- **Merge `@guren/orm` too.** Rejected. The ORM is a real boundary: it pins
  `drizzle-orm` exactly and `drizzle-pins.ts` propagates that pin to
  templates and to `guren upgrade`; it has its own release line (2.7.1) and
  its own open design question on per-dialect entry points (RFC 0022); and
  the cli's schema tooling consumes it without the HTTP stack. Folding it in
  would put drizzle's release cadence on the framework's.
- **Move the database stores back into server and keep core as a pure
  barrel.** Fixes the broken RFC 0003 rule honestly, but leaves everything in
  the cost table in place; it is the first half of this RFC without the
  second.
- **Retire `@guren/server` immediately, no shim.** Saves one major of
  maintenance for a package that costs nothing to maintain
  (`updateInternalDependencies` does the work), at the price of a hard break
  for the two first-party packages and every user who wrote the discouraged
  name. The deprecation policy asks for two minors of warning; a shim is how
  a package name gets them.

## Migration Path

**Apps importing `@guren/core`** (every scaffold since v1.0-alpha): nothing
to edit. `guren upgrade` already rewrites `@guren/*` ranges across the four
manifest fields (`upgrade.ts:17-18`) and aligns the drizzle pins; it will
write `^3.0.0`.

**Apps importing `@guren/server`:** a codemod, the first entry in the
currently empty registry (`packages/cli/src/codemods.ts:21`,
`codemods: Codemod[] = []`), selected by `findApplicableCodemods` for the
2.x → 3.x range:

- `'@guren/server'` → `'@guren/core'`;
- `'@guren/server/<sub>'` → `'@guren/core/<sub>'` for the 15 surviving
  subpaths, and → `'@guren/core'` for the 14 dropped ones;
- `declare module '@guren/server'` → `declare module '@guren/core'`;
- the `package.json` dependency `@guren/server` → `@guren/core` (the manifest
  rewrite `guren upgrade` already performs, extended to rename).

The detector reuses `GUREN_IMPORT` at `deprecations.ts:59`, which already
matches both names. The policy's "tested against `examples/blog`" rule cannot
apply literally (the blog imports core), so the codemod test uses a synthetic
fixture that imports every old path once.

**Plugin authors:** bump the `@guren/core` range, rewrite `compatibility`,
and rename any `declare module`. `guren plugin` refuses a stale range with
its existing message (`plugin.ts:119-125`), so a plugin left on `<2.0.0`
fails at install, not at runtime.

**Deprecation stages** (per `contributing/deprecation-policy.md`):

| Stage | Release | What |
|---|---|---|
| Announce + register | next 2.x minor | `Deprecation` entry `guren-server-import` (`since` that minor, `removedIn` 4.0.0) in `deprecations.ts`; `guren upgrade --check-only` and `guren doctor` list the files; CHANGELOG `### Deprecated` |
| Provide codemod + shim | 3.0.0 | the merge release above; `guren upgrade` runs the rename |
| Warn at runtime | 3.0.0 | the shim's root entry emits the once-per-process `[guren] Deprecation (guren-server-import)` warning on import |
| Remove | 4.0.0 | shim retired; `npm deprecate` on its last version |

The 3.x line is at least two minors long before 4.0.0, which satisfies the
minimum period for a stable API.

## Open Questions

1. **3.0.0 or 2.0.0 for `@guren/core`?** 3.0.0 keeps the tag line and the
   shim on one number. 2.0.0 is the smaller semantic step and matches the
   plugins' existing `<2.0.0` ceilings, but ships a `@guren/core@2.x` that
   is older-looking than the `@guren/server@2.x` it replaces.
2. **Does `declare module '@guren/server'` merge through the shim?** The
   shim is `export * from '@guren/core'`. If TypeScript does not merge an
   augmentation through a star re-export, a third-party plugin on the old
   name fails to type-check against 3.x with no runtime symptom. To be
   answered by a test in the shim package before 3.0.0; if the answer is no,
   the codemod's `declare module` rename becomes mandatory rather than
   cosmetic.
3. **Directory name.** `git mv packages/server/src packages/core/src` keeps
   blame but leaves `packages/server` as a three-file shim for a major; the
   alternative (`packages/server` → `packages/core`, then fold in core's
   stores) keeps the larger history intact and moves the smaller tree.
4. **Do the 13 per-subsystem subpaths deserve a stay?** No first-party
   consumer, no doc; but a third-party plugin may import `@guren/server/queue`
   today. The shim answers it for one major. Whether `@guren/core/queue` and
   friends are ever published is a question for the first user who asks.
5. **Should the shim be retired at all?** A permanent shim costs one
   automatic patch per release. Against that: a second name is what every
   mechanism in the cost table grew around, and `deprecations.ts` and the
   two smoke assertions exist only while it does.
6. **Where does the "stable = re-exported from core" definition go?** With
   one package, `api-stability.md`'s first decision-tree step is a tautology;
   the honest replacement is "exported from the root or a non-`internal`
   subpath", which should be written down in the same PR.
