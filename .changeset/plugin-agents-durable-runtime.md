---
'@guren/plugin-agents': minor
---

New package: durable agents that call your application's own tools

`@guren/plugin-agents` lets an application host long-lived, stateful agents —
a triager that watches a queue, a nightly researcher that accumulates findings,
an operations agent that proposes a change and waits for a human — on
Cloudflare Durable Objects, through the Cloudflare Agents SDK.

The point of it is what an agent *cannot* do. `this.tools.call(name, args)` is
the only way an agent reaches the application, and every call goes through the
same invocation pipeline as every other agent surface: the scopes its
registration declares, the policies the route declares, the approval queue, and
a redacted audit record. An agent gets no privileged path to your models.

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

// app/Agents/Triager.ts
import { GurenAgent } from '@guren/plugin-agents/agent'

export class Triager extends GurenAgent<Env, TriagerState> {
  async onStart() {
    await this.schedule('0 7 * * *', 'sweep')
  }

  async sweep() {
    const result = await this.tools.call('posts.index', { published: false })
    if (result.pending) return // waiting on a human; nothing ran
  }
}
```

Notable details:

- **Three entry points.** `@guren/plugin-agents` is safe to import from
  `src/app.ts`, which `guren dev` runs on Bun. The `Agent` base class lives at
  `@guren/plugin-agents/agent`, which only a Workers runtime can load. The
  runtime seam — what hands out the application to dispatch into — lives at
  `@guren/plugin-agents/runtime`, which `make:agent`'s architecture rule
  forbids agent code from importing.
- **Registration scopes are narrower than token scopes.** `tool:<name>` and
  `tools:read` are accepted; `tools:*` and prefix grants are refused, because
  an unattended agent must not acquire consent to tools that do not exist yet.
- **Every agent instance is metered.** A per-instance budget (60 calls a minute
  by default, `budget: { callsPerMinute }` to change it) ships with the client,
  so there is no release in which an unattended caller exists without one.
- **Each instance is its own principal** (`agent:<name>:<instance>`), so one
  instance cannot spend an approval a human granted to another. Agent names are
  restricted to letters, digits, underscores and hyphens, and the instance half
  is percent-encoded, so two different agents cannot produce one id. Sub-agents
  (the SDK's facets) are refused for now: a facet reuses its parent's instance
  name, so its id would not be unique.

Requires `@guren/core` 1.14.0 or newer. Deploy integration —
`guren cloudflare:build` generating the worker's named exports and verifying
the Durable Object bindings — lands next.
