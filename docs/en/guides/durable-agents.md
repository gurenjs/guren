# Durable Agents

A durable agent is a long-lived, stateful process your own application hosts, and it reaches that application only through the agent tools the routes already declare.

[Agent Interface](./agent-interface.md) gave your application a surface agents can call. This guide is about the other side: hosting an agent of your own that calls it — a triager that wakes every hour, a researcher that accumulates findings over a week, an operations agent that proposes a destructive change and then waits, possibly for days, for a human to say yes.

## What a durable agent is

Three properties, none of which a job or a cron entry has:

- **Durable identity.** One addressable instance per conversation, tenant or task, reachable by name.
- **Durable state.** `this.state` and a private SQLite database survive deploys and evictions.
- **Per-instance schedules.** Cron for a recurring sweep, a delay in seconds for "look at this again in an hour" — both backed by Durable Object alarms, so an agent wakes with no request touching your Worker.

What it is **not** is a privileged internal. `this.tools.call(name, args)` is the only way an agent reaches your application, and every call goes through the same invocation pipeline as every other agent surface: the scopes its registration declares, the route's own validation and policies, the approval queue, and a redacted audit record under `surface: 'durable'`. An agent is a consumer of your application, not an MCP server and not a second privileged path into your models. An in-house agent deserves *less* trust than an external one, not more, precisely because it runs unattended.

