# RFC: Durable Agent Runtime — Stateful Agents as Application Citizens

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-09-02
**Status:** Draft

> Phase 4b of RFC 0016 was deliberately split into this document: the agent
> *interface* (tools derived from route contracts) is settled and shipped, while
> the agent *runtime* — the thing that calls those tools over hours and days —
> depends on a platform substrate that was still moving when 0016 was accepted.
> The substrate has since stabilized enough to design against: the Cloudflare
> Agents SDK's `Agent` class has a coherent surface (state, per-instance
> SQLite, alarm-backed schedules, fibers, workflows; `agents` 0.20.x at the
> time of writing — the package moves fast, and §8 pins how this RFC tracks
> it), `McpAgent` is deprecated and feature-frozen in favor of
> `createMcpHandler`, and MCP itself shipped a stateless core (2026-07-28).
>
> **Prerequisite:** RFC 0016 Phase 4a (the deploy builds stop stubbing the MCP
> SDK transport for apps that depend on `@guren/plugin-mcp`) is in flight and
> must land first. Until it does, nothing from `@guren/plugin-mcp` — including
> the approval queue this RFC reuses — exists on a deployed Worker.

## Problem

RFC 0016 gave applications an agent-facing surface: every `.agent()` route is a
tool with a schema the endpoint actually validates, behind scopes, policies,
approvals, and an audit trail. What it deliberately did not provide is a place
for the application to **host its own agents** — long-lived, stateful processes
that act *through* that surface: a support triager that watches a mailbox and
files tickets, a nightly researcher that accumulates findings over a week, an
operations agent that proposes a destructive change and then waits — possibly
for days — for a human to approve it.

Guren's existing execution primitives are the wrong shape for this:

- **Jobs** are stateless work units. A job that needs yesterday's conclusions
  must externalize them; a job cannot park mid-plan waiting for a human.
- **The scheduler** fires stateless commands on cron. An agent's timers are
  per-instance and data-dependent ("check this PR again in an hour").
- **Sessions** belong to browsers, not to a process with its own identity.

What an agent runtime needs is durable identity (one addressable instance per
conversation/task), persistent state that survives deploys, per-instance
timers, and the ability to suspend for human input without holding a
connection. This is the shape of a Cloudflare Durable Object, and the
Cloudflare Agents SDK (`agents` npm package) packages it as an `Agent` class:
embedded per-instance SQLite (`this.sql`), synced state (`this.state` /
`this.setState`), durable schedules (`this.schedule`), WebSocket and email
entry points, fibers, and workflow integration. Guren already deploys to
Workers (RFC 0003).

One precision the design must not blur: **an Agent instance is durable
identity and durable state, not a durable JavaScript stack.** Instances are
evicted after inactivity; an in-flight method does not survive eviction. Work
that must survive is checkpointed into state or DO SQLite, resumed by a
schedule, run as a fiber, or delegated to a Workflow — and this RFC's own
constructs (§5, the pending-approval ledger) follow that rule rather than
pretending a `await` can sleep for a week.

Two constraints sharpen the design, both inherited from 0016:

1. **No second privileged path.** The measured failure mode of agent
   frameworks is an agent layer that reaches into application internals
   directly — models, raw SQL — acquiring authority no policy ever granted
   and leaving no trail. An agent that is *part of* the application is the
   easiest place in the world to commit this sin.
2. **Opt-in attack surface** (RFC 0007 lineage). An agent runtime adds
   externally reachable entry points and a new class of autonomous principal.
   Nothing here may mount by default, and every new entry point is
   default-deny.

## Proposed Solution

### 1. The invocation pipeline moves down to `@guren/server`

Today the steps that make a tool call trustworthy — scope check, approval
gate, redaction, audit emission, duration measurement — live in
`@guren/plugin-mcp`, wrapped around the shared dispatch (`buildToolRequest` /
`app.fetch` / `mapToolResponse`). `app.fetch` itself only executes the HTTP
request. A durable agent that called `app.fetch` directly would therefore
*bypass* scopes, approvals, and the audit trail while this RFC claimed
otherwise.

So the first deliverable is an extraction, not an addition: a
protocol-neutral **invocation pipeline** in `@guren/server` —

```
resolve principal → scope gate → approval gate → dispatch → redact → audit
```

— that `@guren/plugin-mcp` refactors onto (transport, bearer verification,
and rate limiting stay in the plugin) and the durable tool client consumes
from day one. The approval gate is part of the pipeline from Part 1: a call to
an `approval: 'required'` tool with no approval store configured **fails
closed**, exactly as an unconfigured App MCP server refuses it today. The
audit emitter binding (`AGENT_AUDIT_BINDING`) already lives in
`@guren/server`; the pipeline emits through it, so a durable call is audited
without `plugin-mcp` present.

