# RFC: Security capabilities and a machine-checkable security posture

**Author:** Urata Daiki
**Date:** 2026-08-01
**Status:** Accepted (2026-08-01 — maintainer decision; the standard two-week discussion
window was waived by the project maintainer). Unlike RFC 0004, acceptance follows
implementation: the descoped proposal below shipped as four PRs before this status
change, so the design was validated against working code rather than ahead of it.
The Future Work items remain unimplemented by design.

> Scope note: an earlier draft of this RFC specified a considerably larger
> system — a public capability API for user middleware, an application-level
> middleware registry with per-route effective-chain computation, declared
> route security contracts, and a behavioral security test kit
> (`@guren/testing/security`). It was descoped before discussion: the concrete
> defect motivating the RFC is fixable with a fraction of that surface, no
> user demand exists yet for the rest, and every deferred piece adds permanent
> public API and a routing-semantics mirror that can drift. The deferred
> design is preserved in **Future Work** with explicit resumption triggers,
> so this document remains the place to pick it back up.

## Problem

Guren ships a static security audit (`guren audit`) that checks, among other
things, whether mutating routes are protected by authentication. That check is
a heuristic over middleware *names*:

```typescript
// packages/cli/src/audit.ts:64
const AUTH_MIDDLEWARE_PATTERN = /auth/i
// packages/cli/src/audit.ts:456
const hasAuthMiddleware = middlewareNames.some((name) => AUTH_MIDDLEWARE_PATTERN.test(name))
```

The heuristic is wrong in both directions, and the framework's own scaffolds
sit in its blind spot:

- **False negatives on inline middleware.** `guren add auth` generates routes
  that pass `requireAuthenticated(...)` *inline* (e.g.
  `packages/cli/src/make-auth.ts:1708`). Inline handlers surface in
  `Router.definitions()` only as `hasInlineMiddleware: true` — the audit cannot
  tell `requireAuthenticated()` from a logging middleware, so the standard auth
  scaffold's routes are not recognized as protected.
- **False positives on names.** Any alias matching `/auth/i` counts as
  protection (`auth-metrics` would pass), and an alias that doesn't
  (`secure`, `member`) doesn't.

Beyond the accuracy defect, three cheap, high-leverage gaps keep the audit
story below what comparable frameworks now ship (Rails 7.2 bundles Brakeman
and a security-scanning CI workflow into every new app):

- Audit findings carry no standard classification, so agents and reporting
  tools cannot group or prioritize them (and "OWASP" claims stay prose).
- `guren audit` never looks at dependencies — a known-vulnerable package in an
  app's lockfile is invisible to it.
- New apps are scaffolded with no CI at all: the integrity and security gates
  Guren already has (`check`, `audit`, tests) run only if the user hand-writes
  a workflow.

## Proposed Solution

Four additive pieces. None introduces a new public API beyond one CLI flag and
new optional fields in the audit's JSON output.

### 1. Internal capability marker; audit drops the name heuristic

The built-in auth middleware factories mark the handlers they return with a
well-known symbol. `Symbol.for()` keeps identity stable across duplicated
`@guren/server` copies in one process:

```typescript
// packages/server/src/http/middleware/capabilities.ts (new, internal)
/** @internal — not exported from the package root; the shape may change. */
export const CAPABILITIES = Symbol.for('guren.capabilities')

export interface MiddlewareCapabilities {
  authentication?: { mode: 'required' | 'guest-only' }
}
```

`requireAuthenticated()` and `requireGuest()` stamp their returned handlers
(non-enumerable property). `Router`'s internal registry already holds the real
middleware function objects for both aliased and inline registrations, and
`RouteDefinition` grows an aggregated, group-expanded view:

```typescript
export interface RouteDefinition {
  // ...existing fields...
  capabilities?: MiddlewareCapabilities
}
```

`guren audit` loads routes by importing the real module
(`packages/cli/src/load-routes.ts`), so the stamps are present on the actual
functions — no AST guessing. The audit replaces the `/auth/i` test with a
capability lookup: inline `requireAuthenticated` now counts as protection,
`auth-metrics` no longer does.

