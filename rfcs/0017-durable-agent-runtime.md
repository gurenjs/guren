# RFC: Durable Agent Runtime — Stateful Agents as Application Citizens

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-09-02
**Status:** Draft

> Phase 4b of RFC 0016 was deliberately split into this document: the agent
> *interface* (tools derived from route contracts) is settled and shipped, while
> the agent *runtime* — the thing that calls those tools over hours and days —
> depends on a platform substrate that was still moving when 0016 was accepted.
> The substrate has since stabilized enough to design against: the Cloudflare
> Agents SDK's `Agent` class reached a coherent surface (v0.8.x: readable
> state, idempotent schedules, typed clients), `McpAgent` was deprecated and
> feature-frozen in favor of `createMcpHandler`, and MCP itself shipped a
> stateless core (2026-07-28) that RFC 0016's endpoint already anticipates.

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
connection. This is exactly the shape of a Cloudflare Durable Object, and the
Cloudflare Agents SDK (`agents` npm package) packages it as an `Agent` class:
embedded per-instance SQLite (`this.sql`), synced state (`this.state` /
`this.setState`), durable schedules (`this.schedule`, alarm-backed), WebSocket
and email entry points, and workflow suspension (`waitForApproval`). Guren
already deploys to Workers (RFC 0003), and Phase 4a made the App MCP endpoint
survive that build.

Two constraints sharpen the design, both inherited from 0016:

1. **No second privileged path.** The measured failure mode of agent frameworks
   is an agent layer that reaches into application internals directly —
   models, raw SQL — acquiring authority no policy ever granted and leaving no
   trail. An agent that is *part of* the application is the easiest place in
   the world to commit this sin, because the internals are right there in
   scope.
2. **Opt-in attack surface** (RFC 0007 lineage). An agent runtime adds
   externally reachable entry points (agent routes, email handlers) and a new
   class of autonomous principal. Nothing here may mount by default.

## Proposed Solution

### 1. `@guren/plugin-agents`

A new plugin package, installed via `guren plugin @guren/plugin-agents`. It
depends on the `agents` SDK and is therefore Workers-only at runtime; the
package boundary keeps that dependency out of every app that doesn't opt in
(the same bundle discipline that keeps the MCP SDK out of non-MCP apps).

`make:agent Triager` scaffolds `app/Agents/Triager.ts`:

```ts
import { GurenAgent } from '@guren/plugin-agents'

interface TriagerState {
  lastRunAt: string | null
  openFindings: Finding[]
}

export class Triager extends GurenAgent<Env, TriagerState> {
  initialState: TriagerState = { lastRunAt: null, openFindings: [] }

  async onRequest(request: Request): Promise<Response> { /* … */ }

  async onStart() {
    await this.schedule('0 7 * * *', 'sweep')   // durable, alarm-backed
  }

  async sweep() {
    const posts = await this.tools.call('posts.index', { published: false })
    // …
  }
}
```

`GurenAgent` extends the SDK's `Agent` — every SDK capability (state, `sql`,
schedules, WebSockets, `onEmail`) passes through untouched. What Guren adds is
the glue that keeps constraint 1 honest, below.

### 2. Agents act through the tool surface — `this.tools`

`GurenAgent` carries a tool client built on the same dispatch module every
other surface uses (`buildToolRequest` / `mapToolResponse` from
`@guren/core/agent`, shipped for WebMCP in Phase 3). A call re-enters the
application as a real HTTP request via `app.fetch` — same process, no network
hop — so validation, policies, redaction, and the audit trail all run exactly
once, in the app. The agent holds an `AgentPrincipal` of `kind: 'service'`
with explicit scopes declared at registration:

```ts
// config/agents.ts
export default defineAgentsConfig({
  agents: {
    triager: { class: Triager, scopes: ['posts.index', 'tickets.store'] },
  },
})
```

- A tool outside the agent's scopes is refused before dispatch, exactly as the
  App MCP endpoint refuses it — same denial event, same audit record.
- `AgentSurface` gains a `'durable'` value; the exhaustiveness pattern in
  `agent/audit.ts` turns the addition into a compile error at every consumer.
- Prerequisite recorded in 0016 and now in scope: `kind: 'service'` principals
  require `ApiToken.userId` to become optional — the service principal here is
  minted in-process from the registration, not from a stored token, which
  sidesteps the storage question but still needs `Gate` to accept a userless
  principal.