This is the RFC's largest refactor and it is behavior-preserving for MCP by
construction: the pipeline's tests move with the code, and the plugin's
existing suite (scope denial, approval verdicts, redaction, audit records)
runs unchanged on top.

### 2. The principal handoff is a seam, never a header

The durable client dispatches in-process. Its principal —
`{ kind: 'service', id }` with the scopes declared at registration — is
handed to the pipeline as a **dispatch option**, and the pipeline installs it
through a server-internal seam (the pattern the preflight seam established: a
leaf module both halves import, nothing published, nothing spelled as an HTTP
header). Concretely: the seam is a `WeakMap<Request, InstalledPrincipal>` in
that leaf module — the pipeline registers the exact `Request` object it hands
to `app.fetch`, and the auth context's lazy resolution consults the map before
any header-based guard. A value keyed on object identity has no wire
representation to forge, needs no AsyncLocalStorage (works identically on
workerd and Bun), and is garbage-collected with the request. `Gate` accepts
the installed principal the way it accepts a token-authenticated user today.

The same seam mark settles CSRF. A seam-marked request carries no cookies by
construction — the pipeline builds it from scratch — and CSRF exists to stop
cookie-borne ambient authority, so the CSRF middleware treats a seam-marked
request the way it treats a cookie-less bearer request today (RFC 0016's §3
rule). The middleware *asserts* the no-cookie invariant rather than assuming
it: a seam-marked request that somehow carries a `Cookie` header is refused
outright, so the exemption cannot be widened by a bug elsewhere. Without
this, a mutating durable call — no cookies, no `Authorization` header, no
XSRF token — would 419 before ever reaching the scope gate.

What this is *not*: it is not a header (`X-Guren-*` anything a network caller
could forge), not a stored `ApiToken` (nothing to store — the principal is
minted from the registration each call, inside the trust boundary), and not a
change to bearer auth. The one schema prerequisite recorded in 0016 —
`ApiToken.userId` optionality for `kind: 'service'` — is *dropped* from this
RFC: it belongs to stored service tokens, which this design no longer needs.

Principal identity is **per instance**: `id = 'agent:<name>:<instance>'`.
Approvals are isolated by `kind + id` in the queue, so a class-wide id would
let one instance observe and spend an approval another instance requested —
the per-instance id closes that.

### 3. `@guren/plugin-agents`

A new plugin package, installed via `guren plugin @guren/plugin-agents`,
depending on the `agents` SDK; the package boundary keeps that dependency out
of every app that doesn't opt in. `make:agent Triager` scaffolds
`app/Agents/Triager.ts`:

```ts
import { GurenAgent } from '@guren/plugin-agents/agent'

interface TriagerState {
  lastRunAt: string | null
}

export class Triager extends GurenAgent<Env, TriagerState> {
  initialState: TriagerState = { lastRunAt: null }

  async onStart() {
    await this.schedule('0 7 * * *', 'sweep')      // cron form
  }

  async sweep() {
    const posts = await this.tools.call('posts.index', { published: false })
    // … checkpoint conclusions into this.setState / this.sql, not locals
    await this.schedule(3600, 'sweep')             // delay-seconds form
  }
}
```

`GurenAgent` extends the SDK's `Agent`; every SDK capability passes through
untouched. Registration is a config file the build can also read:

```ts
// config/agents.ts
export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      scopes: ['tool:posts.index', 'tool:tickets.store'],
    },
  },
})
```

The import is the **`/agent` subpath**, not the package root, and that is a
constraint rather than a style choice: `agents` statically imports
`cloudflare:workers` and `cloudflare:email`, so evaluating it outside workerd
throws — and the package root is what `src/app.ts` imports to register the
plugin, on Bun, in `guren dev`. The root entry holds the config grammar, the
plugin, the runtime latch and the tool client; only `/agent` holds the class.

- `module` / `export` are explicit because the build's named-export injection
  (§6) cannot recover a source path from a runtime class value. The grammar
  is deliberately static: literal strings only; a spread, computed key, or
  re-exported config fails `guren check` with the reason.
- Scopes use the shipped grammar (`tool:<name>`, `tools:read`) — bare names
  grant nothing in that grammar and the config validator rejects them.
  `tools:*` and prefix grants are rejected at registration for the same
  reason 0016 rejected them for stored tokens: an unattended principal must
  not acquire consent to tools that don't exist yet. `tools:read` is expanded
  to the read-only tools *at registration check time* by `guren check`, and
  the runtime re-expands at boot — both fail closed on drift.