The marker is deliberately **not** part of the public API in this RFC: it is
not exported from `@guren/core`, `defineMiddleware` does not accept it, and
docs do not mention it. Making it public is Future Work item 1.

### 2. Classification taxonomy on audit findings

Findings gain versioned standard references — versioned because OWASP Top 10
2021 and 2025 number categories differently, so a bare `A03` is ambiguous:

```typescript
export interface AuditFinding {
  // ...existing fields...
  classifications?: Array<{
    standard: 'OWASP Top 10' | 'OWASP API Security' | 'CWE'
    version?: string          // '2021', '2023'; absent for CWE
    id: string                // 'A01', 'API3', 'CWE-352'
    name?: string             // 'Broken Access Control'
  }>
}
```

Initial mapping over the existing rules: missing auth on mutating routes →
A01:2021; missing validation and raw SQL → A03:2021; hardcoded secrets →
A02:2021; disabled security defaults → A05:2021; mass assignment → A01:2021 +
API3:2023. Console output prefixes the primary id (`[A01] ...`); the JSON
report carries the full array. Purely additive.

### 3. Dependency scanning in `guren audit`

`guren audit` runs `bun audit --json` for the app and converts advisories into
findings (classification A06:2021), reusing the parsing rules proven by the
monorepo's own gate (`scripts/smoke/dependency-audit.ts`): exit codes 0/1
carry valid JSON, anything else is a scan failure; the report shape is
validated before iterating; advisories are keyed by GHSA id.

"Could not scan" is reported as its own finding axis, never as a pass — an
offline machine must not look identical to a clean one. `--no-deps` opts out
(offline development); scan metadata (`status`, tool version) is included in
the JSON report so CI can require a completed scan.

### 4. CI workflow scaffold + `check --ci`

`create-app` templates gain `.github/workflows/ci.yml` running install →
`guren check --ci` → `guren audit --json` → `bun test`. Two enablers:

- **`check --ci`**: plain `guren check` has never set an exit code (a stable
  v1.0 contract this RFC does not change). The new flag gates on ~~any failing
  check~~ **every non-passing check**, giving scaffolded CI a real gate without
  a breaking change.
  **Amended in implementation:** gating on failures alone would have waved
  nearly everything through — most integrity problems (a missing codegen
  manifest, an unregistered console command) report as `warn`, and a fresh
  scaffold has zero of either. Warnings therefore gate too, except checks
  marked `advisory` on `CheckResult` (test-coverage nudges: scaffolding a
  controller must not turn CI red until a test exists). The flag lives on the
  result rather than being derived from key prefixes in the CLI, so
  `check --json` consumers see the same rule the gate applies. `--ci` also
  refuses to combine with `--arch`/`--docs`/`--spec`, since a narrowed run
  must not pose as the full-suite gate.
- **Template dotfile handling**: ~~templates ship `_github/` and the scaffolder
  renames it, extending the existing `_gitignore` mechanism
  (`packages/create-app/src/blueprints.ts`) to directories.~~
  **Amended in implementation:** unnecessary — npm keeps dot-directories under
  `files` entries (it strips only files literally named `.gitignore`, which is
  what the `_gitignore` convention works around), so templates ship `.github/`
  as-is. The packed-artifact audit asserts the workflow survives `npm pack` so
  an npm behavior change cannot regress this silently.

The API-only blueprint gets a variant without browser-specific steps.

**Added in implementation:** making a generated workflow gate on `check` also
surfaced a pre-existing false positive that would have failed every API-only
app's CI — `check` demanded `.guren/pages.gen.ts` unconditionally, but codegen
never emits it for an app with no page components. The expectation now asks
codegen's own rule (`planPageManifest`), so the two cannot drift. `doctor` reads
the same rule.

## Alternatives Considered

- **Keep name-based heuristics.** The status quo mislabels the framework's own
  auth scaffold. Rejected on the evidence above.
- **Metadata on `aliasMiddleware()` only.** Covers named aliases but not inline
  middleware — the exact case the scaffolds generate. Rejected as incomplete.