**Direct model/ORM access from an agent is deliberately not wrapped, and the
`guren audit` treatment is extended to notice it**: an `app/Agents/*.ts` file
importing from `@/app/Models` or `@/db` gets the same fail-closed warning an
unvalidated mutating route gets today. Reads through models may be legitimate
(a summarizer over its own DO SQLite is always fine); writes that bypass the
contract layer are the anti-pattern this RFC exists to prevent. The audit
warns rather than fails — the boundary is a default, not a prison — and the
warning names the tool-surface alternative.

### 3. Human-in-the-loop through the RFC 0016 approval queue

This is where the two RFCs meet. A tool with `approval: 'required'` behaves
for a durable agent exactly as it behaves for an App MCP caller: the call
returns a pending-approval result carrying an approval id. The agent then
*parks*:

```ts
const result = await this.tools.call('posts.destroy', { id })
if (result.pending) {
  await this.schedule({ delaySeconds: 3600 }, 'checkApproval', result.approvalId)
  return
}
```

`GurenAgent.waitForToolApproval(approvalId)` packages that pattern (schedule +
`guren.approval_status`-equivalent check + resume/expire). The human approves
through the same queue the App MCP surface uses — one queue, one audit trail,
one place to look. The SDK's own `waitForApproval` workflow primitive remains
available for app-defined approvals that are not tool calls.

### 4. Build integration (lands in `@guren/plugin-cloudflare`)

The prerequisites recorded in 0016 §7, now specified:

- **Named-export injection.** Durable Object classes must be named exports of
  the worker entry. `buildCloudflareOutput` reads the agents config and
  appends `export { Triager } from '<app entry's agent module>'` lines to the
  generated `worker.js`. Discovery is the config file, not a directory scan —
  registration is the opt-in, so an unregistered class in `app/Agents/` is
  scaffolding in progress, not an export.
- **Bindings + migrations.** The wrangler scaffold gains a `durable_objects`
  binding per registered agent and a `migrations` entry with
  `new_sqlite_classes` (the SDK requires SQLite-backed DOs). The scaffold
  writes once and never overwrites (the Phase 4a lesson), so `cloudflare:build`
  *verifies* the committed config covers every registered agent and fails with
  the exact JSON to add when it doesn't — the same shape as 4a's stale-alias
  guard. guren.dev's own adoption will use migration tag `v3`.
- **Routing.** `routeAgentRequest` is mounted under `/agents/*` in the
  generated worker, before `app.fetch`, only when agents are registered.
  Agent HTTP entry points are therefore reachable only on the Workers build —
  which is the truth of the runtime, stated by construction.
- **Queues driver and `scheduled` export.** Platform parity work that agents
  make urgent but that stands alone: a Cloudflare Queues driver for Guren's
  queue subsystem (the `queue` worker export feeding the existing job
  machinery) and a `scheduled` export driving Guren's scheduler from cron
  triggers. Specified here, shippable independently as Part 3.

### 5. Local development and testing

The `agents` SDK runs on workerd. Guren's dev server runs on Bun. This RFC
does **not** propose a Bun emulation of Durable Objects — a fake DO runtime
would be the mocked-driver trap (a driver mock that keeps tests green while
every real query dies is a documented failure in this repo). Instead:

- **Tests**: `@guren/testing` gains a miniflare-backed harness
  (`TestAgent.create(Triager)`) that runs the real SDK against real workerd,
  the way the wrangler bundle probe already runs real wrangler. Gated like
  that probe (network on first run), on by nightly.
- **Dev**: `guren dev` is unchanged. Agent development runs `wrangler dev`
  against the built output (`guren cloudflare:build --watch` is a nice-to-have
  recorded as an open question, not promised).
- The tool client is the escape hatch that keeps most agent *logic* testable
  on Bun: everything an agent does through `this.tools` can be driven against
  a `TestApp` with an injected fetch, no workerd required. Only DO-specific
  behavior (state persistence, alarms, hibernation) needs the harness.

### 6. What this RFC does not do

- **`McpAgent` is not used** (deprecated, feature-frozen upstream). MCP
  serving remains `@guren/plugin-mcp` — stateless by design, no Durable
  Objects, aligned with MCP 2026-07-28. An agent is not an MCP server; it is
  an MCP-shaped *consumer* of its own application.