### 4. Agents act through the tool surface — and the boundary is enforced

`this.tools.call(name, args)` enters the §1 pipeline with the agent's
principal. Same scope denial, same approval gate, same redacted audit record
as every other surface; `AgentSurface` gains a `'durable'` value, and the
exhaustiveness pattern in `agent/audit.ts` turns that into a compile error at
every consumer. A per-instance rate budget (calls per minute, pending
approvals cap) ships **in the same part as the client itself** — there is no
release in which an unattended caller exists without its meter, because an
unattended loop otherwise mints unbounded approval records and notifications.
(Part 1's pipeline has no unattended callers; the budget hook is designed
into the pipeline there and first *used* by the client in Part 2.)

Direct write access to application internals from agent code is an
**architecture rule, not advice**: `make:agent` extends `guren.arch.ts` with a
rule forbidding `app/Agents/**` from importing the app's models, `db/`, or
`@guren/orm`, enforced by the existing `guren check --arch` CI gate, with the
existing per-rule escape (an explicit, reasoned exemption in the config —
visible in review, not a comment). The honest limits are stated rather than
papered over: an import rule catches the straightforward violation, not a
helper that launders a write through another module — that residue is what
`guren audit`'s existing route-level checks and review culture remain for.
The agent's own DO SQLite (`this.sql`) is its private state and is exempt by
definition.

### 5. Human-in-the-loop through the RFC 0016 approval queue

A durable call to an `approval: 'required'` tool returns a pending result
carrying the queue's `requestId`. The queue stores only redacted input and a
non-reversible fingerprint — by design it can neither return the raw
arguments nor execute anything later. So **the agent side owns the retry
material**: `this.tools` checkpoints `{ requestId, tool, args }` into a
pending-calls table in the agent's DO SQLite before returning. This is a
deliberate, bounded exception to 0016's "no reversible copy of arguments"
rule, and the bounds are the design: the queue avoided raw storage because it
is a *shared, operator-surfaced* store; the ledger is per-instance private
storage no API surfaces, holding exactly the rows whose approvals are alive —
each row is **purged when its approval settles or expires** (the TTL is the
queue's, not the agent's to extend), and rows are encrypted with the app key
at rest so a leaked DO snapshot alone does not disclose arguments. Then:

```ts
const result = await this.tools.call('posts.destroy', { id })
if (result.pending) return   // parked; resumption is scheduled below
```

`GurenAgent` schedules a `checkPendingApprovals` callback (delay-form
schedule, backoff capped at the approval TTL). On wake it asks the queue for
each pending request's status — through the pipeline, so the check is itself
audited — and on `approved` **repeats the original call** with the stored
arguments; the queue's consume-on-use and fingerprint match make the retry
spend exactly the approval that was granted. `rejected` and `expired` rows
are pruned and surfaced to an overridable `onToolApprovalSettled` hook. The
SDK's `waitForApproval` workflow primitive is unrelated machinery (it pauses
an `AgentWorkflow`, not an ordinary method) and remains available for
app-defined approvals; this RFC's mechanism deliberately uses only state +
schedules, per the eviction rule in the Problem statement.

### 6. Build integration (lands in `@guren/plugin-cloudflare`)

