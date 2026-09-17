---
name: ai-agent
description: Write, wire and test an in-process AI agent with @guren/plugin-ai (an Agent class that calls a language model and reaches the app through its .agent() routes). Use when the user asks to "add an AI feature", "call Claude/OpenAI from the app", "summarize/classify/triage with an LLM", "make an AI agent", "add a chat", or mentions app/Ai/Agents, config/ai.ts, appTools(), fakeAi() or make:ai-agent. Not for durable Workers agents (make:agent) or for exposing routes to external agents (agent-interface).
---

# AI Agent Skill

An in-process agent is a class under `app/Ai/Agents` that calls a model configured in `config/ai.ts`. It reaches the application **only** through `appTools()`, which turns the app's `.agent()` routes into model tools and runs every call through the same pipeline as the MCP endpoint: scopes, the route's validation and policies, approvals, and the audit trail. Nothing about a route is written twice.

## Setup (once per app)

```bash
bunx guren add ai                       # config/ai.ts, the key in config/env.ts, aiPlugin(), conversation tables
bunx guren add ai --provider openai     # or gateway
```

It needs `config/env.ts`. The key is optional: the app boots without it and the first prompt fails. Do not remove the `if (!env.ANTHROPIC_API_KEY) throw` guard in `config/ai.ts`; without a key the provider SDK reads `process.env` and sends a blank key.

## Writing an agent

```bash
bunx guren make:ai-agent TicketDigest --tools tickets_index --output --test
```

`--tools` fails if no route derives a name, so expose the route first (the `agent-interface` skill). Then check the generated class:

```typescript
import { Agent, Output } from '@guren/plugin-ai'
import { z } from 'zod'

export class TicketDigest extends Agent<typeof TicketDigest.scopes> {
  static override agentName = 'ticket-digest'
  static override scopes = ['tool:tickets_index'] as const

  instructions = 'You write a short digest of the open support tickets for an operator.'
  output = Output.object({ schema: z.object({ summary: z.string() }) })

  override tools() {
    return this.appTools(['tickets_index'])
  }
}
```

Rules:

- **Keep `static agentName` pinned.** Fakes, audit lines, queued runs and stored conversations key on it; the class-name default changes under a minifier.
- **Scopes are `tool:<name>` entries**, one per tool. `tools:read`, `tools:*` and `tools:<prefix>.*` grow silently as routes gain `.agent()`, and a prefix only matches dotted names.
- **Keep `Agent<typeof X.scopes>` with `scopes ... as const`.** That type parameter is what makes an ungranted `appTools()` name a compile error. Run `bunx guren codegen` so `.guren/agents.gen.ts` types the names.
- **Tool names must match `[A-Za-z0-9_-]{1,64}`.** Anthropic and OpenAI reject `tickets.index`; set `agent: { toolName: 'tickets_index' }` on the route.
- **Prefer `appTools()` over a local `tool()`.** A local tool runs with its closure's authority: no scope, policy, approval or audit applies. Use one only for work no route does, and never for a Model write a route already performs.

## Calling it

```typescript
const user = await this.auth.userOrFail<{ id: number }>()   // a type argument with id; the default Authenticatable does not fit as()
const response = await this.make('ai').agent(TicketDigest).as(user).prompt('...')
response.output   // typed from `output`; response.text, steps, usage, finishReason
```

- `as(user)` makes every tool call a request as that user, so the route's policies decide. `as(null)` allows read-only tools only and fails at `as()` otherwise.
- Tool results are untrusted model input (a ticket body can carry instructions). The consequential action must be a gated route, never a local tool.
- Conversations: `prompt(input, { conversation: true })` starts one and returns `conversationId`; `.continue(id)` resumes it. Nothing is stored without asking. The tables hold transcripts as the model saw them: sensitive data.
- Chat: `.stream(message, { conversation: conversation ?? true, signal: this.request.raw.signal })` after `validateBody(ChatTurnSchema)`, with `createChatTransport()` from `@guren/plugin-ai/client` in the page. An agent with `output` cannot stream.
- Background: `.queue(input)` needs `aiPlugin({ agents: [TicketDigest] })`, a queue binding and `bunx guren queue:work`; listen for `AgentResponded`. A run is attempted once.

## Test it with the fake, first

```typescript
using ai = app.fakeAi()   // app = await TestApp.fromApp(realApp)
ai.respond(TicketDigest, [
  { toolCalls: [{ name: 'tickets_index', input: { status: 'open' } }], then: { output: { summary: 'One fire.' } } },
])
// drive the route or call the agent, then:
ai.assertPrompted(TicketDigest, (input) => input.includes('digest'))
expect(ai.calls(TicketDigest)[0]!.toolCalls[0]?.output).toBeDefined()   // the real route's answer
```

- Only the model is scripted. Tool calls hit the real routes, so the test proves scopes, policies and approvals are wired. Never stub the tools.
- An unscripted prompt fails the test when `ai` is disposed, naming the agent, even if the route turned the error into a 500.
- Mutation-check: bind the agent `as(null)` or drop the scope and confirm the test fails.

A passing fake test proves wiring, not answer quality. No eval runner ships yet; do not claim an agent "works well" from fake tests alone, and never call a real provider from `bun test` or CI.

Full guide: `docs/en/guides/ai-agents.md` (or `docs/ja/guides/ai-agents.md`) in the Guren framework repo. Routing reference: `__RULES_DIR__/routes-codegen.md`.
