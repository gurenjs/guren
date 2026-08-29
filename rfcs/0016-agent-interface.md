# RFC: Agent Interface — Deriving Agent Tools from Application Contracts

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-08-29
**Status:** Accepted

> The standard two-week discussion window was shortened by maintainer decision
> (solo-maintained project; the design went through an external review pass and a
> market validation pass before this document was filed).

## Problem

AI agents are becoming first-class consumers of web applications. MCP is the settled
standard for that surface (Linux Foundation governance, support in every major client,
and a stateless-core spec as of the 2026-07-28 release candidate that makes an MCP
server an ordinary HTTP workload). Yet in every mainstream full-stack framework,
exposing application functionality to agents means **hand-writing a second, parallel
tool layer**: Laravel MCP scaffolds Tool classes with hand-built JSON schemas, Rails
gems require Dry-Schema blocks, Vercel's mcp-handler takes hand-written Zod per tool.
The input schema is written twice — once for HTTP validation, once for the tool — and
nothing checks that the two stay in sync, that a destructive tool is covered by an
authorization policy, or that the advertised schema matches what the endpoint actually
validates.

Guren already carries everything an agent tool needs, as machine-readable contracts:

- Route contracts with live Zod schemas (`body` / `params` / `query` / `output`) and
  model binding (`packages/server/src/mvc/Router.ts`)
- Policies evaluated through a single `Gate`
- Resources with statically extracted payload types (`data.gen.ts`)
- An integrity checker (`guren check`) and security audit (`guren audit`) that already
  load *registered* route definitions

What is missing is the layer that turns those contracts into an agent-facing surface —
without duplicating a single schema, and with the framework's existing security
posture (deny by default, machine-checked wiring) extended to it.

Two constraints sharpen the design:

1. **The naive version of this feature is a known anti-pattern.** Anthropic's tool-design
   guidance and the broader ecosystem converged on "do not convert every endpoint into
   a tool"; auto-generated per-endpoint catalogs poison agents and blow up context
   windows. The derivation must be opt-in per route and curated by construction.
2. **Security is the adoption blocker in the market.** Measured OAuth 2.1 compliance in
   deployed MCP servers is ~8.5%; injection-class incidents (Supabase, Asana) came from
   exactly the "app CRUD + privileged agent" shape. A framework-level answer has to ship
   authorization, auditing, and scoped consent as defaults, not documentation.

Guren also already ships an MCP endpoint — but a **development-only** one
(`/_guren/mcp`, gated by `GUREN_MCP=1`, loopback-only, production hard-fail) whose
tools operate on the project on disk for coding agents. This RFC's surface is the
opposite: production-facing tools that operate on application data. The two must stay
cleanly separated.

## Proposed Solution

### Terminology

- **Dev MCP** — the existing `/_guren/mcp` endpoint. Unchanged by this RFC.
- **App MCP** — the new production-facing MCP endpoint provided by a plugin.
- **Agent Contract** — protocol-independent metadata + derivation living in
  `@guren/server` (reaching `@guren/core` via `export *`).

### 1. Route metadata: `.agent()`

Both a fluent builder method and a route-contract key:

```ts
router
  .post('/posts', { body: CreatePostSchema, output: PostOutputSchema }, [PostController, 'store'])
  .name('posts.store')
  .agent({ description: 'Create a blog post as the authenticated user.' })

router.post('/posts', {
  name: 'posts.store',
  body: CreatePostSchema,
  agent: { description: 'Create a blog post as the authenticated user.' },
}, [PostController, 'store'])
```

```ts
export interface AgentRouteMetadata {
  description?: string        // falls back to OpenAPI metadata description ?? summary
  toolName?: string           // defaults to the route name, used verbatim
  expose?: { mcp?: boolean; webMcp?: boolean }   // both default true
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  approval?: 'required'       // server-side approval queue (see Security Layer)
  redact?: string[]           // argument fields masked in audit logs
}
```

Implementation notes (the non-obvious parts):

- `RouteBuilder` (`Router.ts:277`) and its factory (`Router.ts:1062`) gain `agent()`;
  the builder mutates the stored `RegisteredRoute` in place, so this is a two-site change.
