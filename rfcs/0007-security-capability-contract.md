# RFC: Security capabilities and a machine-checkable security posture

**Author:** Urata Daiki
**Date:** 2026-08-01
**Status:** Draft

> Scope note: this RFC specifies the *mechanism* — how the framework states, in
> machine-readable form, which security protections apply to which routes — and
> the two consumers that read it (`guren audit` and a new behavioral test kit).
> Companion work that rides on the mechanism but adds no new design questions
> (OWASP/CWE tagging of audit findings, dependency scanning for apps, a CI
> workflow scaffold for new apps) is listed under "Staging" and intentionally
> not re-litigated here.

## Problem

Guren already ships a static security audit (`guren audit`) that checks, among
other things, whether mutating routes are protected by authentication. That
check is a heuristic over middleware *names*:

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
- **Global protections are invisible.** Session, CSRF, and security-headers
  middleware are mounted on the Hono instance
  (`Application.mountSecurityDefaults()`, `packages/server/src/http/Application.ts:361`;
  `AuthServiceProvider.register()`, `packages/server/src/providers/AuthServiceProvider.ts:17`),
  not on routes. `Router.definitions()` (`packages/server/src/mvc/Router.ts:487`)
  cannot see them at all, so no tool can answer "is this specific route
  CSRF-protected?" — only "does a CSRF middleware exist somewhere?".

The consequence is that Guren's security checking is capped at
Brakeman-quality: pattern matching over source artifacts. That is the ceiling
for Rails because routes and middleware are resolved at runtime; it should not
be the ceiling for Guren, where routes are data (`RouteDefinition[]`) and the
CLI already loads the real route module (`packages/cli/src/load-routes.ts`
performs an actual `import()` and registers into a real `Router`, so middleware
*function objects* are available to static tooling).

The same gap blocks behavioral verification. A test kit that wants to assert
"every mutating route rejects a tokenless POST" needs to know, per route, which
protections are *supposed* to apply — otherwise it either probes blindly
(executing handlers whose protection is missing, i.e. causing the very side
effects it exists to prevent) or maintains a hand-written route list that
drifts from the app.

## Proposed Solution

One mechanism, three layers, two consumers.

### 1. Capability stamps on middleware handlers

Middleware factories mark the handlers they return with a well-known symbol.
The property is non-enumerable, and the key is registered via `Symbol.for()` so
identity survives duplicated `@guren/server` copies in a dependency tree (any
same-realm lookup resolves to the same symbol):

```typescript
// packages/server/src/http/middleware/capabilities.ts (new)
export const CAPABILITIES = Symbol.for('guren.capabilities')

/** Structured, not string[] — consumers need the configuration, not a label. */
export interface SecurityCapabilities {
  authentication?: { mode: 'required' | 'guest-only' }
  csrf?: { methods: string[]; exclude: string[] }
  session?: { cookieName: string }
  securityHeaders?: Record<string, string | false>
  // extensible; unknown keys are preserved and reported verbatim
  [key: string]: unknown
}

export function stampCapabilities<H extends MiddlewareHandler>(
  handler: H,
  capabilities: SecurityCapabilities,
): H
```

The built-in factories stamp themselves: `requireAuthenticated` /
`requireGuest` (`authentication`), `createCsrfMiddleware` (`csrf`, including
its resolved `exclude` list and protected methods), `createSessionMiddleware`
(`session`), `createSecurityHeaders` (`securityHeaders`). This is what makes
the `guren add auth` scaffold legible with **zero changes to generated app
code** — the inline `requireAuthenticated(...)` call already returns a stamped
handler.

User and plugin middleware opt in through `defineMiddleware`, which grows an
optional second argument (backward compatible):

```typescript
export const requireSubscription = defineMiddleware(
  async (c, next) => { /* ... */ },
  { capabilities: { authentication: { mode: 'required' } } },
)
```

### 2. Introspection: route-level and application-level

**Route level.** `RouteDefinition` gains an aggregated, group-expanded view of
the capabilities present on its middleware chain (named aliases, group
middleware, and inline handlers alike):

```typescript
export interface RouteDefinition {
  // ...existing fields...
  capabilities?: SecurityCapabilities
}
```

**Application level.** Route middleware is not enough: CSRF and session are
`hono.use('*')` registrations that `Router` never sees. `Application` therefore
records every global registration it makes (and those made through
`app.use()`) with its mount scope and order, and exposes:

```typescript
interface GlobalMiddlewareRecord {
  scope: string                      // the hono.use() path pattern
  order: number                      // registration index
  capabilities?: SecurityCapabilities
}

class Application {
  securityPolicy(): {
    global: GlobalMiddlewareRecord[]
    routes: RouteDefinition[]
    /** Which capability-bearing middleware run before this route's handler. */
    effectiveChain(method: string, path: string): SecurityCapabilities[]
  }
}
```

`effectiveChain()` is the load-bearing API. "CSRF middleware is mounted" is a
global boolean; "a tokenless POST to `/posts` is rejected before the handler
runs" requires knowing that the CSRF middleware's scope covers the path, that
it was registered before the route, that POST is a protected method, and that
the path is not in its `exclude` list. Consumers must ask the per-route
question, not the global one.

### 3. Declared security contracts (optional override)

Inference covers the common case; declarations cover intent that cannot be
inferred. Route options accept an explicit contract:

```typescript
router.post('/webhooks/stripe', [WebhookController, 'store'], {
  security: {
    csrf: { mode: 'not-applicable', reason: 'Stripe signature verification' },
  },
})
```

Two rules make declarations trustworthy rather than a bypass valve:

- **`not-applicable` always requires a `reason`.** In particular, CSRF
  applicability is *never* inferred from "no session middleware" — CSRF is
  about ambient browser credentials generally (any cookie, Basic auth, client
  certificates), not sessions specifically. An API-only app declares
  `not-applicable` with its reason (e.g. bearer-only auth) once, at the app or
  route level.
- **Stale declarations fail.** A declaration that no longer corresponds to a
  real route, or a skip entry no checker consumes, is an error — the same
  contract the audit's ignore config and the monorepo's dependency gate
  already enforce.

This is the spec-anchored split (RFC 0004): capabilities are **derived**,
contracts are **declared**, and both consumers below are the **checked** layer.

### Consumer 1: `guren audit` drops the name heuristic

`AUTH_MIDDLEWARE_PATTERN` and the `middlewareNames.some(...)` test are replaced
by capability lookup over the loaded route definitions. Because
`loadRouteDefinitions()` imports the real module, the stamps are present on the
actual function objects; no AST guessing is involved. The audit gains accuracy
in both directions: inline `requireAuthenticated` now counts, `auth-metrics`
no longer does.

### Consumer 2: `@guren/testing/security` — behavioral verification

A runner-agnostic core with thin adapters, so the testing package keeps its
current runner neutrality:

```typescript
// @guren/testing/security
export function runSecurityChecks(
  app: TestApp,
  options?: {
    skip?: Array<{ method: string; path: string; check: string; reason: string }>
  },
): Promise<SecurityReport>

// @guren/testing/security/bun  and  .../security/vitest
export function securitySuite(app: TestApp, options?): void  // registers describe/test
```

`TestApp.create()` snapshots `securityPolicy()` at boot and propagates it
through `withHeaders()` / `actingAs()` / `withCsrf()` clones.
`TestApp.fromFetch()` / `fromWorkers()` cannot reconstruct routes and are
rejected at the type level.

Checks, derived from the policy rather than a hand-written list:

| Check | Setup | Expectation |
|---|---|---|
| CSRF enforcement | authenticated if the route requires it; token absent/invalid | the middleware's configured rejection, *before* the handler |
| Authentication | guest, **valid** CSRF token (`withCsrf()`) | 401 or the configured redirect |
| Security headers | one side-effect-free probe request | configured header values present |
| Cookie flags | session-mutating probe | `HttpOnly`/`SameSite`; `Secure` under production boot |

The CSRF/auth matrix ordering matters because the default chain is
session → CSRF → auth context: an unauthenticated tokenless POST is rejected
by CSRF, so the auth check must present a valid token to observe the auth
rejection at all.

**Probe safety protocol.** A probe that reaches a handler is a bug in the app
*and* a side effect the kit caused. Three guards:

1. `runSecurityChecks` refuses to run unless `NODE_ENV === 'test'`, and its
   documentation requires isolated stores (the blueprint test config already
   switches to a separate SQLite database).
2. A route is live-probed **only when `effectiveChain()` proves the rejection
   happens before the handler**. Routes the static pass finds unprotected are
   reported as failures *without sending a request*.