- **No MCP SDK v2 migration.** The TypeScript SDK's replatform
  (`@modelcontextprotocol/server@2.x`, web-standard, stateless) is real and
  eventually matters to `plugin-mcp`, but it is a transport-layer migration
  with its own compatibility story — separate work, noted here so the two
  don't get entangled.
- **No model/inference opinions.** Which LLM an agent calls, through AI
  Gateway or directly, is app code. The runtime moves state and time, not
  tokens.

## Package Boundaries

| Layer | Package |
|---|---|
| `GurenAgent`, `defineAgentsConfig`, tool client, `waitForToolApproval` | `@guren/plugin-agents` |
| Named-export injection, DO bindings/migrations verification, `routeAgentRequest` mount, Queues driver glue, `scheduled` export | `@guren/plugin-cloudflare` |
| `make:agent`, config discovery for build, audit extension | `@guren/cli` |
| `'durable'` surface value, `Gate` userless-service acceptance | `@guren/server` (+ core minor) |
| `TestAgent` miniflare harness | `@guren/testing` |

## Phasing

- **Part 1**: `@guren/plugin-agents` (`GurenAgent`, config, tool client with
  scopes + audit), `make:agent`, the `'durable'` surface, `Gate` acceptance.
  Testable on Bun via the tool client.
- **Part 2**: build integration — named-export injection, bindings/migrations
  verification, `routeAgentRequest` mount. First end-to-end agent on Workers.
- **Part 3**: Queues driver + `scheduled` export (independent platform parity).
- **Part 4**: `waitForToolApproval` + approval-queue integration, `TestAgent`
  harness, docs, and guren.dev dogfooding (migration tag `v3`).

## Alternatives Considered

- **A hand-rolled Durable Object base class, no Agents SDK.** Fewer
  dependencies, but re-implements schedules, state sync, hibernation-safe
  WebSockets, and email routing — the SDK's actual value — and tracks none of
  the platform's improvements. The SDK is Cloudflare-maintained and the DO
  primitives it wraps are the ones this design needs.
- **Workflows-only (no resident agents).** Cloudflare Workflows covers
  suspend/resume, but has no per-instance addressable state or inbound entry
  points; "an agent you can talk to" degenerates into a workflow per message
  with external state. The SDK composes Workflows where they fit
  (`runWorkflow`) instead.
- **A vendor-neutral agent abstraction with per-platform drivers.** There is
  exactly one substrate today that provides durable identity + alarms +
  embedded state at the edge. An abstraction over one implementation is
  speculation; the honest boundary is a Cloudflare-named plugin, with the tool
  client (the part that touches the application) already portable because it
  is the RFC 0016 dispatch contract.
- **Agents as privileged internals (direct ORM access, blessed).** Rejected as
  constraint 1. The entire value of 0016's surface is that every agent action
  is a contract-validated, policy-checked, audited request; an in-house agent
  deserves less trust than an external one, not more, because it runs
  unattended.

## Migration Path

Purely additive. No existing API changes shape; `AgentSurface` gains a value
(compile-caught at consumers); `ApiToken.userId` optionality is a widening.
New packages declare `gurenPlugin.compatibility`. Server/core ship minors.

## Open Questions

1. Whether `defineAgentsConfig` lives in `config/agents.ts` (a new config
   file, discovered by the build) or inside the plugin's factory options —
   the build generator runs in a separate process and cannot read runtime
   plugin config, which is the same constraint that made `--mcp-oauth` a
   build flag in 0016 §7.
2. Scope grammar for agent registrations: exact tool names only, or the
   `tools:*` / prefix grammar tokens already parse? Prefix grammars for an
   unattended principal have the same future-tool consent problem 0016
   recorded for stored tokens (`--read-only` expansion at issue time); the
   same fail-closed expansion likely applies at *registration* time.
3. Whether reads through models from agent code should be exempted from the
   audit warning structurally (allowlist read methods?) or the warning stays
   uniform and the escape is per-file suppression. The warning's value decays
   fast if half the scaffolded agents ship with suppressions.
4. `guren cloudflare:build --watch` for a tighter agent dev loop, and whether
   `wrangler dev` against built output is tolerable before it exists.
5. How agent DO SQLite schemas migrate across deploys (the SDK gives raw
   `this.sql`; Guren's migration culture will want more than "CREATE TABLE IF
   NOT EXISTS in onStart").
6. Whether the Queues driver belongs to this RFC's release train or ships
   earlier — nothing in Parts 1–2 depends on it.
