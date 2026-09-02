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
internal module (~~`packages/core/src/internal/zod-json-schema.ts`, beside
`zod-compat.ts`~~ **Amended in implementation:** `packages/server/src/internal/`,
both files, with `@guren/core/internal/zod-compat` and
`@guren/core/internal/zod-json-schema` kept as re-export shims so every consumer
outside `@guren/server` keeps writing the core specifier. The reason is build
order, not layering: `@guren/core`'s index is `export * from '@guren/server'`, so
core builds *after* server and a server module importing a core one closes a
cycle — server's declaration build runs `tsc -p tsconfig.build.json` with
`paths: {}` and full checking, so it would look for a core `dist/` that does not
exist yet. Since §8 places `deriveAgentTools` in `@guren/server`, the one rule
has to live in the package both it and the OpenAPI generator can see. The
precedent is `@guren/server/support/expiry`, re-exported by core's
`store-utils.ts` for the same reason);
~~`@guren/openapi` re-exports it~~ **Amended in implementation:**
`@guren/openapi` *imports* it and re-exports nothing. Re-exporting would publish an
internal module through a package's stable index, which is exactly the tier
`contributing/api-stability.md` says it must not reach — the walker stays behind one
deep import, and the only name `@guren/openapi` still exposes is its own
`OpenApiSchemaObject`, now an alias of the walker's `JsonSchemaObject` (OpenAPI 3.1's
Schema Object *is* that dialect, so one definition serves both). As part of the promotion it learns
to carry Zod checks (`min`/`max`/`regex`/`format`) into JSON Schema constraints —
today it drops them.

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
   **and ~~no session cookie~~ no `Cookie` header at all**. **Amended in
   implementation:** the predicate is the raw `Cookie` header's absence, which is
   both stricter and more robust than "no session cookie". The session cookie's
   name is configuration owned by the session middleware mount and invisible to the
   CSRF middleware, and the tempting refinement — keying on the *loaded* session —
   is weaker on both edges: mounted before the session middleware it sees no
   session and fails open for a cookie-carrying victim browser, and an intermediate
   middleware writing one value into a fresh session turns a genuinely cookie-less
   client into a 403. Ambient authority requires a cookie, so the header's absence
   is proof by itself, independent of mount order; dispatch synthesizes cookie-less
   bearer requests by construction, and a bearer request carrying any cookie simply
   verifies as before. Bearer detection is the shared `readBearerToken()`, so this
   rule and token authentication cannot disagree about what a bearer request is.
   Cookie issuance (`settleCookie`) is unchanged. No endpoint-specific CSRF
   exemption is needed.
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
2. ~~**Default audit logging**~~ **Audit logging** (vs. "no approval workflow / no
   traceability"):
   every invocation — and every denial — is ~~recorded~~ reported (principal, tool, arguments,
   ~~status, duration,~~ surface) with automatic redaction of sensitive argument names
   plus explicit `redact` metadata. Emitted as framework events (`AgentToolInvoked`,
   `AgentToolDenied`) so existing listeners can forward anywhere. `guren tool:log --tail`.
   **Amended in implementation:** the *events* are default-on; the *sink that writes them
   down* is opt-in — one line of configuration, `mcpPlugin({ audit: { file } })` for JSONL
   through the existing daily-file channel, or `{ sink }` for anything else. Nothing is
   written until an application asks for it. A framework that appended to a file on its
   own would be wrong on two of the runtimes this endpoint is specified to run on: Workers
   has no writable filesystem, and Lambda's is ephemeral, so the trail would degrade
   differently per deployment while the configuration looked identical. An audit trail
   whose completeness depends on where it happens to be running is worse than one an
   operator knows is absent — the second can be fixed, the first is trusted. What makes
   the opt-in cheap is that the events fire regardless: an application already forwarding
   framework events is already forwarding these, and `guren tool:log` names the missing
   configuration line rather than printing an empty list.
   **Amended in implementation:** status and duration belong to *invocations* only.
   An adapter-level denial (`auth`, `scope`, `approval`, `rate-limit`) refuses before
   synthesizing the request, so no HTTP happened and there is no status to record —
   `AgentToolDenied` carries a `reason` instead. A `Gate` policy denial is not a
   denial event at all: policies evaluate inside the dispatched request, so it is an
   `AgentToolInvoked` with status 403 — which is why the reason union has no
   `'policy'` member.
   **Amended in implementation:** the `'cli'` surface records too. `guren tool:call`
   was the one member of `AgentSurface` that emitted nothing, so a developer could
   call a write tool from a terminal — as any user, via `--as` — and the trail would
   show that nothing happened. It now records an `AgentToolInvoked` carrying
   `surface: 'cli'`, the tool name, the arguments masked through the *called* route's
   own `.agent({ redact })` list, the HTTP status, and the duration of the dispatch.
   It records through the emitter the **application** configured, resolved from the
   service container rather than constructed: `@guren/plugin-mcp` publishes the one it
   built from its `audit` option, so a CLI call lands in the same file, in the same
   format, as an MCP call. An application that configured no sink publishes none, and
   the command records nothing — the same absence the endpoint has, not a second sink
   writing somewhere the operator does not look.
   A `--preflight` is recorded as `guren.preflight`, never under the tool it rehearsed,
   which is the rule the App MCP endpoint already follows: the handler did not run, so a
   record naming `posts.destroy` with a success status would be indistinguishable from a
   destroy that happened. The probed tool rides in the record's arguments, in the same
   `{ tool, input }` shape the meta-tool's own arguments take on MCP. That is decided by
   the *answer*, not by the flag — a `--preflight` against an application predating the
   preflight seam runs the call for real, and that write is recorded under the real tool.
   This surface emits **no** `AgentToolDenied`. Each of the four reasons names a check
   an adapter performs before synthesizing a request, and this one performs none: it
   holds no token to scope and no rate budget, and it dispatches directly. Its own two
   refusals — a missing path parameter, a URL dot-segment — are argument errors that
   none of the four reasons describes, and no request is sent for them, so there is no
   status a record could carry. What the *application* refuses is a response, and so an
   invocation with that status, exactly as on every other surface.
   The principal is `{ kind: 'user', id }` when `--as` names one and `null` otherwise,
   with `abilities` omitted rather than empty: abilities belong to a token, and this
   surface presents none. `surface: 'cli'` is what carries the standing fact that no
   credential was verified, which is why the principal does not have to hedge — and why
   collapsing it to `null` would be worse, making an impersonation indistinguishable
   from an anonymous call.
3. **Rate limits by default**: the App MCP endpoint ships rate-limited (key = token id;
   `CF-Connecting-IP` fallback on Workers), stricter defaults for write tools.
4. **Approval queue and preflight**: `approval: 'required'` tools create a pending
   record and notify approvers through the existing notifications system instead of
   executing; ~~the tool result carries the pending state~~ the tool result carries
   the pending state **as an error result with a JSON body**. `_preflight: true` runs
   validation + scope + policy evaluation only and reports the verdict — the
   middleware chain stopped just before the controller. **Shipped as** a router
   seam mounted last before the handler, so every gate in front of it is the
   real one: an unauthenticated call is still the auth middleware's 401 and an
   unauthorized one its 403, not a second copy of either rule. Two deviations
   worth recording. The seam validates the *body* itself, although a controller
   route normally leaves that to `validateBody()` — stopping before the
   controller is the whole point, so the alternative was a verdict that silently
   never checked the field an agent is most likely to get wrong. And only routes
   declaring `.agent()` honour the header, so no ordinary endpoint changes
   behaviour on a header any client can set.

   **The `_preflight: true` argument does not ship on MCP, and neither can the
   pending-approval result as described.** Both were specified as a *different
   shape of success* from the same tool, and MCP forbids exactly that: a tool
   advertising an `outputSchema` must answer with `structuredContent`
   conforming to it unless the result is an error (verified against the SDK
   client, which throws `-32600` on a conforming-schema tool that returns plain
   content and `-32602` on structured content of the wrong shape). A verdict
   conforms to no route's output, and reporting "allowed" as an error would be
   worse than not offering it. So on MCP both need a **companion tool** with its
   own result schema — one design problem, ~~deferred to 2.5 rather than solved
   twice, differently~~. The seam itself is server-side and unaffected: surfaces
   not bound by that rule (`guren tool:call`, `@guren/testing`) reach it through
   `BuildToolRequestOptions.preflight`. Nothing was lost in the meantime —
   `_preflight` was never advertised in any tool's input schema, so no client
   could have discovered it.

   **Amended in implementation (Phase 2.5a):** the preflight half of that
   companion shipped as **one meta-tool for the whole catalogue**,
   `guren.preflight`, taking `{ tool, input }` and answering with a verdict
   under its own output schema. Per-tool companions (`posts.store.preflight`
   beside `posts.store`) were the obvious alternative and were rejected: they
   double the tool count, which collides with this RFC's own catalogue-quality
   rule in §5.5 — clients reward small, curated catalogues, and doubling one to
   describe it is the wrong trade. The approval half stays with the queue in
   2.5; it needs a record to report, which the meta-tool has nothing to say
   about.

   **Amended in implementation (Phase 2.5b): the approval queue ships.** The
   pending-approval result *is* expressible on MCP after all, on one measured
   fact that was not established when the paragraph above was written: an
   `isError: true` result is delivered to the client with its `content`
   intact, **including for a tool that declares an `outputSchema`** — no
   `-32600`, no structured-content validation. Measured directly against the
   SDK client with a two-tool server, one plain and one with an output schema,
   both returning `isError` with a JSON body; both bodies arrived whole. So a
   refusal can carry a machine-readable body, and the `requestId` an agent has
   to poll with reaches the caller. It rides as a second content block rather
   than as `structuredContent`, which MCP defines for *successful* results.

   What shipped, and every deviation from the design as written:

   - **The store is the application's** (`AgentApprovalStore`, four methods:
     `create`, `find`, `findMatch`, `consume`), opt-in through
     `mcpPlugin({ approvals: { store, notify, ttlMs } })` with no default
     implementation — the audit sink's precedent, for the audit sink's reason.
     Unconfigured, an `approval: 'required'` tool is still refused fail-closed
     and is absent from `tools/list`; the refusal names the configuration line.
     A queue that quietly fell back to process memory on Workers would answer
     "approved" for a record the next isolate never saw.
   - **Approval binds to the arguments**, through one canonicalization
     (`canonicalizeAgentApprovalInput`) hashed by `agentApprovalFingerprint`,
     with both the creation and the lookup path reading that single function.
     Key order does not change the answer, at any depth; types, array order,
     and absent-vs-null deliberately do. The fingerprint is taken over the
     **raw** arguments while the stored record carries the *redacted* copy —
     fingerprinting the redacted copy would make approving
     `users.setPassword {id: 5, password: '…'}` authorize the same call with a
     different password. The record stores only the hash, so the queue does
     not become a second place secrets live.
   - **Single-use and expiring.** `consume` is a compare-and-set the store
     owns; expiry is judged by framework code against a clock passed in, never
     filtered by the store, because a store that forgot to compare would fail
     open silently. **Consumption happens before dispatch**: an approval is
     permission for one attempt, not one success. Consuming afterwards would
     let concurrent calls all pass the same check and would make a call that
     crashed mid-flight replayable. An approval burned on a call that then
     answered 500 is the accepted cost, and the operator is told which half
     failed.
   - **Deviation, forced: a pending match is reused rather than re-filed.** The
     design specified the lookup as "the record that is currently approved and
     unconsumed". Implemented that way, an agent polling by re-calling the tool
     creates an unbounded number of records and notifies the approvers once per
     poll, so `findMatch` returns the unconsumed record in *any* state and a
     second call quotes the id of the one already waiting.
   - **Deviation, chosen: a rejected call is not re-asked** while its record
     is unexpired. A human answered this exact call; letting the next call
     re-file it would make a rejection cost nothing to overturn by retrying.
     The refusal reports `status: 'rejected'` distinctly so the caller can tell
     it from a pending wait worth polling. After expiry, asking again is a new
     question and files a new record.
   - **Notifications are the application's decision.** `notify(request)` hands
     the record over; the framework never chooses recipients, because it cannot
     see the list. `AgentApprovalRequested` ships as a ready-made
     `Notification` so the common case is one line through the existing system.
     The record is persisted *before* `notify` is called and the call is not
     awaited: a channel that is down costs an approver an email, never the
     request or the tool call, and the failure is warned about with the request
     id in it.
   - **`guren.approval_status`** is a second reserved meta-tool,
     `{ requestId }` in, its own output schema out. A caller may read only the
     status of a request it created: an id belonging to someone else answers
     *exactly* as an unknown id does, converged on one branch in code rather
     than left to two call sites to agree, because any difference between the
     two answers enumerates other principals' pending actions. The audit trail
     is where the distinction is kept (200 vs 404 under
     `tool: 'guren.approval_status'`); the caller is told the same thing either
     way.
   - **Deviation, chosen: the status tool is listed only when a queue exists**,
     as well as when the token grants at least one tool. The design gave only
     the second half. On a server with no queue the tool could answer nothing
     but "no such request", and advertising it would be the unconfigured queue
     looking like a working one. The `preflightable` value is reused rather
     than recomputed, so the two meta-tools cannot drift on what a token grants.
   - **An approval-gated tool is listed once a queue exists.** Without one it
     stays out of `tools/list`, uncallable. `gateToolCall` therefore keeps that
     question synchronous and side-effect-free: `tools/list` calls it per tool
     per listing, and an approval *resolution* there would file a request and
     page the approvers every time any client connected.
   - **`guren check` reports an `approval: 'required'` route in an app whose
     `mcpPlugin({ … })` call configures no queue** — a **fail**, on positive
     evidence only. A call whose options this check cannot read (a variable, a
     spread) and an app with no readable call at all both say nothing: `guren
     check` has no per-finding ignore configuration, so an unsuppressible false
     positive is the failure to avoid, which is the same reason the
     authorization rule warns on a body it could not read. Given readable
     evidence the tool is categorically uncallable, which is a wiring mistake
     with a one-line fix rather than a policy, so it fails like the naming
     rules do. The option key is read from `@guren/core`, never restated,
     because the CLI cannot import the plugin.

   Four consequences the implementation settled. Checking a tool requires the
   **same scope** as calling it, or the companion becomes a way to probe the
   authorization surface of tools the token cannot call. A tool declaring
   `approval: 'required'` **is** checkable even though it is not callable —
   "would this be accepted if it were approved?" is exactly the question an
   approval gate creates, and the rehearsal executes nothing. `guren.preflight`
   is listed only for a token that grants at least one tool, since a token that
   can call nothing has nothing to rehearse and listing it would map the
   surface. Rehearsing is not requesting: preflight of an approval-gated tool
   creates no pending record and notifies nobody. And the invocation is audited as `AgentToolInvoked` with
   `tool: 'guren.preflight'` — an agent probing what it may do is what an audit
   trail wants to show — while the checked tool gets no record, because nothing
   was invoked. The name is reserved: an application route whose `.agent()`
   tool name claims it **fails** `guren check`, and the endpoint drops it
   rather than serving two tools under one name, which an MCP client answers by
   rejecting the entire catalogue.

   The verdict also reports what it could *not* check. A route may authorize
   inside its action (`await this.authorize(...)`), which `guren check` accepts
   and which a seam stopping before the handler structurally cannot reach, so
   `allowed: true` carries `unverified: ['authorization']` whenever no
   authorization capability is present on the middleware chain.
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
  `assertOk` / `assertStructured<T>` / `assertDenied` / ~~`assertPendingApproval`~~;
  `make:feature --agent` scaffolds these tests.
  **Amended in implementation:** `assertPendingApproval` ships with the approval
  queue (2.5), not here. There is nothing for it to assert yet: the queue is
  unimplemented, and the testing path does not go through the plugin at all —
  the gate that would produce a pending verdict lives in `@guren/plugin-mcp`,
  while `app.agent()` dispatches straight into the application. An assertion
  that can only ever fail, or only ever pass vacuously, is worse than an absent
  one.
  **Amended again in implementation (Phase 2.5b): the queue shipped and
  `assertPendingApproval` still does not.** The reason is now measured rather
  than predicted. The queue lives entirely in `@guren/plugin-mcp`'s gate — the
  store, the fingerprint match, `consume`, the pending refusal — and
  `app.agent()` reaches `buildToolRequest` directly, so no code path under
  `@guren/testing` can produce a pending state for the assertion to find. The
  two ways to change that were both rejected: making `@guren/testing` depend on
  a protocol adapter inverts the layering the whole dispatch contract exists to
  keep (`@guren/testing` reaches the *same seam* the adapter does, which is
  what makes its assertions meaningful), and reimplementing the gate inside the
  testing package would be a second copy of the binding, expiry and single-use
  rules — the one thing §5.4's implementation is written to avoid. The queue is
  tested where it lives, through the real MCP client, in
  `packages/plugin-mcp/src/approval.test.ts`. An application testing its own
  approval-gated route asserts against its own store, which it owns. `assertDenied` is likewise narrower than it reads on this surface and
  says so: it means the *application* answered 401/403, because `@guren/testing`
  has no token issuer and therefore cannot reach a scope denial.
  `guren tool:call` makes the same distinction for the same reason.