3. Routes excluded by the CSRF middleware's own `exclude` config are skipped by
   reading that config — the kit never maintains a second exclusion list to
   drift from the first. User-supplied `skip` entries require a `reason` and
   fail when stale.

The residual risk — a handler executing because a protection the static pass
attested to is broken in a way only the probe can see — is precisely the class
of bug the kit exists to find, and it is bounded to one request per route
under a test-only environment.

### Staging

Implementation lands as independently shippable stages; only the middle two
are governed by this RFC's design:

1. **Finding taxonomy** (`@guren/cli`): audit findings gain
   `classifications: Array<{ standard, version, id, name }>` plus CWE ids —
   versioned because OWASP Top 10 2021 and 2025 number differently. Additive.
2. **Capability mechanism + introspection** (this RFC, `@guren/server` +
   `@guren/cli`): sections 1–2 and consumer 1.
3. **Behavioral test kit** (this RFC, `@guren/testing` + `@guren/server`):
   section 3 and consumer 2.
4. **Application dependency scanning** (`@guren/cli`): `bun audit` integration
   for apps, mirroring the monorepo's own gate.
5. **CI scaffold** (`create-app` + `@guren/cli`): generated workflow running
   check/audit/tests. Requires a `check --ci` aggregate exit-code flag (the
   plain `check` exit contract is stable since v1.0 and unchanged) and a
   template mechanism for shipping `.github/` (today only `_gitignore` is
   renamed).

## Alternatives Considered

- **Keep name-based heuristics.** The status quo mislabels the framework's own
  auth scaffold. Rejected on the evidence above.
- **Metadata on `aliasMiddleware()` only.** Covers named aliases but not inline
  middleware — the exact case the scaffolds generate. Rejected as incomplete.
- **Mandatory route-level security contracts.** Declaring every route's
  requirements by hand is Laravel-grade double bookkeeping and a drift factory.
  Inference-first with optional declarations keeps the default zero-config.
- **A `WeakMap<handler, capabilities>` registry instead of a symbol property.**
  A WeakMap lives in one module instance; a dependency tree with two
  `@guren/server` copies gets two registries that cannot see each other's
  handlers. `Symbol.for()` is process-global by construction.
- **External SAST (CodeQL/Semgrep) for apps.** Valuable, and the monorepo now
  runs CodeQL on framework code, but generic engines cannot know that
  `requireAuthenticated()` is load-bearing for A01 — the framework can state
  it. The approaches compose rather than compete.
- **DAST (OWASP ZAP) instead of the test kit.** Slow, noisy, and blind to the
  route metadata the framework already has. The kit covers the same surface
  in-process, deterministically, per PR.

## Migration Path

Additive for applications: no generated code changes, `defineMiddleware`'s new
argument is optional, `RouteDefinition.capabilities` is a new optional field.
Ships in a minor release of `@guren/server` / `@guren/cli` / `@guren/testing`.

One observable behavior change: `guren audit` results become more accurate.
Routes previously *passing* only because an alias name matched `/auth/i` will
start warning (correctly); routes previously *warning* despite inline
`requireAuthenticated` will pass. The audit is informational by default, so
this cannot break CI that doesn't opt into exit codes; the changelog must call
it out regardless.

## Open Questions

1. **Plugin capability namespacing.** Should third-party plugins stamp under
   their own keys (`'plugin-stripe:webhook-signature'`) with a naming
   convention, or is the open `[key: string]` record enough?
2. **Authorization capability.** `requireAuthenticated` says nothing about
   *authorization* (policies/Gate). Should policy enforcement get a capability
   so the audit can distinguish authenticated from authorized mutations? Ties
   into the Gate wiring left open by the secure-by-default roadmap.
3. **Rate limiting.** Same question for the rate limiter — a capability plus a
   posture check ("login route has a limiter") is cheap once the mechanism
   exists.
4. **Report schema for N/A.** How `SecurityReport` distinguishes
   pass / fail / not-applicable-by-declaration / skipped-with-reason, and
   whether `guren audit --json` should embed the same shape for tooling.
5. **Header value checks.** The kit asserts configured values, but should it
   also warn on *absent* protections that are opt-in today (CSP, host
   authorization) — posture advice rather than regression detection?