- `agent` must be added to the `isRouteContractOptions()` key-sniff list
  (`Router.ts:1501-1519`); otherwise an options object containing only `agent` is
  treated as a handler.
- `RegisteredRoute` and `RouteDefinition` gain `agent?`, serialized in `definitions()`
  (`Router.ts:685`) — the single point through which metadata reaches the CLI.
- `resource()` accepts per-action metadata via `ResourceRouteOptions.agent`
  (`{ index: {...}, store: {...} }`); an action not listed is **not exposed**. The
  option object is threaded into each action's registration; `resource()` still
  returns the router.
- Routes without a `.name()` cannot take `.agent()` (checked): the tool name is the
  identity. Tool names use the route name verbatim — the MCP name grammar
  (`^[A-Za-z0-9._-]{1,128}$`, SEP-986) permits dots, so `posts.store` needs no
  transformation. `guren check` validates charset and length only.
- Annotation defaults follow the MCP spec's semantics, not HTTP intuition:
  GET/QUERY → `readOnlyHint: true`; for everything else `destructiveHint` stays at
  the spec default **true** (declaring `false` is the strong claim "additive only",
  and is checked against the controller body); PUT/DELETE → `idempotentHint: true`.
  Annotations are untrusted hints for client UX; enforcement lives in policies,
  scopes, and the approval queue below.

### 2. Schema derivation

**One Zod → JSON Schema rule.** The existing walker in `@guren/openapi`
(`toOpenApiSchema`, OpenAPI 3.1 = JSON Schema 2020-12) is promoted to a shared
internal module (~~`packages/core/src/internal/zod-json-schema.ts`~~
**amended below**, beside
`zod-compat.ts`); ~~`@guren/openapi` re-exports it~~ **Amended in implementation:**
`@guren/openapi` *imports* it and re-exports nothing. Re-exporting would publish an
internal module through a package's stable index, which is exactly the tier
`contributing/api-stability.md` says it must not reach — the walker stays behind one
deep import, and the only name `@guren/openapi` still exposes is its own
`OpenApiSchemaObject`, now an alias of the walker's `JsonSchemaObject` (OpenAPI 3.1's
Schema Object *is* that dialect, so one definition serves both). As part of the promotion it learns
to carry Zod checks (`min`/`max`/`regex`/`format`) into JSON Schema constraints —
today it drops them.

**Amended again when `deriveAgentTools` landed:** the walker's files moved to
`packages/server/src/internal/`, and `@guren/core/internal/zod-{compat,json-schema}`
became re-export shims so every consumer outside `@guren/server` keeps writing the
core specifier. The reason is build order, not layering: `@guren/core`'s index is
`export * from '@guren/server'`, so core builds *after* server, and a server module
importing a core one closes a cycle — server's declaration build runs
`tsc -p tsconfig.build.json` with `paths: {}` and full checking, so it would look
for a core `dist/` that does not exist yet. Since §8 places `deriveAgentTools` in
`@guren/server`, the one rule has to live in the package both it and the OpenAPI
generator can see. The precedent is `@guren/server/support/expiry`, re-exported by
core's `store-utils.ts` for the same reason.

**Input**: `params` + `query` + `body` merge into one object schema:

- Path parameters missing from a `params` schema are supplemented as required strings
  from the path literal (the rule `@guren/openapi`'s `buildParameters` already applies).
- A non-object `body` schema (array/primitive/union) nests under a `body` key (MCP
  requires an object root).
- Key collisions after supplementation are a check failure.
- Conversion emits the *input* side of coerce/transform/default (the type an agent
  writes). Real validation still happens exactly once, at the application boundary.

**Output** is a three-tier ladder:

| Priority | Source | Result |
|---|---|---|
| 1 | route `output` Zod schema | JSON Schema; `structuredContent`-capable. `output` is already runtime-validated against the response body, so the MCP conformance guarantee holds with no new machinery |
| 2 | `resource` hint | no JSON Schema; the extracted type text from `data.gen.ts` is embedded into the tool description at codegen time (CLI enrichment), plus a type-level `Data.*` reference |
| 3 | neither | no outputSchema; `guren check` warns |

**Two derivation layers, one core rule.** `Router.definitions()` can only carry
resource *class names*; type text and `Data.*` resolution exist only in the CLI's AST
extraction. Therefore:

- `deriveAgentTools(definitions)` (in `@guren/server`): names, input/output JSON
  Schemas, annotations, authorization. Used by the runtime adapter **and** codegen.
- CLI enrichment: resource type text and `Data.*` references, present only in
  `.guren/agents.gen.ts`.

The runtime and generated manifests can differ only in description richness — never
in schemas or exposure.

### 3. Dispatch contract

Tool execution re-enters the application as a real HTTP request:

1. The adapter synthesizes a `Request` and calls
   `app.fetch(request, c.env, c.executionCtx)` — env and execution context are
   forwarded explicitly (`Application.fetch` is a plain delegation; omitting them
   silently loses D1/R2 bindings and `waitUntil` on Workers).
2. **Validation happens once.** The MCP SDK receives JSON Schema (never live Zod), so
   it performs structural validation only; raw arguments are forwarded as the HTTP
   body and validated by the route/controller as usual. Passing live Zod to the SDK
   would apply `coerce`/`default`/`transform` twice.
3. **CSRF**: verification is skipped for requests that carry `Authorization: Bearer`
   **and no session cookie**. CSRF defends cookie ambient authority; a cookie-less
   request has none. The cookie condition matters because CSRF middleware runs before
   auth context and cannot verify the bearer token — with it, a forged Bearer header
   on a cookie-carrying (victim-browser) request is still verified. Cookie issuance
   (`settleCookie`) is unchanged. No endpoint-specific CSRF exemption is needed.
4. **Response mapping** to MCP results:
   - 2xx JSON → `structuredContent` (when an outputSchema is advertised) + serialized text content
   - 2xx Inertia page JSON → unwrapped to `page.props`, **only** for routes with no
     `output` schema (unwrap and outputSchema are mutually exclusive, so the
     advertised schema can never disagree with the returned result)
   - 204 / 3xx → text content describing status and Location, `isError: false`
   - 4xx / 5xx → `isError: true` with the exception handler's JSON body (a 422's
     `{ message, errors }` is an application-level failure, not a protocol error)
   - non-JSON → text summary (rare in practice; check steers agent routes to JSON)

### 4. Authentication, principal, and authorization

**Prerequisite work (independently valuable, Phase 0):**

- `TokenGuard`: a `Guard` implementation backed by `ApiTokenStore`.
- ~~A composite default guard: delegate to token when `Authorization: Bearer` is
  present, session otherwise.~~ **Amended in implementation:** shipped as
  manager-level *name* resolution (`AuthManager.resolveGuardName`, selecting the
  token guard for Bearer requests; optional on `AuthManagerContract`) rather
  than a composite `Guard` object. A composite guard would need its own hidden
  registry name to keep explicit `guard('web')` lookups intact, and the
  selection rule is one predicate — a wrapper class generalizing to N guards
  was judged premature. The bearer predicate is shared with the guard itself
  through `readBearerToken()` so the selector and the selected guard cannot
  disagree about what a bearer request is. (Registering a second guard alone
  is still not enough — `AuthManager` has a single default and
  `RequestAuthContext` always uses it.)
- `Gate` user resolution unified onto the auth context. Today `Gate.resolveUser`
  falls back to `ctx.get('user')` and never consults `guren:auth`, so bearer-authenticated
  requests reach policies with no principal.
- `authorizeMiddleware` / `authorizeResourceMiddleware` gain
  `stampCapabilities({ authorization: { ability } })`, extending RFC 0007's
  `MiddlewareCapabilities` so route → ability becomes declaratively derivable.

**Principal:**

```ts
interface AgentPrincipal {
  kind: 'user' | 'service'
  id: string | number
  abilities?: string[]
}
```

WebMCP → session user. App MCP → bearer token (user if `userId` present, service
otherwise). Policies always evaluate through `Gate`. Token abilities act as a coarse
gate **before** policies and never replace them. The ability vocabulary is fixed:
**ability = tool name = route name.**

**Authorization in the manifest** is emitted only when derivable (from the stamped
capability). Regex detection of `this.authorize(` in controller bodies is a check-only
auxiliary signal, following `guren audit`'s existing fail-closed philosophy.