The substrate is Cloudflare Workers, and only Cloudflare Workers: exactly one platform today gives durable identity, alarms and embedded per-instance state at the edge, and `@guren/plugin-agents` is built on the [Cloudflare Agents SDK](https://www.npmjs.com/package/agents) that packages them. There is no Bun emulation of Durable Objects — a fake one would be worth less than the honest 503 your app answers with locally.

## Install and register

```bash
bun add @guren/plugin-agents @guren/plugin-cloudflare
```

`bunx guren plugin <package>` installs either of them too, and checks the compatibility range the plugin declares. `@guren/plugin-agents` is a `definePlugin()` factory that takes your registry as its argument, so it is registered by hand either way — see [Plugins](./plugins.md#installing-plugins).

It must end up under `dependencies`, not `devDependencies`: the generated worker imports it, and wrangler resolves that import at deploy time from a production install. `guren cloudflare:build` refuses an app that hosts agents and only depends on it for development.

```ts
// src/app.ts
import { createApp, EncryptionServiceProvider, EventServiceProvider } from '@guren/core'
import { agentsPlugin } from '@guren/plugin-agents'
import agents from '@/config/agents'
import { registerWebRoutes } from '@/routes/web'

const app = createApp({
  routes: registerWebRoutes,
  providers: [
    EventServiceProvider,
    EncryptionServiceProvider,
    agentsPlugin(agents),
  ],
})

export default app
```

`EventServiceProvider` is what makes the audit events reachable at all — see [the audit trail](./agent-interface.md#the-audit-trail).

`EncryptionServiceProvider` and an `APP_KEY` are what make the **pending-approval ledger** work. A call parked on a human has to keep its arguments somewhere so it can be retried, the approval queue deliberately keeps no reversible copy of them, and the bound on holding them at all is that they are ciphertext at rest under the app key. With no encrypter bound, the plugin warns at boot and runs without a ledger: a parked call is still reported to the agent with its `requestId`, it is simply never retried for you. The requirement is that the provider is registered and `APP_KEY` is set — not that it appears in any particular position in `providers`.

## Scaffolding one

```bash
bunx guren make:agent Triager
```

It writes the class and everything a fresh app lacks for it — an agent class alone is inert, because nothing loads it, nothing bounds it, the deploy build cannot find it, and it names a type no app defines:

| File | What it gets |
|---|---|
| `app/Agents/Triager.ts` | the class: a state shape, a cron schedule, one tool call |
| `config/agents.ts` | the registration — created if the file does not exist, patched if it does |
| `guren.arch.ts` | a rule forbidding `app/Agents/**` from importing `app/Models/**`, `db/**`, `@guren/orm` and `@guren/plugin-agents/runtime` |
| `config/env.ts` | the `Env` the class imports: the D1 binding and a commented slot for the agent's Durable Object namespace — created if absent, left alone if it already exports `Env` |
| `tsconfig.json` | `@cloudflare/workers-types` appended to `compilerOptions.types`, which is where `Cloudflare.Env` and `DurableObject` come from |

Every existing file is patched in place, and any patch the command cannot make is reported with the text to paste rather than skipped — an app whose agent looks registered and is not would be worse than a message. The tsconfig patch has two such cases: a file with no `types` array (a new one switches off the automatic `@types` walk, so it has to name `bun-types` too, and the command prints the line rather than deciding that for you), and a file with comments, which is not strict JSON.

Two things remain yours, both worth knowing before your first typecheck:

- **It does not touch `src/app.ts`.** Add `agentsPlugin(agents)` to `createApp({ providers })` yourself, as above.
- **The dependency.** Run `bun add -d @cloudflare/workers-types` if the app does not have it; the command says so when that is the case.

`config/env.ts` is hand-written rather than generated by `wrangler types` because `tsc` and your Bun test run both read it, and neither can depend on a wrangler invocation having happened first. `@cloudflare/workers-types` declares `Cloudflare.Env`, never a bare `Env`, which is why the class imports the app's own. Widen it as bindings arrive:

```ts
// config/env.ts
export interface Env {
  /** The D1 binding; `unknown` because only the ORM reads it. */
  DB: unknown
  /** The Durable Object namespace wrangler binds for this class. Absent under Bun. */
  TRIAGER?: {
    idFromName(name: string): unknown
    get(id: unknown): { sweep(): Promise<unknown> }
  }
}
```

## The registry

`config/agents.ts` is the one file that says which classes are agents, where they live, and what they may call:

```ts
// config/agents.ts
import { defineAgentsConfig } from '@guren/plugin-agents'

export default defineAgentsConfig({
  agents: {
    triager: {
      module: 'app/Agents/Triager.ts',
      export: 'Triager',
      scopes: ['tool:tickets.index', 'tool:tickets.close'],
      budget: { callsPerMinute: 30 },
    },
  },
})
```

**The grammar is static, and that is a constraint rather than a style.** `guren cloudflare:build` reads this file as source to append a named export per class to the generated worker, and a runtime class value carries no source path — so `module` and `export` are literal strings. A spread inside `agents`, a computed key, or a re-exported config leaves the build with nothing to export while the file reads as though the agent were registered; `guren check` fails each of those with the reason.

Three more rules the same file carries:

- **The agent name is `^[A-Za-z0-9_-]+$`.** It is one half of the principal id `agent:<name>:<instance>`, so a colon or a space in it would let two different agents produce the same id — and an approval granted to one be spent by the other.
- **One class is one agent.** Both the runtime registry and the generated worker are keyed on the export name, so a second registration claiming it makes one of the two unreachable.
- **`budget.callsPerMinute` is a whole number of calls, at least 1.** There is no unmetered registration: an agent with no `budget` gets 60. `Infinity` and `NaN` are refused, because both defeat the meter without erroring.

### Scopes

Registration scopes are deliberately **narrower** than the token scopes in [Tokens and scopes](./agent-interface.md#tokens-and-scopes). Two forms are accepted:

| Scope | Grants |
|---|---|
| `tool:tickets.close` | exactly that one tool |
| `tools:read` | every tool whose resolved `readOnlyHint` is true |

`tools:*` and prefix grants like `tools:tickets.*` are legal for an issued token and **refused at registration**, for the reason `token:issue` refuses an unmatched scope: an unattended principal must not acquire consent to tools that do not exist yet. `tools:read` is expanded against the loaded route graph — by `guren check` when you run it, and again by the runtime at boot — rather than pinned into a generated file, so a route that stops being read-only narrows what the agent may call on its next wake instead of on its next regeneration. `bunx guren check --json` reports the expansion under `agentScopes`.

A budget refusal comes back as a `denied` result with `reason: 'rate-limit'`. The window lives in the in-memory instance, so an eviction resets it: it is a burst floor, not a global quota, and an app that needs a real one still needs a shared store and its own [rate-limit middleware](./rate-limiting.md).

### Where the approval queue goes

`config/agents.ts` also accepts an `approvals` key, but the queue's store and notifier belong on the `agentsPlugin(...)` call instead. Keep the registry to the static registration: `guren check` reads that file as source and `guren cloudflare:build` evaluates it on Bun, so a Drizzle store or a notification channel imported there becomes a dependency both of them have to survive.

```ts
// src/app.ts
import { AgentApprovalRequested } from '@guren/core'
import { agentsPlugin } from '@guren/plugin-agents'
import agents from '@/config/agents'

agentsPlugin({
  ...agents,
  approvals: {
    store: new DrizzleApprovalStore(db),
    notify: (request) => notifications.sendToMany(admins, new AgentApprovalRequested(request)),
    ttlMs: 60 * 60 * 1000,
  },
})
```

## Writing the agent

`GurenAgent` extends the SDK's `Agent` and adds exactly one thing: `this.tools`. State, `this.sql`, schedules, queues, fibers and WebSockets pass through untouched.

```ts
// app/Agents/Triager.ts
import { GurenAgent } from '@guren/plugin-agents/agent'

import type { Env } from '@/config/env'

interface TriagerState {
  lastRunAt: string | null
  declined: number[]
}

export class Triager extends GurenAgent<Env, TriagerState> {
  initialState: TriagerState = { lastRunAt: null, declined: [] }

  async onStart(): Promise<void> {
    // Recurring schedules are idempotent, so re-registering on every wake
    // leaves one row.
    await this.schedule('0 * * * *', 'sweep')
  }

  async sweep(): Promise<void> {
    const listed = await this.tools.call('tickets.index', { status: 'open' })
    if (listed.pending) return          // waiting on a human; nothing ran
    if (!listed.ok || listed.outcome.isError) return

    this.setState({ ...this.#current(), lastRunAt: new Date().toISOString() })

    // Delay form, in seconds.
    await this.schedule(3600, 'sweep')
  }

  #current(): TriagerState {
    return { ...this.initialState, ...this.state }
  }
}
```

### The four answers, and the one trap

```ts
const result = await this.tools.call('tickets.close', { id })
```

| Variant | Meaning |
|---|---|
| `result.ok` | the call **dispatched** — `result.outcome` carries what the application answered |
| `result.pending` | an `approval: 'required'` tool parked the call; `result.requestId` identifies the request |
| `result.denied` | a gate refused before any HTTP happened; `result.reason` is `'auth'`, `'scope'`, `'approval'` or `'rate-limit'` |
| `result.failed` | the dispatch itself threw |

**`ok` is not success.** It says the request reached your application; the application's own verdict is `result.outcome.isError`, with the HTTP status in `result.outcome.status`. A 403 from a policy and a 422 from a schema both arrive as `ok`. The other three discriminants are declared as absent on each variant, so `if (result.pending) return` narrows without a type guard.

`this.tools.preflight(name, args)` asks the same route for a verdict instead of an execution — the same seam [`--preflight` and `guren.preflight`](./agent-interface.md#rehearsing-a-call-over-mcp) reach. The scope gate runs and the budget is spent; the approval gate is skipped, because rehearsing an approval-gated tool is exactly when the question is worth asking and a rehearsal executes nothing.

### Two rules about state

**An agent is durable identity and durable state, not a durable JavaScript stack.** An instance is evicted after inactivity and an in-flight method does not survive it. Anything that must outlive the wake is checkpointed into `this.setState` or `this.sql` and resumed by a schedule; locals, timers and in-flight fetches are gone. This is why the parked-call ledger below is state plus a schedule rather than an `await` that sleeps for a week.

**State shape evolves; instances do not.** `initialState` seeds a *new* Durable Object only. An instance that ran an earlier deploy keeps the state it was written with, so a field you add later reads `undefined` there — which is a `Cannot convert undefined or null to object` on the first sweep after the deploy, not a type error. Layer the defaults under the stored state on every read, as `#current()` above does.

### The principal

Every instance is its own principal: `agent:<name>:<instance>`, where the instance half is the Durable Object's own name. Your policies see a service principal, so an ability can admit an operator and an agent as two different kinds of caller — and an approval granted to one instance can never be spent by another. The seam that installs it is in-process and has no wire representation, so it satisfies `requireAuthenticated()`, `Controller.auth` and `Gate`; it deliberately does **not** satisfy a bearer-token check, which judges an issued `ApiToken` the application never granted.

## Human in the loop

A route declaring `approval: 'required'` refuses the first call, files a pending request, notifies your approvers, and hands the agent the id — the mechanism [Approval-gated tools](./agent-interface.md#approval-gated-tools) describes in full. What a durable agent adds is that it comes back on its own:

```ts
export class Ops extends GurenAgent<Env, OpsState> {
  async retire(id: number): Promise<void> {
    const result = await this.tools.call('posts.destroy', { id })
    if (result.pending) return   // parked; the retry is scheduled for you
  }

  async onToolApprovalSettled(event: AgentToolApprovalSettled): Promise<void> {
    if (event.status === 'approved') {
      // event.args is the call a human answered; event.result is the retry's answer.
    }
  }
}
```

### The ledger

Behind that `return`, `this.tools` checkpoints `{ requestId, tool, args }` into `guren_pending_tool_calls`, a framework-owned table in the agent's own Durable Object SQLite, and schedules a check. The queue stores only redacted input and a non-reversible fingerprint by design, so the retry material has to live on the agent's side; the bounds are what make that acceptable. The table is per-instance private storage no API surfaces, rows are encrypted with the app key at rest, and each row is purged when its approval settles or expires — the TTL is the queue's, never the agent's to extend.

On each wake the agent asks the queue about every parked row, through the pipeline, so the check is itself audited. `approved` repeats the original call with the stored arguments; the queue's consume-on-use and fingerprint match make that spend exactly the approval a human granted, and nothing else.

The backoff is 30 seconds doubling per check, floored at one second and capped by the earliest row's expiry and by the approval TTL. There is exactly one check schedule at any moment: one wake asks about every row, so the cadence serves the newest parked call rather than inheriting the oldest row's stretched backoff. Nothing is held in memory — an eviction between the request and the approval loses nothing, because the state and the schedule are both durable.

### `onToolApprovalSettled`

Overridable, a no-op unless you override it, and called for every outcome:

| `status` | What happened |
|---|---|
| `approved` | a human approved it. `result` is the retry's own answer, which can itself be a refusal |
| `rejected` | a human refused it. Nothing was called |
| `expired` | the request lapsed unanswered |
| `unknown` | the queue holds no record of this request any more |
| `unreadable` | the ledger row could not be decrypted — a rotated app key — so the arguments are gone and nothing can retry it |

`args` carries the arguments the parked call was made with, absent only for `'unreadable'`. Since the queue keeps no reversible copy, this is the one place an application learns *which* call a human answered.

One case is worth knowing about because it is the reason `status` and `result` are separate: if a sweep is interrupted after the retry ran but before the row was cleared, the next sweep finds the approval already spent and settles with `status: 'approved'` and **no `result`**, calling nothing. Repeating the call there would find no unconsumed approval, file a fresh request, page a human again, and perform the action twice.

The sweep is written not to throw, because the SDK gives a failed scheduled callback three attempts and then drops the schedule — one bad row would otherwise replay the whole sweep and leave every surviving row with no wake at all. Each row is handled on its own, a hook of yours that throws is reported and swallowed, and a retry refused for want of budget keeps its row rather than spending a human's approval on a refusal.

### The store and the operator side are yours

There is no default approval store, for the same reason the audit sink has no default: one degrading to process memory would answer "approved" for a record the next isolate never heard of. Implement `AgentApprovalStore` — the four methods and the two guarantees are in [Configuring the queue](./agent-interface.md#configuring-the-queue) — and resolve requests through your own routes. [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents) carries a Drizzle implementation and a small operator API to copy from.

Three things that operator API taught, worth repeating in yours:

- **Derive the status; never read the column.** A request whose window has closed still reads `pending` in SQL. Drop it from the answerable listing rather than offering it.
- **Answer a re-answer with 409.** A request someone already resolved, and one whose window closed, are both un-answerable now; a `404` should mean only that no request has that id.
- **Retention is a policy question.** A settled request is your record of what an agent was allowed to do. Deleting old ones is worth a route an operator calls, not a schedule that decides on your behalf.

A durable agent's own status check gets exactly the answer `guren.approval_status` gives an MCP client, by the same rule and audited under the same tool name — including the part that is a refusal to distinguish: an unknown id and another principal's id are one message, so neither surface can be used to enumerate what your colleagues are waiting on.

## Deploying to Workers

Agents ride the ordinary Cloudflare build; [Cloudflare Workers Deployment](./cloudflare.md) covers the rest of the path (D1, sessions, static assets, secrets).

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

When the app has a `config/agents.ts`, the build adds the Durable Object half of the worker:

```js
// .cloudflare/worker.js — generated
const handler = createWorkersHandler(app)
configureAgentRuntime((env) => handler.boot(env))

export { Triager } from '../app/Agents/Triager.ts'

const agentBindings = ["TRIAGER"]

const agentEntry = {
  async fetch(request, env, ctx) {
    await handler.boot(env)
    const routed = await routeGuardedAgentRequest(request, env, agentsConfig.routing, agentBindings)
    if (routed) return routed
    return handler.fetch(request, env, ctx)
  },
}
```

A named export per registered class, so wrangler has something to point a Durable Object binding at. One boot slot for both entrypoints, because an alarm can wake an agent before any request has booted the application: the agent boots it, and the request that follows joins that boot rather than starting a second. And an explicit binding list, because the SDK's router would otherwise reach every Durable Object in `env`.

### The bindings verifier

The build reads your committed `wrangler.jsonc` and refuses to continue when a registered class has no SQLite-backed Durable Object binding — before the app build runs, not after minutes of Vite output. Do not hand-write those entries: run the build and paste the JSON it prints.

Three details behind that:

- **Both wrangler forms are accepted.** The legacy `migrations[].new_sqlite_classes` list and the declarative `exports` map (`{ "type": "durable-object", "storage": "sqlite" }`). wrangler treats them as mutually exclusive, so use one or the other; a fresh scaffold gets the migrations form, which is what the Agents SDK documents.
- **Every named environment is verified on its own.** `durable_objects` is not inherited by an `env.<name>` block, so a config that hosts the class at the top level and not in the environment you deploy is caught here.
- **`"minify": true` is refused.** wrangler's minifier renames identifiers, and an agent class is found at runtime by its own name — mangled, every tool call fails with "is not registered" after a deploy that looked fine.

### Who may address an instance

Once agents are registered, the generated worker reserves the whole `/agents/` prefix for the SDK's router, and it is **deny-all**: every request beneath it, and every WebSocket upgrade, is refused with 403 until you say otherwise. The refusal happens before the Durable Object is constructed, so an unauthorized caller does not even cost a cold start.

```ts
// config/agents.ts
export default defineAgentsConfig({
  agents: { /* … */ },
  routing: {
    authorize(request, target) {
      // target.agent is the Durable Object *binding* name the SDK resolved the
      // URL segment to (the path carries it kebab-cased), not the key above.
      return ownsInstance(request, target.instance)
    },
  },
})
```

Return `true` to let the request through, `false` for a 403, or a `Response` of your own to answer it directly. `routeAgentRequest` is a router, not an auth layer — this is the layer, and it is deliberately a predicate rather than a policy vocabulary while the right shape is unsettled.

**Put your own operator routes off the `/agents/` prefix.** A route registered beneath it is unreachable rather than merely refused. `/ops/agents/…` is the spelling `examples/agents` uses.

### Talking to your agent

An application talks to its own agent through the binding, never over HTTP:

```ts
// app/Http/Controllers/AgentOpsController.ts
import { Controller } from '@guren/core'
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

import type { Env } from '@/config/env'

export default class AgentOpsController extends Controller {
  async sweep(): Promise<Response> {
    if (!isWorkersRuntime()) {
      return this.json({ error: 'Agents run on Workers. Start this app with `wrangler dev --local`.' }, { status: 503 })
    }
    const namespace = getWorkersEnv<Env>().TRIAGER
    if (!namespace) return this.json({ error: 'No Triager binding.' }, { status: 503 })

    const stub = namespace.get(namespace.idFromName('main'))
    return this.json({ swept: await stub.sweep() })
  }
}
```

Any public method on the agent class is callable over the stub. Under `bun run dev` there is no Durable Object namespace, and answering 503 is the honest response — the agent half of the app runs under `wrangler dev --local` and in production.

### Secrets and the database

```bash
bunx wrangler secret put APP_KEY
```

The ledger is encrypted with it. Without one, `agentsPlugin` warns at boot and retries nothing. Never commit `.dev.vars`.

The approval store is an ordinary table, so it is D1 like the rest of your schema — created by a migration and applied out of band with `wrangler d1 migrations apply`, since the app never migrates itself on Workers.

### The Free plan

The reference app was deployed to a Workers **Free** plan account and measured with `wrangler tail`; its [README carries the full table](https://github.com/gurenjs/guren/tree/main/examples/agents). The alarm fired 30 s after the calls parked, with no request touching the Worker, and the retry closed the ticket. Three numbers frame what the plan can hold: startup was ~100 ms, the Durable Object's whole sweep (boot plus two tool calls plus two approval records) 47 ms of CPU, and the ledger's alarm 14 ms.

Two limits are worth planning against.

**10 ms of CPU per Worker invocation.** A warm request measured 4 ms; a request that boots the application in a cold isolate measured 20–30 ms and still reported `outcome: ok`, because Cloudflare enforces the limit with tolerance rather than as a hard cut. But a Worker that stays above it can start failing with error 1102. The Durable Object has its own, far larger budget, so the agent's work is not the exposed part — your operator API's cold boots are. Watch `cpuTime` in `bunx wrangler tail`; if 1102s appear, the Paid plan removes the ceiling.

**50 D1 queries per Worker invocation** (1,000 on Paid), and a whole sweep runs inside one Durable Object invocation. So cap the fresh asks a sweep may make and report the rest as deferred for the next one:

```ts
const MAX_ASKS_PER_SWEEP = 10
```

Do the arithmetic against your own tools. In the reference app the index call is one query and each fresh approval costs `findMatch` plus `create`, so a full sweep sits at 1 + 2 × 10 = 21. The same cap serves the per-minute budget: without it a backlog spends the window on its first few items and starves everything behind them. Remember which items are already parked, too, or every sweep re-asks the same question.

The *daily* allowances are a separate ceiling and are not usually the constraint — an hourly sweep with a handful of pending approvals is a few dozen wakes a day.

## Testing

Split the suite the way the runtime splits:

**Agent logic on Bun.** Everything an agent does through `this.tools` is the dispatch contract from [Testing a tool](./agent-interface.md#testing-a-tool), so it is driveable against a `TestApp` with no workerd anywhere. Pull the parts that are pure decisions — which items are stale, which to ask about, what the cap allows — into their own module and test them directly; a Durable Object cannot be exercised on Bun, and that arithmetic should be.

**Durable Object behaviour on workerd.** Boot-from-alarm, the named exports, the routing guard, and approval retry after eviction are exactly the things a mock cannot exercise. Run them under [`@cloudflare/vitest-plugin`](https://www.npmjs.com/package/@cloudflare/vitest-plugin) against the **generated** worker rather than a stand-in, so the build wiring is what is under test. The package ships `evictDurableObject`, which makes "the retry survives eviction" a real assertion instead of a claim.

Two suites in this repository are the two shapes: `packages/plugin-agents/tests/workers` for the workerd lane, and `examples/agents/tests` for an application's own.

## What the checks enforce

`bunx guren check` picks the agent registry up automatically when `config/agents.ts` exists, and contributes nothing when it does not.

`check` **fails** on a registry it or the deploy build could not read — an unparseable file, a config that is not a literal `defineAgentsConfig({ agents: { … } })`, a spread inside `agents`, a non-literal `module` or `export`, a `module` naming a file that does not exist or that does not export that class as a class declaration, a duplicated agent key or export name, a missing or non-literal `scopes` array, and a scope outside the registration grammar. It **warns** on a `tool:` scope naming a tool no route declares: the gate is fail-closed, so that scope grants nothing — it is a typo or a renamed route, not a hole.

Two registry rules are enforced somewhere else, and it is worth knowing where: an agent name outside `^[A-Za-z0-9_-]+$` and a `budget.callsPerMinute` that is not a whole number of at least one are refused by `agentsPlugin` at boot, not by `check`. They fail the app's startup rather than its review.

`bunx guren check --arch` enforces the boundary the scaffold wrote: an `app/Agents/**` file importing `app/Models/**`, `db/**`, `@guren/orm` or `@guren/plugin-agents/runtime` fails. Stated plainly, **this is a discipline, not a sandbox.** In-process application code shares the isolate and can import whatever it likes, and the checker sees static imports only — a dynamic `import()` escapes it. What the boundary buys is that crossing it is visible in review rather than incidental, with the audit trail as the other half.

The routes an agent calls are checked by the ordinary agent-route rules, and the one that matters most here is that a non-read-only tool needs *authorization*, not merely authentication: see [Authentication is not authorization](./agent-interface.md#authentication-is-not-authorization).

## Related

- [Agent Interface](./agent-interface.md) — `.agent()` routes, tool derivation, scopes, approvals, and the audit trail an agent's calls land in
- [Cloudflare Workers Deployment](./cloudflare.md) — the rest of the deploy path: D1, sessions, secrets, static assets
- [Authorization](./authorization.md) — the policies that decide what the `agent:<name>:<instance>` principal may do
- [Encryption](./encryption.md) — `APP_KEY` and the encrypter the ledger needs
- [CLI](./cli.md) — `make:agent`, `check`, `audit`, `tool:list`
- [RFC 0017 — Durable Agent Runtime](https://github.com/gurenjs/guren/blob/main/rfcs/0017-durable-agent-runtime.md) — the design, and every place the shipped behaviour deviates from it
- [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents) — a working triager, its approval store, its operator API, and the Free-plan measurements