- **Boot topology.** Only `createWorkersHandler.fetch` boots the app today;
  an alarm can wake an agent DO before any Worker request has, and a direct
  `app.fetch` would then hit an unbooted app whose env capture throws. The
  handler's capture-and-boot moves into a shared `bootAndFetch(app, request,
  env, ctx)` used by both the worker's `fetch` export and `GurenAgent`
  (whose DO constructor receives the same env). This is **not** trivial code
  motion: the current env-capture holder documents a one-handler-per-module
  invariant precisely because a second entrypoint sharing the module-global
  holder races it. `bootAndFetch` replaces that invariant rather than
  violating it — capture becomes an idempotent, promise-latched boot keyed on
  env identity (first caller wins, everyone awaits the same latch; a
  *different* env object after capture is a hard error, since two envs in one
  isolate means the module graph is being shared in a way the design forbids)
  — and the one-handler comment moves onto the new primitive as its
  specification. Direct in-isolate dispatch is the default topology — lowest
  latency, no network hop — with its costs stated: the agent-hosting isolate loads the app's module graph under the
  shared 128 MB limit, and the Phase 4a bundle probe grows a budget line for
  the agent entry. For apps that want isolation instead, the recorded
  alternative is splitting agents into their own Worker reaching the app over
  a **service binding** (never a public callback URL); that split is an open
  question's worth of scaffolding, not Part 2.
- **Named-export injection.** `buildCloudflareOutput` reads `config/agents.ts`
  (the static grammar from §3) and appends
  `export { Triager } from '<module>'` lines to the generated `worker.js`.
- **Bindings verification.** The wrangler scaffold writes DO configuration
  for registered agents; for existing apps the committed config is verified,
  not rewritten: `cloudflare:build` fails with the exact JSON to add when a
  registered agent has no binding. Cloudflare now prefers declarative class
  `exports` with SQLite storage over the legacy `migrations` list, and the
  two are mutually exclusive — the verifier accepts either mode and the
  scaffold emits the preferred one current wrangler documents. (guren.dev's
  own adoption sits on the legacy list today; its cutover is a dogfooding
  detail, not normative.)
- **Routing, default-deny.** `routeAgentRequest` is a router, not an auth
  layer. The generated worker mounts it under `/agents/*` only when agents
  are registered, and always through the SDK's `onBeforeRequest` /
  `onBeforeConnect` hooks wired to a Guren authorizer: session or token
  authentication, an instance-ownership check (`agents/:name/:instance` —
  who may address this instance is app policy, scaffolded deny-all with a
  documented override), and a creation rate limit. An unauthorized request
  never reaches the DO, so it also never pays a DO cold start.
- **Email** is out of Part 2: `onEmail` requires an `email` worker export,
  `routeAgentEmail`, and account-level routing configuration. Recorded as
  Part 4 scope with the same default-deny stance.

### 7. Local development and testing

The `agents` SDK runs on workerd. Guren's dev server runs on Bun. This RFC
does **not** propose a Bun emulation of Durable Objects — a fake DO runtime
would be the mocked-driver trap. Instead:

- **Per-PR tests, not nightly-only**: the runtime pieces under design here —
  boot-from-alarm, named exports, auth hooks, approval retry after eviction —
  are exactly the pieces a mock cannot exercise, so they are tested with the
  Workers Vitest integration (`@cloudflare/vitest-plugin`) against the
  **generated worker entry** (the build wiring under review, not a bypass),
  in `packages/plugin-agents`' own suite. Wrangler-download-dependent probes
  stay nightly like the Phase 4a bundle probe; the Vitest integration itself
  runs per PR.
- **Agent logic on Bun**: everything an agent does through `this.tools` is
  the RFC 0016 dispatch contract, driveable against a `TestApp` with an
  injected pipeline — no workerd required. Only DO-specific behavior needs
  workerd.
- **Dev**: `guren dev` is unchanged; agent development runs `wrangler dev`
  against built output. A `cloudflare:build --watch` loop is an open
  question, not a promise.

### 8. What this RFC does not do

- **`McpAgent` is not used** (deprecated, feature-frozen upstream). MCP
  serving remains `@guren/plugin-mcp` — stateless, no Durable Objects. An
  agent is not an MCP server; it is a consumer of its own application.
- **No MCP SDK v2 migration, stated precisely**: `plugin-mcp` today speaks
  the 2025 Streamable HTTP protocol through `@modelcontextprotocol/sdk` 1.x —
  operationally sessionless, but *not* an implementation of the 2026-07-28
  wire protocol, which lives in the replatformed
  `@modelcontextprotocol/server` 2.x line. That migration is real future work
  for `plugin-mcp`, out of scope here, and nothing in this RFC may depend on
  either side of it.
- **No Queues driver, no `scheduled` export.** Both were recorded as
  prerequisites in 0016's Phase 4b note, and both turn out to be independent
  platform-parity work that nothing in Parts 1–2 consumes. They move to their
  own release train (tracked, not designed, here).
- **No model/inference opinions.** Which LLM an agent calls, through AI
  Gateway or directly, is app code. The runtime moves state and time, not
  tokens.
- **SDK version policy**: `@guren/plugin-agents` pins a tested `agents` range
  (0.20.x at time of writing) and its CI exercises the real package; the SDK
  is pre-1.0 and its compatibility story is the plugin's to absorb, never the
  app's.

## Package Boundaries

| Layer | Package |
|---|---|
| Invocation pipeline (scope gate, approval gate, redaction, audit), principal seam, `'durable'` surface | `@guren/server` (+ core minor) |
| `GurenAgent`, `defineAgentsConfig`, `this.tools`, pending-approval ledger, rate budget | `@guren/plugin-agents` |
| Named-export injection, `bootAndFetch`, bindings verification, `/agents/*` default-deny mount | `@guren/plugin-cloudflare` |
| `make:agent`, config grammar validation, arch-rule scaffolding, registration checks | `@guren/cli` |
| Transport, bearer verification, rate limiting (unchanged); refactor onto the pipeline | `@guren/plugin-mcp` |

## Phasing

- **Part 1** (no Cloudflare dependency): pipeline extraction into
  `@guren/server` + `plugin-mcp` refactor onto it, behavior-preserving;
  principal seam; `'durable'` surface; fail-closed approval gate.
- **Part 2**: `@guren/plugin-agents` (`GurenAgent`, config grammar,
  `this.tools` with scopes/budget), `make:agent` + arch rule, build
  integration (named exports, `bootAndFetch`, bindings verification,
  default-deny routing). First end-to-end agent on Workers, tested per PR via
  the Workers Vitest integration.
- **Part 3**: pending-approval ledger + retry + `onToolApprovalSettled`.
- **Part 4**: email entry points, docs, guren.dev dogfooding, and the
  service-binding split topology if demand materializes.

## Implementation notes

**Part 1 shipped.** The pipeline lives in `@guren/server` (re-exported from
`@guren/core`) as `createAgentInvocationPipeline`, `@guren/plugin-mcp` runs on
it, the principal seam is in place, and `AgentSurface` carries `'durable'`.
Three things worth recording, because each was a decision rather than a
transcription:

- **Open Question 1 is settled as one function with option hooks**, not a
  middleware chain. A chain would have to publish an ordering vocabulary, and
  the ordering is exactly the part that must not be negotiable: metering has to
  happen before the approval gate, because that gate writes a record and pages a
  human and deduplicates only on identical arguments, so a surface that
  reordered them would amplify notifications with nothing failing. There is one
  seam — an **interposition hook** between the scope gate and the approval gate
  — and everything else is fixed. `@guren/plugin-mcp` puts its per-token rate
  limit there; the durable client's budget goes in the same place.
- **The fail-closed refusal takes its configuration line from the surface.** The
  pipeline is protocol-neutral and cannot name `mcpPlugin({ approvals: … })` in
  every refusal, so the surface passes a hint and the default is phrased in the
  pipeline's own vocabulary. The MCP text is byte-identical to what it was.
- **The seam's scope is narrower than "authenticated", and stated as such.** It
  satisfies `requireAuthenticated()`, `Controller.auth` and `Gate`/policies. It
  does **not** satisfy `createBearerTokenMiddleware` / `tokenCan*`, which judge
  an issued `ApiToken`; synthesizing one would mint a credential the application
  never granted. The same limit applies to the OAuth-fronted MCP surface, which
  adopted the seam in this part — a route behind `requireAuthenticated()` now
  executes as the OAuth caller, where it previously answered 401.

**Part 2a shipped.** `@guren/plugin-agents` exists: `defineAgentsConfig`, the
`agentsPlugin` provider, the `configureAgentRuntime` latch, `createAgentToolClient`,
and `GurenAgent`; plus `make:agent` and the agent-registry check in
`@guren/cli`, and `classifyRegistrationScope` in `@guren/server`. What is
*not* here is §6 — named-export injection, `bootAndFetch`, bindings
verification, and the `/agents/*` mount — which is Part 2b. Nine things worth
recording, each a decision rather than a transcription:

- **The package has two entries, and §3's snippet changed to say so.** `agents`
  statically imports `cloudflare:workers` and `cloudflare:email` from a module
  its root re-exports, with no lazy path and no alternative export condition —
  so `import { Agent } from 'agents'` throws at module evaluation on Bun, for a
  subclass that touches no Durable Object API. The package root is imported by
  an app's `src/app.ts`, which `guren dev` evaluates on Bun. So `GurenAgent`
  lives at `@guren/plugin-agents/agent` and nothing reachable from the root
  imports `agents` at runtime. The practical consequence is the split this part
  is built around: the tool client is a plain module with a `TestApp`-shaped
  application behind it, covered on Bun, and the Durable Object shell is a thin
  file covered by the workerd lane.
- **`configureAgentRuntime` is the 2b seam, and it has two slots rather than
  one.** An agent is woken by an alarm with a Worker `env`, not with an
  `Application`, so it has to *find* the app booted in its isolate: the plugin's
  `boot` publishes an `AgentRuntime` on a module-level latch and `GurenAgent`
  reads it. 2b's generated worker registers the other slot — a *resolver*, "boot
  the app on this env" — because an alarm can arrive before any Worker request
  has booted anything. Two slots because one would make the plugin's publish
  look like a replacement of the resolver that caused it, and a check that fires
  on the successful path is a check nobody keeps. Each slot still refuses a
  different value of its own kind, which is the rule that matters: two apps, or
  two envs, in one isolate (§6). The resolver may return nothing, since the
  ordinary way a runtime appears is the plugin publishing it — requiring a
  return value would make 2b write a circular `return resolveAgentRuntime()`.
- **The budget is `callsPerMinute` only; the pending-approvals cap moves to
  Part 3.** §4 promises both meters in the same part as the client. Half of that
  promise is kept literally: a sliding-window rate budget (60/minute by default)
  sits at the pipeline's interposition seam, between the scope gate and the
  approval gate, so an unattended loop cannot amplify approval notifications.
  The other half cannot be kept honestly here — a cap on *outstanding* approvals
  needs to know which of this instance's approvals are still alive, and that is
  the ledger, which is Part 3 by the phasing. The rate budget alone already
  bounds the amplification the cap was for; what it does not bound is the number
  of distinct requests a slow, patient loop accumulates, and that gap closes
  with the ledger. Two limits are stated rather than papered over: the budget
  lives in the client instance, so an eviction resets it, and it is per instance,
  not global — the floor an app's own rate-limit middleware over a shared store
  cannot be on this surface.
- **`env` and `executionCtx` are not forwarded into the pipeline yet.** The
  pipeline takes both and `@guren/plugin-mcp` passes them, because omitting them
  silently loses D1/R2 bindings and `waitUntil` on Workers (RFC 0016 §3.1). A
  `GurenAgent` holds `this.env`, but the runtime it dispatches through is the
  one the *application's* boot published, and settling which `env` a re-entrant
  request carries is precisely `bootAndFetch`'s job — so the forwarding lands
  with §6 in Part 2b, not before it.
- **The runtime latch is last-publish-wins, and only the resolver refuses a
  replacement.** The runtime slot first refused a second, different runtime, on
  the §6 theory that two runtimes mean two applications in one isolate. That
  check could not hold: `agentsPlugin`'s `boot` mints a fresh object every time,
  so "the same object is a no-op" never applied to the one caller that matters,
  and any process booting two apps — an application's own Bun suite standing up
  a `TestApp` per file, the ordinary case — threw on the second boot. The
  guarantee belongs to the boot wiring (the promise-latched resolver, which
  boots once per `env`), not to a setter that cannot tell a second application
  from the same one booting again. The resolver slot does still refuse a
  different resolver: generated code registers it once at module scope, so a
  second one is a build that wired the isolate twice. `resolveAgentRuntime` also
  latches the resolution *in flight*, so an alarm and a request arriving
  together share one boot; the latch is cleared on rejection, because a
  transient failure must not become permanent for the life of the isolate.
- **The audit emitter is resolved at first use, not at boot.**
  `AGENT_AUDIT_BINDING` is published by another plugin's `boot` —
  `mcpPlugin({ audit })` binds it from its own — so which plugin sees it is
  decided by the order two lines appear in a `providers` array. Reading the
  container in `agentsPlugin`'s `boot` made
  `providers: [agentsPlugin(…), mcpPlugin({ audit })]` record nothing at all for
  the durable surface, for the life of the process, with no error anywhere.
  `AgentRuntime.audit` is therefore a resolver: every provider's `boot` has
  completed before an agent makes its first tool call, so first use is the first
  moment the answer is stable.
- **The seam is a separate entry point, and the boundary is a discipline.**
  `configureAgentRuntime` / `resolveAgentRuntime` / `createAgentToolClient` live
  at `@guren/plugin-agents/runtime`, not on the package root, because each of
  them either hands out an application to dispatch into or mints a principal to
  dispatch as — an agent class that imported them could build itself a client
  with scopes its registration never granted. `make:agent` names the subpath in
  the arch rule's `disallowPackages`, so reaching for it fails
  `guren check --arch`. Stated plainly: **this is not isolation.** In-process
  application code shares the isolate and can import any module it likes; the
  boundary is the arch rule plus the audit trail, and the arch checker sees only
  *static* imports — a dynamic `import()` escapes it. What the split buys is
  that crossing the boundary is visible in review rather than incidental. The
  registry the runtime hands out is frozen (each registration, its `abilities`,
  and a `ReadonlyMap`), and the gate and the audit principal share the *same*
  array, so a widened scope cannot be authorized under a record that does not
  show it.
- **Principal ids are unambiguous by construction, and facets are refused.**
  `agent:<name>:<instance>` is ambiguous if either half may contain a colon, so
  the name half is constrained (`[A-Za-z0-9_-]+`, enforced by
  `validateAgentsConfig` and `guren check`) and the instance half — which comes
  from the Durable Object, not from a config this package validates — is
  percent-encoded. The SDK's facets (sub-agents) reuse an instance name under a
  different parent, so a facet's id would not be unique; `GurenAgent` refuses to
  build a tool client inside one. `selfPath` / `parentPath` would disambiguate
  them, but both are `@experimental` and what a facet's scopes and approvals
  *should* be is undesigned — that is Part 3's question, not something to settle
  by minting an id whose uniqueness this part cannot promise.
- **Publication waits for boot, and the isolate is pinned to one `env`.**
  `agentsPlugin`'s `boot` runs inside `bootAll()`, the application's last boot
  step, so everything it publishes is published while later providers are still
  unbooted. The runtime therefore dispatches through a wrapper that awaits
  `Application.booted()` (added to `@guren/server` for this — the class already
  tracked the promise), and `resolveAgentRuntime` joins an in-flight resolution
  rather than returning the slot the instant it appears. A second, *different*
  `env` object is the hard error §6 asks for, checked on identity.
- **Open Question 2 is answered as a check-time computation.** `guren check`
  expands each registration's `tools:read` against the loaded route graph and
  reports it under `--json` (`agentScopes`); the runtime re-expands at boot.
  Nothing is generated. Pinning the expansion into a committed artifact would
  make an agent's authority a file that can be stale, and the value of the
  expansion is precisely that it is recomputed — a route that stops being
  read-only has to change what the agent may call on the next run, not on the
  next regeneration.
- **The registration grammar is one exported predicate.**
  `classifyRegistrationScope` in `@guren/server` decides which scope forms a
  registration may hold; `validateAgentsConfig` and `guren check` both call it,
  and its refusal message is what both surfaces print. A check with its own copy
  is how a build that passes comes to describe a runtime that refuses.
- **The SDK is pinned at `agents` ^0.22.0, and several names in §3/§5 moved.**
  Verified against the shipped `.d.ts` rather than release notes: `partyserver`
  is gone from the server path, `Agent` gained a third generic (`Props`),
  `setState` is synchronous, `onStateUpdate` is now `onStateChanged`,
  `getSchedules`/`getSchedule` are deprecated in favour of
  `listSchedules`/`getScheduleById`, and `alarm()` is framework-owned — a
  subclass overrides `onAlarm()`. `schedule()` returns a `Schedule`, not an id.
  Long-running work uses `keepAliveWhile`/`runFiber`, never `ctx.waitUntil`,
  which the SDK's own docs list under "does not survive". On the test side the
  Workers Vitest package was **renamed**: `@cloudflare/vitest-plugin` (1.x, a
  Vite plugin named `cloudflareTest`) replaces
  `@cloudflare/vitest-pool-workers`' `defineWorkersConfig`, and it peer-requires
  vitest 4 — which resolves nested under this package while the rest of the
  workspace stays on vitest 3.

**Part 2b shipped.** `guren cloudflare:build` generates the Durable Object half
of the worker for an app whose `config/agents.ts` registers agents, and the
workerd suite in `@guren/plugin-agents` runs that generated worker rather than a
stand-in (§7). Decisions, in the order §6 lists them:

- **The registry is read by evaluating `config/agents.ts` on Bun**, the runtime
  `guren dev` already evaluates it on, through the same dynamic import the SSR
  entry uses. The static grammar of §3 is what makes this safe: literal strings,
  and nothing imported from `agents` or `cloudflare:workers`. `guren check`
  still reads the file as source and reports an entry it cannot read
  statically; the build duck-types the evaluated default export and does not
  depend on `@guren/plugin-agents` (the app must, under `dependencies`).
- **The boot slot is per application, not per handler**, a `WeakMap` latch in
  `@guren/plugin-cloudflare`: `bootWorkersApp(app, env)` and
  `bootAndFetch(app, request, env, ctx)`, with `createWorkersHandler(app)` built
  on them and exposing `boot(env)`. The generated worker registers
  `configureAgentRuntime((env) => handler.boot(env))` at module scope, so an
  alarm boots the app and a later request joins that boot.
- **The env-identity hard error §6 asked for is not enforced.** Under the
  Workers Vitest integration a Worker entrypoint and a Durable Object of the
  same deployment are handed *different* `env` objects (two Durable Objects
  share one), so identity is not a test for "another environment" and refusing
  on it would break the very two-entrypoint topology §6 exists to support.
  `captureWorkersEnv` stays first-capture-wins; the per-app latch is what keeps
  one isolate on one application. The plugin-agents latch still pins the env it
  resolved *for*, which only Durable Objects reach.
- **Bindings verification accepts both wrangler forms** — the legacy
  `migrations[].new_sqlite_classes` list and the declarative `exports` map
  (`{ type: 'durable-object', storage: 'sqlite' }`, live state only), which
  wrangler 4.129 declares mutually exclusive. The scaffold emits the legacy
  form: it is what the agents SDK documents and what the workerd lane runs.
- **`/agents/*` is deny-all** through `routeGuardedAgentRequest` in
  `@guren/plugin-agents/agent`, which wires the app's authorizer into both
  `onBeforeRequest` and `onBeforeConnect`. The override is
  `routing.authorize(request, { agent, instance })` in `config/agents.ts`,
  where `agent` is the Durable Object **binding** name the SDK resolved the URL
  segment to (`AgentRouteMatch.className`), not the config key. A predicate
  rather than a policy vocabulary: Open Question 3 stays open. The SDK's router
  reaches every binding in `env` with an `idFromName`, so the generated worker
  carries the bindings `wrangler.jsonc` gives the *registered* classes and the
  guard refuses the rest before the authorizer is asked.
- **The published runtime dispatches through `app.boot()`, not `booted()`.**
  After a boot that failed in a provider booting after `agentsPlugin`, the
  published runtime outlives the failure; `booted()` would resolve at once into
  the half-assembled app, where `boot()` retries it the way the next request
  does. `Application.booted()` stays for surfaces that hold the app from inside
  `boot`.
- **Deferred**: the service-binding split, `cloudflare:build --watch`, email
  entry points, and the bundle-probe budget line for the agent entry.

## Alternatives Considered

- **A hand-rolled Durable Object base class, no Agents SDK.** Fewer
  dependencies, but re-implements schedules, state sync, hibernation-safe
  WebSockets — the SDK's actual value — and tracks none of the platform's
  improvements.
- **Workflows-only (no resident agents).** Workflows cover suspend/resume but
  have no addressable per-instance state or inbound entry points; "an agent
  you can talk to" degenerates into a workflow per message with external
  state. The SDK composes Workflows where they fit.
- **A vendor-neutral agent abstraction with per-platform drivers.** Exactly
  one substrate today provides durable identity + alarms + embedded state at
  the edge. An abstraction over one implementation is speculation; the
  portable part — the tool client — is already portable because it is the
  RFC 0016 dispatch contract.
- **Agents as privileged internals (direct ORM access, blessed).** Rejected
  as constraint 1. An in-house agent deserves less trust than an external
  one, not more, because it runs unattended.
- **Principal via signed internal token or header.** Anything spelled as a
  header is reachable from the network and becomes a forgery surface to
  misconfigure; an HMAC token adds key management for a hop that never
  leaves the isolate. The in-process seam has no wire representation at all.

## Migration Path

Additive for applications. Internally, the Part 1 pipeline extraction moves
code out of `@guren/plugin-mcp` into `@guren/server`; the plugin's public
surface and behavior are unchanged (its tests run unchanged on the refactor),
and the plugin gains a floor on the server version that ships the pipeline —
the Phase 4a release-engineering lesson (ranges must admit the workspace
version; `changeset version` writes the published floor) applies verbatim.
`AgentSurface` gains a value (compile-caught). New packages declare
`gurenPlugin.compatibility`. Server/core ship minors.

## Open Questions

1. Pipeline shape: one exported function with option hooks, or a small
   middleware chain? The MCP plugin needs to interpose bearer verification
   and rate limiting between principal resolution and the scope gate; the
   durable client needs the budget check there instead. Settled in Part 1's
   PR, recorded here as the one deliberate seam.
2. Whether `tools:read` registration expansion should pin the expanded list
   into a generated artifact (visible in review, like the manifest) or stay a
   check-time computation.
3. The instance-ownership policy vocabulary for `/agents/*` (per-agent
   policy class? reuse Gate abilities?) — scaffolded deny-all until settled.
4. `cloudflare:build --watch` for the agent dev loop.
5. How agent DO SQLite schemas migrate across deploys (the SDK gives raw
   `this.sql`; "CREATE TABLE IF NOT EXISTS in onStart" will not satisfy
   Guren's migration culture; per-agent versioned migrations in the config
   grammar are the likely shape).
6. Whether the service-binding split (agents in their own Worker) deserves
   first-class scaffolding in Part 4 or stays documented-manual.