### 5. Agent Security Layer

Each feature maps to a measured failure mode of the MCP ecosystem.

1. **Scoped consent** (vs. the 8.5% OAuth-compliance problem; direct differentiation
   from Laravel MCP's single `mcp:use` scope):
   - Scope grammar: `tools:read` (all read-only), `tools:posts.*`, `tool:posts.store`.
   - Consent screens (OAuth authorize and token issuance) are **generated from the
     manifest**: the requested scope is expanded to the concrete tool list, split
     read/write, individually deselectable.
   - Default deny: a token without tool scopes calls nothing. `tools:*` requires a
     CLI confirmation and is an audit warning, as are non-expiring tokens
     (`ApiToken.expiresAt` already exists).
   - `guren token:issue --tools 'posts.*' --read-only --expires 30d`.
2. **Default audit logging** (vs. "no approval workflow / no traceability"):
   every invocation — and every denial — is recorded (principal, tool, arguments,
   status, duration, surface) with automatic redaction of sensitive argument names
   plus explicit `redact` metadata. Emitted as framework events (`AgentToolInvoked`,
   `AgentToolDenied`) so existing listeners can forward anywhere. `guren tool:log --tail`.
3. **Rate limits by default**: the App MCP endpoint ships rate-limited (key = token id;
   `CF-Connecting-IP` fallback on Workers), stricter defaults for write tools.
4. **Approval queue and preflight**: `approval: 'required'` tools create a pending
   record and notify approvers through the existing notifications system instead of
   executing; the tool result carries the pending state. `_preflight: true` runs
   validation + scope + policy evaluation only and reports the verdict — the
   middleware chain stopped just before the controller.
5. **Static rules** (`guren check` / `guren audit`), beyond schema wiring:
   - authn is not authz: a non-read-only tool with neither an authorization capability
     nor a detected `this.authorize(` **fails**, even when `auth.userOrFail()` is present.
   - lethal-trifecta lint: a scope granting both an untrusted-content read tool and a
     write tool warns (the Supabase incident shape, detected at issuance).
   - annotation honesty: `destructiveHint: false` on an action whose body deletes/updates warns.
   - OAuth 2.1 + PKCE / RFC 8707 / HTTPS conformance of the App MCP configuration.
   - catalog quality: tool-count threshold and description lint (clients reward small,
     curated catalogs).
6. **Spec-anchored surface**: `guren spec:generate` gains an agent-surface view on the
   existing drift gate (RFC 0004), so any change to a tool's name, schema, description,
   or authorization appears in PR diffs — rug-pull-shaped silent changes cannot pass review.

### 6. Codegen and CLI

- `.guren/agents.gen.ts` joins the codegen order after `data` (it consumes data
  definitions). Lifecycle wiring (doctor's artifact list, check's manifest presence,
  ignore/clean) lands in the same PR.
- `guren tool:list` / `tool:inspect <name>` — the `tool:` namespace is new;
  `agent:init` / `agent:sync` already own `agent:` for the coding-agent harness.
- `guren tool:call <name> --input '{...}' --as user:42 [--preflight]` — invokes through
  `deriveAgentTools` + the dispatch contract (no separate CLI code path); `--as` rides
  the existing `GUREN_TESTING` mechanism.
- `guren tool:dev` — mounts App MCP locally with an ephemeral in-memory token
  (process-lifetime, `MemoryApiTokenStore`) and prints the official MCP Inspector
  invocation. Structurally impossible in production (the ephemeral store is dev-only);
  no new inspection UI is built.
- `@guren/testing`: `app.agent().call(name, input, { as })` with
  `assertOk` / `assertStructured<T>` / `assertDenied` / `assertPendingApproval`;
  `make:feature --agent` scaffolds these tests.

### 7. Protocol adapters

**`@guren/plugin-mcp` (Phase 2).** Installed via `guren plugin @guren/plugin-mcp`;
configured in `config/agent.ts` (`defineAgentConfig({ mcp: { path: '/mcp', auth } })`).
Mounts per-request stateless `McpServer` + `WebStandardStreamableHTTPServerTransport`
(the Dev MCP pattern), derives from the live router at boot, dispatches per §3.
Ships with bearer auth; acting as an OAuth authorization server is out of scope
(separate RFC), except on Cloudflare below. Auto-generated MCP prompts ("how to use
this app's tools", derived from the manifest) ship here; `guren skill:export`
(an Agent Skills SKILL.md generated from the manifest) follows once prompts prove out.

**`@guren/plugin-webmcp` (Phase 3, experimental).** A client module registering
`expose.webMcp` tools from `agents.gen.ts` onto the browser's `modelContext` API,
executing through the typed API client with the normal session + CSRF token flow.
Explicitly experimental while the spec churns.

**`@guren/plugin-cloudflare` (Phase 4a — small).** The adapter itself is
workerd-compatible by construction; the build must stop killing it:
- `buildCloudflareOutput` drops the two MCP SDK stubs when `@guren/plugin-mcp` is a
  declared dependency (Dev MCP stays compiled shut through the `NODE_ENV` define
  regardless — the second guard remains).
- Bundle-size impact is measured in the `GUREN_TEST_WRANGLER=1` probe against the
  free-plan 3 MB budget.
- `guren cloudflare:build --mcp-oauth` (a **build** option — runtime plugin config
  cannot reach the generator, which runs in a separate process) wraps the worker
  export in `workers-oauth-provider`'s `OAuthProvider` and scaffolds the `OAUTH_KV`
  binding as build-owned *only when enabled*. The provider supplies token machinery
  and DCR; Guren scaffolds the session-authenticated authorize/consent routes, which
  render the manifest-derived consent screen. `props` map to `AgentPrincipal`.

**Phase 4b (separate RFC).** Durable agent runtime on the Cloudflare Agents SDK
(`make:agent`). `McpAgent` is deprecated/frozen and is not used; MCP serving needs no
Durable Objects. Known prerequisites recorded now: named-export injection into the
generated worker, `durable_objects` bindings + migrations in the scaffold
(guren.dev's next migration tag is `v3`), a Cloudflare Queues driver, and the
`scheduled` export. Human-in-the-loop enforcement connects `readOnlyHint: false`
tools to elicitation / Workflow approvals server-side.

### 8. Package boundaries and versioning

| Layer | Package |
|---|---|
| `.agent()`, metadata, `definitions()`, `deriveAgentTools`, guard/Gate work, CSRF rule, scope grammar, event types | `@guren/server` (auto-exported by `@guren/core`) |
| Zod → JSON Schema walker | `packages/server/src/internal/`, re-exported by `@guren/core/internal/*` (not public API — see the §2 amendment) |
| codegen, `tool:*` commands, `token:issue`, checks, audits | `@guren/cli` |
| App MCP endpoint, audit-log implementation, approval queue | `@guren/plugin-mcp` |
| WebMCP client | `@guren/plugin-webmcp` |
| Workers build support | `@guren/plugin-cloudflare` |

The boundary is enforced by three standing rules: bundle/cold-start discipline (no MCP
transport in apps that don't opt in — the same reason `plugin-cloudflare` stubs the
SDK today), the opt-in principle for attack-surface features (RFC 0007 lineage), and
contract/adapter separation so protocol churn lands in plugin minors.

All additions are additive: **server minor + core minor** (changesets for both — a
caret range does not deliver new exports otherwise), no ORM changes. New plugins
declare `gurenPlugin.compatibility`. Template adoption of `.agent()` ships in a
follow-up PR after the framework release (`smoke:starter:npm` is correctly red in
between).

### 9. Coding-agent harness

Phase 1c updates the harness in the same release as the checks: a new
`agent-interface` skill (usage, argument-order trap, "authn is not authz"), additions
to the `guren-api` skill, common-pitfalls rules, the api-digest line, and a
`guren_agent_surface` Dev MCP tool (the `tool:list` payload) so coding agents can
query the exposure of a route they are about to edit. Distributed through the RFC 0011
catalog and `agent:sync`.

### 10. Phasing and first PR

- **Phase 0** (three independent PRs): TokenGuard + composite guard + Gate unification;
  authorization capabilities stamping; walker promotion + checks enrichment.
- **Phase 1** (Agent Contract, no protocol): PR-1a route metadata + `resource()` support;
  PR-1b derivation + codegen + `tool:list`/`tool:inspect` + artifact lifecycle;
  PR-1c checks + audits + entity-context + harness.
- **Phase 2**: `@guren/plugin-mcp` with the Security Layer items (scopes, `token:issue`,
  audit log, rate limits, preflight); approval queue in 2.5.
- **Phase 3**: WebMCP (experimental). **Phase 4a**: Workers support. **Phase 4b**: separate RFC.

The first PR is PR-1a alone: the contract types, the builder, serialization, and their
tests — small enough to review, and everything else consumes its shape.

## Alternatives Considered

- **Hand-written tool classes (Laravel MCP's model).** Proven and shipping, but it
  duplicates every schema and leaves route↔tool drift unchecked — the exact failure
  Guren's contracts exist to prevent. Rejected as the primary API; nothing prevents a
  future escape hatch for tools with no HTTP counterpart.
- **Controller decorators (`@AgentTool()`).** Routes own the public surface in Guren
  (method, path, middleware, auth are all visible there); metadata on the controller
  would split the exposure decision across two files.
- **Auto-exposing all routes (fastapi-mcp's model).** Explicitly rejected: the
  ecosystem consensus is that per-endpoint auto-conversion produces oversized,
  context-hostile catalogs. Exposure is opt-in per route; `resource()` actions not
  listed are not exposed.
- **Namespaced tool input (`{ params, query, body }`).** Safer against key collisions
  but hostile to agent ergonomics; flat merge + path-param supplementation + a check
  failure on collision was chosen instead. Recorded here because the collision rule
  makes some valid HTTP shapes inexpressible as tools without a rename.
- **A custom `approval: 'never' | 'always' | 'destructive'` enum.** Replaced by MCP
  ToolAnnotations (hints, spec defaults) for description plus a server-side approval
  queue for enforcement — inventing a parallel vocabulary the clients ignore helps no one.
- **Serving MCP from Durable Objects via `McpAgent`.** Deprecated and feature-frozen
  upstream; the stateless transport needs no DO.
- **Tool-name transformation (`posts.store` → `posts_store`).** Unnecessary — the name
  grammar permits dots — and it manufactured collision cases.
- **Passing live Zod schemas to the MCP SDK.** Causes double application of
  coerce/default/transform; the SDK gets JSON Schema only.

## Migration Path

Purely additive; no existing API changes shape or behavior. Two soft edges:

- The Phase 0 `Gate` user-resolution unification prefers the auth context over the
  legacy `ctx.get('user')` fallback. ~~The fallback is retained after the auth-context
  lookup, so existing apps that set `user` manually keep working; the changelog
  documents the new precedence.~~ **Amended in implementation:** an *attached* auth
  context is authoritative, null included — retaining the fallback after a null
  lookup would let a manually-set `ctx.get('user')` principal resurrect a request
  authentication just rejected (invalid Bearer + manual user), so
  `authorizeMiddleware` could pass where `requireAuthenticated` denies. The
  fallback survives only for requests with no auth context; impersonation/reduced
  principals move to `userResolver` / `gate.forUser(...)`, which keep precedence.
- The CSRF bearer rule only *removes* 419s for cookie-less bearer requests; no
  currently-passing request changes outcome.

## Open Questions

1. Whether the adapter re-parses the response for `structuredContent` or reuses the
   already-validated output body (double-validation cost; implementation detail).
2. The exact glue mapping Cloudflare `OAuthProvider` `props`/scopes onto the
   `AgentPrincipal` ability vocabulary.
3. WebMCP shipping posture: keep `@guren/plugin-webmcp` unpublished until the origin
   trial concludes, or publish under an experimental tag.
4. `listChanged` / tool pagination for large catalogs, and whether `tags` should
   drive filtered exposure.
5. How the Workers build detects `@guren/plugin-mcp` (dependency sniffing vs. an
   explicit `BuildCloudflareOutputOptions` flag).
6. `loadRouteDefinitions()` scans `modules/*` on disk regardless of
   `createApp({ modules })`; an unmounted module's `.agent()` routes would appear in
   generated manifests but not the live registry. Whether routes-check should warn on
   unmounted modules is broader than this RFC.