- **A `WeakMap<handler, capabilities>` registry instead of a symbol property.**
  A WeakMap lives in one module instance; a dependency tree with two
  `@guren/server` copies gets two registries that cannot see each other's
  handlers. `Symbol.for()` is process-global by construction.
- **The full mechanism from the original draft** (public capability API,
  global-middleware registry, `effectiveChain()`, declared contracts,
  behavioral test kit). Deferred, not rejected — see Future Work. The
  determining arguments: (a) the accuracy defect needs none of it; (b) the
  behavioral kit's marginal catch — bugs missed by both the improved static
  audit *and* the framework's own secure-defaults regression suite
  (`packages/server/tests/security-posture.test.ts`) — is a thin slice of
  real-world failures, while its safety machinery (probe protocols, snapshot
  propagation, runner adapters) is permanent complexity; (c) `effectiveChain()`
  must mirror Hono's dispatch semantics, and an introspection layer that can
  drift from real routing gives *false* assurance, the one failure mode a
  security tool must not have.
- **External SAST (CodeQL/Semgrep) for apps.** Generic engines cannot know
  that `requireAuthenticated()` is load-bearing for A01 — the framework can
  state it. Complements rather than replaces this proposal.

## Migration Path

Additive throughout; ships in minor releases of `@guren/server` and
`@guren/cli`, plus a `create-app` template update. No generated or user code
changes.

One observable behavior change: `guren audit` results become more accurate.
Routes previously passing only because an alias name matched `/auth/i` will
start warning (correctly); routes previously warning despite inline
`requireAuthenticated` will pass. The audit is informational by default, so
this cannot break CI that doesn't opt into exit codes; the changelog must
call it out regardless.

## Future Work (deferred with resumption triggers)

Preserved from the original draft; each item lists what would justify picking
it up. The design discussions behind them (probe-safety protocol, CSRF
applicability rules, TestApp snapshot propagation) are recorded in this
document's git history.

1. **Public capability API** — `defineMiddleware(fn, { capabilities })` so
   user and plugin middleware participate in audit detection.
   *Trigger:* users report audit false negatives on their own auth middleware.
2. **Application-level middleware introspection** (`securityPolicy()`,
   per-route effective chains). *Trigger:* item 3 is picked up, or agent
   tooling (`guren context`) needs per-route security answers.
3. **Behavioral security test kit** (`@guren/testing/security`,
   runner-agnostic `runSecurityChecks`). *Trigger:* a real-world report of an
   app whose audit passes while a runtime protection is broken — the class of
   bug only behavioral checks catch. Design constraints already settled:
   CSRF applicability must be declared (never inferred from session absence),
   probes only where rejection provably precedes the handler, exclusions read
   from middleware config rather than duplicated.
4. **Declared route security contracts** (`security:` route options with
   reason-required `not-applicable`). *Trigger:* item 3, which consumes them.

## Open Questions

Resolved at acceptance; the decisions below are what shipped.

1. ~~Should the taxonomy also tag `doctor` findings (e.g. the APP_KEY checks),
   or stay audit-only until someone needs the union?~~
   **Audit-only.** `doctor` answers "is this environment set up correctly",
   which is a different axis from "does this code have a security weakness" —
   an unset `APP_KEY` is a broken app before it is a vulnerability. Revisit if
   a consumer needs one merged, classified stream.
2. ~~Should `check --ci` also require a *completed* dependency scan (fail on
   `--no-deps`), or leave that policy to the generated workflow?~~
   **Left to the workflow.** `check` and `audit` stay separate commands with
   separate exit codes; making one gate the other's flags would couple them for
   no gain. The generated workflow runs `guren audit` without `--no-deps`, so
   the scan is required by default there, and an offline runner opts out
   explicitly in its own workflow file.
3. ~~For the scaffolded workflow: pin the Bun version from the template's
   `packageManager`, or float on latest and let the nightly-style breakage
   surface in user CI?~~
   **Float on latest** (`oven-sh/setup-bun@v2` with no `bun-version`). A
   scaffolded app's CI should track the runtime its developers install; a pin
   copied at scaffold time goes stale silently and is the harder failure to
   diagnose. Users who need reproducibility add the pin themselves.
