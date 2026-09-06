# @guren/plugin-agents

Durable agents for Guren applications: long-lived, stateful processes that act
*through* your application's own agent tools, hosted on Cloudflare Durable
Objects via the [Cloudflare Agents SDK](https://www.npmjs.com/package/agents).

> RFC 0017. The pending-approval ledger (a parked call retried once a human
> approves it) is still to come; everything below ships today.

## Install

```bash
bunx guren plugin @guren/plugin-agents
```

## The shape of it

```ts
// config/agents.ts
import { defineAgentsConfig } from '@guren/plugin-agents'

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

```ts
// app/Agents/Triager.ts
import { GurenAgent } from '@guren/plugin-agents/agent'

interface TriagerState {
  lastRunAt: string | null
}

export class Triager extends GurenAgent<Env, TriagerState> {
  initialState: TriagerState = { lastRunAt: null }

  async onStart(): Promise<void> {
    await this.schedule('0 7 * * *', 'sweep')
  }

  async sweep(): Promise<void> {
    const result = await this.tools.call('posts.index', { published: false })
    if (result.pending) return // waiting on a human; nothing ran

    this.setState({ lastRunAt: new Date().toISOString() })
    await this.schedule(3600, 'sweep')
  }
}
```

```ts
// src/app.ts
import agents from '@/config/agents'
import { agentsPlugin } from '@guren/plugin-agents'

createApp({ providers: [agentsPlugin(agents)] })
```

`bunx guren make:agent Triager` writes all three.

## What `guren cloudflare:build` generates

`config/agents.ts` is the file the deploy build reads. For each registration it
appends a named export to the generated worker, so wrangler has a class to point
a Durable Object binding at, and it wires the boot seam an alarm needs:

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

One boot slot serves both entrypoints: an agent woken by an alarm before any
request has arrived boots the application itself, and the request that follows
joins that boot rather than starting a second.

The build also checks the committed `wrangler.jsonc`. A registered class with no
binding, or one that is not SQLite-backed, fails the build with the exact JSON
to add — before the app build runs, not after minutes of Vite output. Both forms
wrangler accepts are recognised (`migrations[].new_sqlite_classes` and the
declarative `exports` map); a fresh scaffold gets the migrations form.

## Who may address an agent instance

Once agents are registered the generated worker reserves the whole `/agents/`
prefix for the SDK's router — your own routes under it are unreachable. It is
**deny-all**: every request beneath the prefix, and every WebSocket upgrade, is
refused with 403 until the registry says otherwise, and the refusal happens
before the Durable Object is constructed, so an unauthorized caller does not
even cost a cold start. (With an authorizer configured, a binding the SDK cannot
find answers its own 400.) Only the bindings `wrangler.jsonc` gives the
*registered* classes are routable: the SDK would otherwise reach every Durable
Object in `env`, so the generated worker carries that list and refuses the rest
before the authorizer is asked.

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

Return `true` to let the request through, `false` for a 403, or a `Response` of
your own to answer it directly. `routeAgentRequest` is a router, not an auth
layer — this is the layer. The shape is deliberately thin while RFC 0017's Open
Question 3 (per-agent policy classes? `Gate` abilities?) is unsettled.

## Human-in-the-loop

A tool declaring `approval: 'required'` refuses the first call and files a
request for a human. The agent gets the id and stops:

```ts
export class Ops extends GurenAgent<Env, OpsState> {
  async retire(id: number) {
    const result = await this.tools.call('posts.destroy', { id })
    if (result.pending) return   // parked; the retry is scheduled for you
  }

  onToolApprovalSettled(event: AgentToolApprovalSettled) {
    if (event.status === 'approved') { /* event.result holds the retry's answer */ }
  }
}
```

Behind `return`, `this.tools` checkpoints `{ requestId, tool, args }` into a
private table in the agent's own Durable Object SQLite and schedules
`checkPendingApprovals` — 30 seconds, doubling per check, capped at the request's
expiry. On each wake it asks the queue about every parked call. `approved`
repeats the original call with the stored arguments (the queue's consume-on-use
and fingerprint match make that spend exactly the approval a human granted);
`rejected` and `expired` rows are pruned. Every outcome reaches
`onToolApprovalSettled`, which is a no-op unless you override it.

The sweep is written not to throw. The SDK retries a failed scheduled callback
three times and then drops the schedule, so one bad row — an approval hook of
yours that throws, a row naming a route a deploy removed, a row no current key
can decrypt — would otherwise replay the whole sweep and then leave every
surviving row with no wake at all. Each row is handled on its own, a throwing
hook is reported and swallowed, and a retry refused for want of budget keeps its
row rather than spending a human's approval on a refusal.

One case is worth knowing about because it is the reason `status` and `result`
are separate. If a sweep is interrupted *after* the retry ran but before the row
was cleared, the next sweep finds the approval already spent — it settles with
`status: 'approved'` and **no `result`**, and calls nothing. Repeating the call
there would find no unconsumed approval, file a fresh request, page a human
again, and perform the action twice.

Nothing is held in memory: an eviction between the request and the approval
loses nothing, because the state and the schedule are both durable.

**No encrypter, no ledger.** The approval queue stores only redacted input and a
non-reversible fingerprint, so the arguments have to live on the agent's side —
and the bound on that is that they are ciphertext at rest, under the app key. An
application without `EncryptionServiceProvider` and `APP_KEY` gets a warning at
boot and no ledger: a parked call is still reported to the agent with its
`requestId`, it is simply never retried for you.

## What an agent cannot do

`this.tools.call(name, args)` is the only way an agent reaches the application,
and every call goes through the same invocation pipeline as every other agent
surface: the scopes its registration declares, the route's own validation and
policies, the approval queue, and a redacted audit record under
`surface: 'durable'`. An agent gets no privileged path to your models — and
`make:agent` writes a `guren.arch.ts` rule saying so, enforced by
`guren check --arch`.

Three properties worth knowing:

- **Registration scopes are narrower than token scopes.** `tool:<name>` and
  `tools:read` are accepted; `tools:*` and prefix grants are refused, because an
  unattended agent must not acquire consent to tools that do not exist yet.
- **Every instance is metered.** 60 calls a minute by default; change it with
  `budget: { callsPerMinute }`. The budget is per in-memory instance, so an
  eviction resets it — it is a burst floor, not a global quota.
- **Every instance is its own principal** (`agent:<name>:<instance>`), so one
  instance cannot spend an approval a human granted to another.

## Three entry points, and why

- **`@guren/plugin-agents`** — `defineAgentsConfig`, `agentsPlugin`, and the
  config types. Safe to import from `src/app.ts`, which `guren dev` runs on Bun.
- **`@guren/plugin-agents/agent`** — `GurenAgent`. Not Bun-safe: `agents`
  statically imports `cloudflare:workers` and `cloudflare:email`, so evaluating
  it anywhere but workerd throws. Agent classes import this; nothing else does.
- **`@guren/plugin-agents/runtime`** — the seam that hands out the application
  to dispatch into and mints the principal to dispatch as. Imported by the
  generated worker and by tests. `make:agent`'s architecture rule forbids
  `app/Agents/**` from importing it, so an agent that reaches for the seam —
  and could there build itself a client with scopes its registration never
  granted — fails `guren check --arch`.

That last boundary is a discipline, not a sandbox: in-process application code
shares the isolate and can import whatever it likes. What the split buys is
that crossing it is visible in review rather than incidental.
