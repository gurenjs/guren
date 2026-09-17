# AI Agents

An AI agent is a class in your application that calls a language model and reaches the application only through the agent tools its routes already declare. `@guren/plugin-ai` builds it on the [Vercel AI SDK](https://ai-sdk.dev): the SDK talks to the provider, and the plugin decides which of your routes the model may call, as whom, and what gets recorded.

Three guides cover the agent story, and each answers one question:

| Guide | Question |
|---|---|
| [Agent Interface](./agent-interface.md) | What can an agent do to this application? (`.agent()` routes, scopes, approvals, audit) |
| AI Agents (this guide) | How does application code ask a model to do something with those tools? |
| [Durable Agents](./durable-agents.md) | Where does a long-lived agent with its own state and schedule run? |

An agent from this guide runs inside the request, job or command that prompts it. It has no identity or state of its own between prompts, apart from the conversation history you ask it to keep. A durable agent can use one to make its model calls.

## Install

```bash
bunx guren add ai
```

The command needs a `config/env.ts` (see [Configuration](./configuration.md)). It writes:

- `config/ai.ts` for one provider: `--provider anthropic` (the default), `openai` or `gateway`.
- The provider's API key in `config/env.ts`, `.env.example` and `.env`, declared optional and secret. The app boots without it, and the first prompt fails naming the key.
- `config/ai.ts` in `createApp({ config })` and `aiPlugin()` in `createApp({ providers })`.
- In an app with a `db/schema.ts`, the `ai_conversations` and `ai_messages` tables, their migration, and a `conversations` entry in `config/ai.ts`. `--no-conversations` skips all three.

It then runs `bun add @guren/plugin-ai ai <provider package>`. `--no-install` prints that command instead. The plugin needs Node 22 or later, or Bun.

The generated config for Anthropic:

```ts
// config/ai.ts
import { createAnthropic } from '@ai-sdk/anthropic'
import { defineAiConfig } from '@guren/plugin-ai'
import { aiConversations, aiMessages } from '../db/schema'

export default defineAiConfig((env) => ({
  default: 'anthropic',
  providers: {
    anthropic: {
      model: () => {
        if (!env.ANTHROPIC_API_KEY) throw new Error('Set ANTHROPIC_API_KEY in .env to call the anthropic provider.')
        return createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5')
      },
    },
  },
  conversations: { driver: 'database', conversations: aiConversations, messages: aiMessages },
}))
```

Keep the guard in `model`. The validated env is not copied into `process.env`, so the key is passed explicitly. Given no key, the provider package reads `process.env` itself, and a blank `ANTHROPIC_API_KEY=` line reaches the API as a real key.

`providers` is a map of names to factories. Each factory runs once, on the first prompt that names it, and the result is memoized. An agent names a provider, never a model instance, which is what lets the test fake replace every model the application can reach. To add a second provider, install its package and add an entry:

```ts
providers: {
  anthropic: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5') },
  fast: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-haiku-4-5') },
},
```

`default` must name one of the entries, and the boot fails when it does not. An entry can also carry `embeddingModel` and `imageModel` factories. Nothing in the plugin calls them yet, apart from `ai.embeddingModel(name)`, which returns the embedding model for code that calls the AI SDK's `embed()` itself.

## Writing an agent

```bash
bunx guren make:ai-agent TicketDigest --tools tickets_index --output --test
```

`--tools` checks each name against the tools your routes derive before writing anything, `--output` adds a structured output schema, and `--test` writes a test that scripts the model. `--module <name>` writes inside a module. The command is not `make:agent`, which scaffolds a [durable agent](./durable-agents.md).

This is the agent in [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents):

```ts
// app/Ai/Agents/TicketDigest.ts
import { Agent, Output } from '@guren/plugin-ai'
import { z } from 'zod'

const Digest = z.object({
  summary: z.string(),
  staleTicketIds: z.array(z.number().int()),
})

export class TicketDigest extends Agent<typeof TicketDigest.scopes> {
  static override agentName = 'ticket-digest'
  static override scopes = ['tool:tickets_index'] as const

  instructions = 'You write a short digest of the open support tickets for an operator.'

  output = Output.object({ schema: Digest })

  override tools() {
    return this.appTools(['tickets_index'])
  }
}
```

| Member | Meaning | Default |
|---|---|---|
| `instructions` | The system prompt. | required |
| `provider` | A provider name from `config/ai.ts`. | `default` in `config/ai.ts` |
| `tools()` | The tools the model may call. A method, because it runs after the principal is known. | `{}` |
| `output` | `Output.object({ schema })` for a parsed, typed result. | text |
| `stopWhen` | When the tool loop stops, e.g. `stepCountIs(5)`. | 20 steps |
| `static agentName` | The name fakes, audit lines and queued runs use. | the class name |
| `static scopes` | Which application tools `appTools()` may hand the model. | `[]` |

Pin `agentName`. It defaults to the class name, which a bundler that mangles identifiers rewrites, and a queued run or a stored conversation written before the rename then stops resolving.

`Agent`, `Output`, `tool` and `stepCountIs` are all exported from `@guren/plugin-ai`, so an agent file imports one package.

### Prompting it

In a controller, job or command, resolve the `ai` manager from the container, bind the agent to a principal, and prompt:

```ts
// app/Http/Controllers/AgentOpsController.ts
import { Controller } from '@guren/core'
import { TicketDigest } from '../../Ai/Agents/TicketDigest'

export default class AgentOpsController extends Controller {
  async digest(): Promise<Response> {
    const operator = await this.auth.userOrFail<{ id: number }>()
    const response = await this.make('ai')
      .agent(TicketDigest)
      .as(operator)
      .prompt(`Today is ${new Date().toISOString().slice(0, 10)}. Write the digest.`)

    return this.json({ digest: response.output })
  }
}
```

`response` carries `text`, `output` (typed from the class's `output` schema, or the text when it declares none), `steps` (the AI SDK's steps, tool calls included), `usage` summed over every step, and `finishReason`. Check `finishReason` when the answer matters: `'length'` means the model ran out of tokens, and the output is incomplete.

Give `userOrFail()` a type argument with an `id`. Without one it returns an `Authenticatable`, which `as()` does not accept.

`TicketDigest.as(user).prompt(...)` does the same through the default application, for code with no container at hand. `TicketDigest.prompt(input)` is `as(null).prompt(input)`. For a one-off call, `agent({ instructions, agentName, scopes, tools })` returns an anonymous agent class.

### The principal

`as(principal)` fixes who the model acts as for every tool call of that bound agent. It accepts a user record, an `AgentPrincipal` (`{ kind: 'user' | 'service', id, abilities? }`) or `null`. Only `kind`, `id` and `abilities` are kept: a tool call reaches the route as a request, and the route rebuilds the user through the configured user provider. A role or tenant field on the object you pass never reaches a policy.

When the principal carries `abilities`, the tools the agent gets are the tools both the class's `scopes` and those abilities grant. A caller's consent can narrow an agent and never widen it.

`as(null)` is an anonymous run, for work nobody started (a scheduled summary, say). Under it, `appTools()` accepts only tools whose route is declared read-only, and names every other one in a construction error. An anonymous request carries no identity for a write to be authorized or approved against, so the refusal happens when the agent is built rather than one tool call at a time.

## The application's tools

`this.appTools(names)` hands the model tools built from your `.agent()` routes. Every call goes through the same invocation pipeline as the MCP endpoint, the `guren tool:call` command and durable agents:

1. The scope gate checks the tool against the agent's `scopes`.
2. The call becomes a request to the route, carrying the principal, so `requireAuthenticated()`, `this.auth` and your policies answer for that user.
3. The approval gate holds a tool declared `approval: 'required'`.
4. The call is recorded in the audit trail with `surface: 'in-process'` and its arguments redacted.

Nothing here writes a second schema or a second authorization rule. The tool's description, input schema and output come from the route, as [Agent Interface](./agent-interface.md#metadata-fields) describes.

### Scopes

`static scopes` uses the same grammar as token scopes:

| Scope | Grants |
|---|---|
| `tool:tickets_index` | that one tool |
| `tools:tickets.*` | every tool whose name starts with `tickets.` |
| `tools:read` | every read-only tool |
| `tools:*` | every tool |

Prefer `tool:` entries. A prefix or `tools:read` grant widens silently every time a matching route gains `.agent()`. A prefix also matches only up to a dot, so `tools:tickets.*` does not reach a tool given the portable name `tickets_index` (see below).

`appTools()` refuses to build, with one error listing every problem, when a name matches no route, when `scopes` does not grant it, when a `scopes` entry is outside the grammar, or when the run is `as(null)` and the tool is not read-only. The error surfaces at `as()`, so a misconfigured agent fails its first test instead of running without a tool the model then cannot find.

### Typed tool names

After `bunx guren codegen`, `.guren/agents.gen.ts` types `appTools()` for an app that depends on the plugin. A name no route derives is a compile error, and each tool's input and result are typed from its route contract. Writing `extends Agent<typeof TicketDigest.scopes>` with `scopes` declared `as const` also makes a name that no `tool:` entry grants a compile error. Without the type parameter, only the names are checked at compile time. A prefix grant is checked when `as()` runs.

### What the model reads back

A tool result is one of three shapes:

- The route's response body, when it succeeded.
- `{ error: true, status, body }`, when the route answered with an error status (a 422 from validation, a 403 from a policy).
- `{ denied, message, approval? }`, when a gate refused and nothing ran. For an approval-gated tool, `approval` carries the pending request (`status`, `requestId`, `expiresAt`), so the model can tell the user it is waiting.

A dispatch that failed outright (the app could not boot) is thrown into the tool, and the AI SDK reports it to the model as a tool error.

### Tool names reach the provider verbatim

Anthropic and OpenAI accept tool names matching `[A-Za-z0-9_-]{1,64}` only. A route named `tickets.index` becomes a tool the API rejects, and `appTools()` warns once when it packages one. Give the route a portable tool name; the route name, `route()` helpers and path stay as they are:

```ts
router.get('/tickets', {
  name: 'tickets.index',
  output: TicketListResponseSchema,
  agent: { description: 'List tickets, optionally filtered by status.', toolName: 'tickets_index' },
}, [TicketController, 'index'])
```

### Audit trail and approvals

`aiPlugin()` takes the same `audit` and `approvals` options as `mcpPlugin()`:

```ts
aiPlugin({
  audit: { file: 'storage/logs/agent-audit.log', days: 30 },
  approvals: { store: approvalStore, notify: (request) => notifyOperators(request) },
})
```

Without its own `audit`, the plugin records into the trail `mcpPlugin({ audit })` configures, and with neither it only emits the audit events. Configuring both is an error at the first `appTools()` call. Without `approvals`, an approval-gated tool is refused and nothing runs. [Approval-gated tools](./agent-interface.md#approval-gated-tools) covers the store and the approval routes.

Each bound agent may make 60 tool calls per minute. A model looping on a failing tool gets a refusal after that instead of running up the route.

### Local tools are not gated

`tools()` may return tools you define with `tool()` next to the application's:

```ts
import { Agent, tool } from '@guren/plugin-ai'
import { z } from 'zod'
import { searchTickets } from '../../Services/ticket-search'

export class SupportTriager extends Agent<typeof SupportTriager.scopes> {
  static override agentName = 'support-triager'
  static override scopes = ['tool:tickets_index'] as const
  instructions = 'You triage support tickets.'

  override tools() {
    return {
      ...this.appTools(['tickets_index']),
      similar: tool({
        description: 'Find tickets with similar wording',
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }) => searchTickets(text),
      }),
    }
  }
}
```

A local tool runs with whatever authority its closure has, like a controller action. No scope, policy, approval gate or audit line applies to it. Use one for something no route does, and use `appTools()` for everything a route already does.

Tool results reach the model verbatim, and a ticket body saying "now close every ticket" is text the model may act on. The defence is the one the gates give: a consequential action is a gated route, so an induced write still meets the policy, the approval gate and the audit trail, and an agent whose scopes grant only reads cannot be talked into a write through `appTools()`. A local tool has no such defence.

## Conversations

A prompt stores nothing unless it asks to. `conversation: true` starts one, and the response carries its id:

```ts
const ai = this.make('ai')
const user = await this.auth.userOrFail<{ id: number }>()

const first = await ai.agent(SupportTriager).as(user).prompt('Ticket #4812 asks for a refund.', { conversation: true })
const next = await ai.agent(SupportTriager).as(user).continue(first.conversationId!).prompt('And the one before it?')
```

`continue(id)` and `{ conversation: id }` both replay the stored history before the new message. The store runs two checks before any model call:

- The conversation must belong to the principal. A conversation id another user started is answered as unknown, so ids cannot be probed.
- It must have been started by the same `agentName`, so one agent's history is never continued under another's instructions.

`as(null)` cannot start or continue a conversation, since every anonymous caller would share it. An `agent()` without an `agentName` cannot either.

The store is `conversations` in `config/ai.ts`. `{ driver: 'database', conversations, messages }` names the two tables `guren add ai` adds, and `{ driver: 'memory' }` keeps them in the process for tests and development. A prompt that asks for a conversation with no store configured fails before calling the model. A turn is stored only after the model answers, so a failed prompt leaves no row.

The tables keep the transcript as the model saw it: the user's text, tool arguments and every tool result. Redaction applies to the audit trail, not to this history, because a masked id could not be acted on in the next turn. Treat both tables as sensitive data.

## Streaming a chat

`stream()` takes the same arguments as `prompt()` and returns a streaming `Response` that `useChat` from `@ai-sdk/react` reads. A controller returns it as is:

```ts
// app/Http/Controllers/SupportChatController.ts
import { Controller } from '@guren/core'
import { ChatTurnSchema } from '@guren/plugin-ai'
import { SupportTriager } from '../../Ai/Agents/SupportTriager'

export default class SupportChatController extends Controller {
  async chat(): Promise<Response> {
    const { conversation, message } = await this.validateBody(ChatTurnSchema)
    const user = await this.auth.userOrFail<{ id: number }>()

    return this.make('ai')
      .agent(SupportTriager)
      .as(user)
      .stream(message, { conversation: conversation ?? true, signal: this.request.raw.signal })
  }
}
```

In the page, `createChatTransport()` from `@guren/plugin-ai/client` posts one turn, `{ conversation, message }`, never the transcript. The history lives on the server, because a transcript sent by the browser would let it invent what the model or a tool "already said". The first turn sends `conversation: null`, the controller starts one, and the response names it in the `X-Guren-Conversation` header, which the transport keeps for later turns. The transport also sends the `XSRF-TOKEN` cookie back as the `X-XSRF-TOKEN` header, so the route stays behind CSRF protection.

```tsx
import { useChat } from '@ai-sdk/react'
import { createChatTransport } from '@guren/plugin-ai/client'
import { useState } from 'react'

export default function SupportChat({ conversationId }: { conversationId: string | null }) {
  const [transport] = useState(() =>
    createChatTransport('/support/chat', {
      conversation: conversationId,
      onConversation: (id) => window.history.replaceState(null, '', `?conversation=${id}`),
    }))
  const { messages, sendMessage } = useChat({ transport })
  const [draft, setDraft] = useState('')

  return (
    <form onSubmit={(event) => { event.preventDefault(); void sendMessage({ text: draft }); setDraft('') }}>
      {messages.map((message) => (
        <p key={message.id}>
          {message.role}: {message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('')}
        </p>
      ))}
      <input value={draft} onChange={(event) => setDraft(event.target.value)} />
    </form>
  )
}
```

Install `@ai-sdk/react` 4.x, the line that pairs with `ai` 7, in the app for `useChat`. Four limits follow from keeping history on the server:

- A chat needs a conversation store. No stateless form exists.
- An agent that declares `output` cannot stream, since its JSON would reach the chat as plain text. Use `prompt()` for it.
- The transport refuses to regenerate a message, and refuses a user message with a file attached.
- The plugin does not convert stored history back into `useChat` messages. A page reloaded mid-conversation starts with an empty message list and continues the same conversation on the server.

A request aborted through `signal` stores nothing. A storage failure after the answer has started streaming is logged, since the status code has already been sent.

## Queueing a prompt

`queue()` runs a prompt on a queue worker and emits `AgentResponded` when the model answers:

```ts
const run = await this.make('ai')
  .agent(SupportTriager)
  .as(user)
  .queue('Triage ticket #4812.', { conversation: true, queue: 'agents' })
// run.jobId, and run.conversationId when the call started or continued one
```

It needs three pieces of wiring:

- The agent registered by name: `aiPlugin({ agents: [SupportTriager] })`. The worker resolves the class from `agentName`, never from the class name. Two classes under one name are refused at boot.
- A `queue` binding (`QueueServiceProvider`) and a worker, `bunx guren queue:work`.
- `EventServiceProvider`, for the event.

```ts
import { AgentResponded } from '@guren/plugin-ai'

events.on(AgentResponded, async (event) => {
  // event.agentName, event.principal, event.conversationId,
  // event.response: { text, output, usage, finishReason }
})
```

`conversation: true` creates the conversation before dispatching, so its id is usable at once, and the worker only ever continues it. The response in the event has no `steps`, since a queued listener serializes the event whole.

A queued run is attempted once. A retry would call the model again and run every tool again. A driver with a visibility timeout (Redis, SQS) still redelivers a run that outlasts it, so keep that timeout and the worker's `--timeout` above your longest run. The principal travels as it was when the run was queued, abilities included.

## Testing

`app.fakeAi()` from `@guren/testing` replaces the `ai` binding of an app booted with `TestApp.fromApp(app)`. It scripts the model and nothing else: tools still dispatch through the pipeline into your routes, so a test sees the scope gate, the policies and the approval gate do their work. This is the test from `examples/agents`:

```ts
import { beforeAll, describe, expect, test } from 'bun:test'
import type { TestApp } from '@guren/testing'
import { TicketDigest } from '../app/Ai/Agents/TicketDigest'
import { operatorToken, testApp } from './support/app'

let http: TestApp
let bearer: string

beforeAll(async () => {
  http = await testApp() // TestApp.fromApp(app) over a migrated test database
  bearer = await operatorToken()
})

describe('TicketDigest', () => {
  test('should read tickets through the real route and answer with the scripted digest', async () => {
    using ai = http.fakeAi()
    ai.respond(TicketDigest, [
      {
        toolCalls: [{ name: 'tickets_index', input: { status: 'open' } }],
        then: { output: { summary: 'One printer fire.', staleTicketIds: [] } },
      },
    ])

    const body = await (
      await http.withHeaders({ Authorization: `Bearer ${bearer}` }).post('/ops/agents/digest', {}).assertOk()
    ).json<{ digest: { summary: string } }>()

    expect(body.digest.summary).toBe('One printer fire.')
    ai.assertPrompted(TicketDigest, (input) => input.startsWith('Today is '))
    expect(ai.calls(TicketDigest)[0]!.toolCalls[0]?.name).toBe('tickets_index')
  })
})
```

Install `ai` next to `@guren/plugin-ai`: the fake is built on the AI SDK's mock model.

`respond(Agent, [...])` queues one scripted response per future prompt of that agent:

| Response | The model |
|---|---|
| `'text'` or `{ text }` | answers with the text |
| `{ output }` | answers with that value as the structured output |
| `{ toolCalls: [{ name, input }], then }` | requests those tool calls, then answers with `then` |

`calls(Agent)` returns each prompt with its `input`, `principal`, `response` and `toolCalls`. Each tool call records what the real tool returned, or the error it threw. For a `stream()` call, `toolCalls` fills in as the test reads the response body.

`assertPrompted(Agent, predicate?)`, `assertNotPrompted(Agent, predicate)` and `assertNeverPrompted(Agent)` check the prompts. A prompt with nothing scripted throws, and disposing the fake at the end of the `using` block throws again naming the agent, because a route usually turns the first error into a 500 whose body says nothing. Disposal also fails when the loop stopped (through `stopWhen`) before reaching the scripted answer.

The fake answers `conversations()` from the real store, so a scripted prompt with `conversation: true` writes the same rows it would in production. It does not script embedding models.

A fake proves the wiring. Whether the instructions and tool descriptions get the right answer out of a real model is a separate measurement, made on purpose and at a cost, and nothing in this plugin runs it yet.

## Not yet available

These parts of the design have not shipped:

- `broadcast()`, which would stream a queued run's answer over [broadcasting](./broadcasting.md).
- `embed()` and `image()` wrappers. Call the AI SDK with `ai.embeddingModel(name)` meanwhile.
- `defineEval()` and `guren ai:eval`, for measuring an agent against a real model.
- `guren check` and `guren audit` rules for agents, including the listing of local tools.
- `make:ai-tool`, and typed provider and agent names.

## Related

- [Agent Interface](./agent-interface.md): `.agent()` routes, tool derivation, scopes, approvals and the audit trail
- [Durable Agents](./durable-agents.md): hosting a long-lived agent on Cloudflare Workers
- [Queue](./queue.md) and [Events](./events.md): the worker and the listener a queued prompt uses
- [CLI](./cli.md): `add ai`, `make:ai-agent`, `codegen`
- [RFC 0029: In-Process AI Agents](https://github.com/gurenjs/guren/blob/main/rfcs/0029-in-process-ai-agents.md): the design, and every place the shipped behaviour deviates from it
- [`examples/agents`](https://github.com/gurenjs/guren/tree/main/examples/agents): `TicketDigest`, its route and its `fakeAi()` test