### 7. Protocol adapters

**`@guren/plugin-mcp` (Phase 2).** Installed via `guren plugin @guren/plugin-mcp`;
~~configured in `config/agent.ts` (`defineAgentConfig({ mcp: { path: '/mcp', auth } })`)~~.
**Amended in implementation:** configured directly on the factory
(`mcpPlugin({ path: '/mcp' })`), like every other Guren plugin; a
`defineAgentConfig` wrapper can layer on later without changing the plugin's
contract. The per-request server is the SDK's *low-level* `Server`, not
`McpServer` — the tools already carry JSON Schema and the high-level API wants
live Zod, which §3.2 forbids handing over. Further shipped judgments:
tools/list is filtered to the token's scopes (an ungranted catalog would map
the write surface for a read-only token); ~~an `approval: 'required'` tool is
refused fail-closed until the 2.5 queue exists (though it can still be
*checked* — see the preflight amendment in §5.4)~~ **— the queue shipped in
2.5b; such a tool is now listed and callable when `approvals` is configured,
and the fail-closed refusal remains exactly what an unconfigured server
answers, naming the configuration line (see §5.4)**; ~~`_preflight` is deferred to a
follow-up (it needs a server-side seam to stop the chain before the
controller)~~ **— shipped since, as a router seam reached from the
`guren.preflight` meta-tool; see §5.4**; and bearer auth
answers 401 + `WWW-Authenticate: Bearer` at the
transport boundary, before any MCP framing. Mounts per-request stateless
server + `WebStandardStreamableHTTPServerTransport`
(the Dev MCP pattern), derives from the live router at boot, dispatches per §3.
Ships with bearer auth; acting as an OAuth authorization server is out of scope
(separate RFC), except on Cloudflare below. Auto-generated MCP prompts ("how to use
this app's tools", derived from the manifest) ship here; `guren skill:export`
(an Agent Skills SKILL.md generated from the manifest) follows once prompts prove out.

**`@guren/plugin-webmcp` (Phase 3, experimental).** A client module registering
`expose.webMcp` tools from `agents.gen.ts` onto the browser's `modelContext` API,
executing through the typed API client with the normal session + CSRF token flow.
Explicitly experimental while the spec churns.

**Amended in implementation.** Execution goes through `buildToolRequest` /
`mapToolResponse` directly rather than the typed API client — the same dispatch
contract §3 defines, reached through a new browser-safe `@guren/core/agent`
subpath. The API client keys on route *names* and knows nothing of
`inputSources`, so it cannot take a flat tool call apart; routing WebMCP
through it would have meant a second request-splitting rule beside the one §2
already derives. Three further judgments, each a deliberate asymmetry with App
MCP rather than an oversight:

- **No audit-sink coverage.** A WebMCP call is an ordinary same-origin `fetch`
  from the page; it reaches no `AgentToolInvoked` / `AgentToolDenied` sink,
  because there is no server-side adapter in the path to emit one. The
  `X-Guren-Agent-Surface: webmcp` header is *client-controlled* — an audit
  keyed on it would be suppressible by the very caller it claims to record,
  which is worse than no audit at all. Application-level HTTP logging covers
  these requests exactly as it covers every other browser request, and the
  route's own policies still run.
- **No scope filtering.** App MCP filters `tools/list` to the token's scopes; a
  session carries no scopes, so the in-page agent sees every `expose.webMcp`
  tool at the signed-in user's full authority. Policies still gate execution —
  exposure is not permission — but on this surface `expose.webMcp` is the whole
  exposure decision, and it defaults to `true`.
- **Redirects are refused, not followed.** Dispatch pins the request to
  `mode: 'same-origin'` and `redirect: 'manual'`. A tool call carries the
  session cookie's authority and the CSRF token header, and `fetch` strips only
  `Authorization` across a cross-origin redirect — so one open redirect in the
  application would replay both to another host. The cost is that a redirecting
  route reports "a redirect the client did not follow" rather than App MCP's
  `HTTP 302 (Location: …)`: an opaque redirect has no readable Location in a
  page. Accepted.

**Open Question 3 resolved:** published normally — not withheld until the origin
trial concludes, and not behind a dist-tag. The `0.x` version line is the
experimental signal. A tag would keep the package out of the one mechanism that
delivers fixes to the people already using it, which is exactly what a surface
tracking a moving draft needs most.

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

**Amended in implementation.** Corrections, each widening what the bullets above
described:

- **Open Question 5 resolved: dependency sniffing.** `@guren/plugin-mcp` under the
  app's `dependencies` *is* the opt-in — nothing else is asked, because there is
  nothing else to ask. An app that installed the plugin and mounted it wants the
  endpoint to work, and a build flag it must also remember to pass is one more way
  for the endpoint to be silently compiled shut on a platform. `devDependencies` do
  not count: they never ship, so there is no deployed endpoint to protect.
  `appUsesMcpPlugin()` answers `false` for an absent or unreadable manifest — no
  opt-in evidence is not opt-in, and that direction preserves today's behaviour.
- **The fix is not Cloudflare-only.** Lambda and Vercel read the same
  `DEV_ONLY_MODULES` list and carried the same defect; both additionally routed
  *every* unlisted `@modelcontextprotocol/sdk/*` subpath to a throwing stub, which
  also killed the plugin's static imports of `server/index.js` and `types.js`. So
  the rule lives in `@guren/core/internal/deploy-build`
  (`appUsesMcpPlugin` + `stubbableDevOnlyModules`) and all three platforms read it.
- Exactly **one** entry is dropped: the transport. `server/mcp.js` (the Dev MCP's
  `McpServer`), `@guren/cli`, `bun:sqlite` and `vite` stay stubbed for every app —
  "the two MCP SDK stubs" in the bullet above overstated it.
- Cloudflare's aliases are baked into the app's *committed* `wrangler.jsonc`, which
  the scaffold writes once and never overwrites. An app that adds the plugin later
  would keep the stale alias forever, so the build **fails** and names the one line
  to delete rather than warning.

`--mcp-oauth` shipped as designed, in a second PR. What the design left open:

- **Open Question 2 resolved: `props` → `AgentPrincipal`.** The consent flow is
  session-authenticated, so the only principal an OAuth grant can carry is the
  signed-in user: `props` are `{ userId: string | number, scopes: string[] }`,
  mapped by `mcpOAuthPropsToAuth` to `{ kind: 'user', id: userId, abilities: scopes }`.
  No service principals — nothing in a browser consent authenticates a machine.
  `userId` passes through **unchanged** in either type, because `AgentPrincipal.id`
  admits both and the application's own policies look up by it; coercing in the glue
  and nowhere else is how a policy lookup silently misses. `scopes` are the same
  values the grant was issued with, in the §5.1 grammar, so the consent screen's
  checkboxes carry `tool:<name>` and not bare tool names — the grammar ignores
  everything outside `tool:` / `tools:`, which would otherwise grant a screenful of
  tools that reach nothing. Props are validated defensively: they come from the
  provider's encrypted storage, but they are still parsed data that outlived the
  version of the flow that wrote them, and an unreadable shape is refused rather
  than turned into a partial principal.
- **The handoff into the endpoint is an in-process request-identity seam, not a
  header** — the pattern §2 of RFC 0017 specifies for its durable principal
  handoff, adopted here first. `presentExternalMcpAuth(request, auth)` registers the
  grant in a `WeakMap<Request, ExternalMcpAuth>` keyed on the exact object the
  generated worker hands to `app.fetch`; the endpoint consults it before any bearer
  machinery. An `X-Guren-*` envelope would have been one `curl` away from being
  asserted by any network caller, and the endpoint could not have told the worker's
  claim from an attacker's. A rebuilt or cloned `Request` does not carry it.
  `mcpPlugin({ auth: 'external' })` is the fail-closed complement: a request without
  the seam is refused rather than offered the bearer path.
- **The provider package is an explicit app dependency**, not a dependency of
  `@guren/plugin-cloudflare`. The generated worker imports
  `@cloudflare/workers-oauth-provider` and wrangler resolves that from the app's own
  install, so the build fails with `bun add …` when it is absent — the opt-in cost
  of an opt-in feature belongs to the people opting in, and the large majority of
  Workers deployments will never front an OAuth provider.
- **No `Authorization` is forwarded into the dispatched request** on this surface.
  The inbound bearer is the *provider's* access token, which the application's own
  token guard has never seen and cannot verify. So the endpoint's scope gate and the
  route's policies run, but a route behind `requireApiToken` answers 401 to an
  OAuth-authorized caller. Closing that means the auth context itself consulting a
  principal seam, which is RFC 0017 §2.
- **DCR is wired, knowingly on a deprecated path.** `clientRegistrationEndpoint` is
  RFC 7591 dynamic client registration, deprecated in the MCP 2026-07-28 line in
  favour of Client ID Metadata Documents; this wiring follows what shipping MCP SDK
  1.x clients use today, and the v2 migration is tracked with the rest of the SDK-v2
  boundary (RFC 0017 §8).
- **The flag is recorded nowhere.** Passing it on every build is the contract, as a
  build option must be. The drift it leaves detectable is the other direction: a
  committed `wrangler.jsonc` binding `OAUTH_KV` while a build omitted the flag is
  warned about by name, because that build silently replaces a deployed worker with
  one whose `/oauth/token` 404s.

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
  audit log, rate limits, preflight); the `guren.preflight` companion tool in 2.5a,
  the approval queue and `guren.approval_status` in 2.5b.
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
2. ~~The exact glue mapping Cloudflare `OAuthProvider` `props`/scopes onto the
   `AgentPrincipal` ability vocabulary.~~ **Resolved in implementation:**
   `mcpOAuthPropsToAuth` maps `{ userId, scopes }` onto a `kind: 'user'` principal
   whose abilities *are* those scopes. See the §7 amendment.
3. ~~WebMCP shipping posture: keep `@guren/plugin-webmcp` unpublished until the origin
   trial concludes, or publish under an experimental tag.~~ **Resolved in
   implementation:** published normally, with the `0.x` line as the experimental
   signal. See the §7 amendment.
4. `listChanged` / tool pagination for large catalogs, and whether `tags` should
   drive filtered exposure.
5. ~~How the Workers build detects `@guren/plugin-mcp` (dependency sniffing vs. an
   explicit `BuildCloudflareOutputOptions` flag).~~ **Resolved in implementation:**
   dependency sniffing, shared by all three deploy plugins rather than Workers
   alone. See the §7 amendment.
6. `loadRouteDefinitions()` scans `modules/*` on disk regardless of
   `createApp({ modules })`; an unmounted module's `.agent()` routes would appear in
   generated manifests but not the live registry. Whether routes-check should warn on
   unmounted modules is broader than this RFC.
