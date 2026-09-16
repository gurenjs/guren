# RFC: In-Process AI Agents (`@guren/plugin-ai`)

**Author:** Urata Daiki (@7nohe)
**Date:** 2026-09-16
**Status:** Accepted (2026-09-16; the standard two-week discussion window
was shortened by the deciding maintainer for this solo-driven change, after
a design review pass recorded in PR #860)

> The model-calling half of Guren's agent story. RFC 0016 made the application
> a *tool provider*: every `.agent()` route is a tool with a validated schema
> behind scopes, policies, approvals and an audit trail. RFC 0017 gave the
> application a place to *host* a long-lived agent on Cloudflare, and said in
> §8, deliberately, that "which LLM an agent calls is app code". This RFC is
> where that app code stops being hand-rolled: a class an application writes
> once, that calls a model, that reaches the application through the tools it
> already declares, and that tests, queues, streams and configures like every
> other Guren service. The hosting substrate is unchanged; a follow-up RFC
> (AWS Bedrock AgentCore) adds a second one on the seams this RFC leaves.

## Problem

Nothing in Guren calls a model. Verified at `909b4b69`: no package under
`packages/` or `examples/` depends on `ai`, `@ai-sdk/*` or `@anthropic-ai/sdk`;
the only occurrences of "anthropic" in `packages/*/src` are the agent-route
check and the MCP meta-tools, both of which are about *being* called.

An application that wants an LLM feature today writes it against a provider
SDK directly, inside a controller or a job. Six things go wrong, each of them
the same kind of wrong: a concern the framework already solved once is solved
again, by hand, in the one place the framework cannot see.

1. **The application's tools get declared twice, and the second copy is a
   privileged path.** A route carrying `.agent()` already has a name, a
   description, a merged input schema, an output schema, a scope, a policy, an
   approval rule and a redaction list (`deriveAgentTools`,
   `packages/server/src/agent/derive.ts`). An app wiring the same capability
   into a model writes a `tool({ execute })` whose body calls
   `Ticket.update()` directly. That closure has whatever authority the process
   has: no scope check, no policy, no approval gate, no audit record. It is
   the exact failure RFC 0016's Problem section and RFC 0017 §4 name as the
   measured one in agent frameworks, and an in-process agent is the easiest
   place to commit it because nothing is even crossing a boundary.
2. **No configuration seam.** The API key is read where the call is made, the
   model id is a string literal, and neither goes through the validated env
   (RFC 0027 §1) or a `config/*.ts` definition (RFC 0027 §2). Switching
   provider is a code change in every call site.
3. **No fake.** `@guren/testing` fakes mail, queue, events and the agent
   *tool* side (`TestAgent`). A test that reaches an agent feature either
   calls the network or is skipped. There is no `assertPrompted`.
4. **Conversation persistence is hand-rolled** per feature: a table, a shape,
   a "last N messages" query, no redaction of the tool arguments it stores.
5. **Streaming has no framework path.** `Controller` has `json()` and
   `inertia()`; a chat endpoint returns a raw `Response` built by the app, and
   the client side has to add the CSRF header by hand because a `fetch`-based
   transport does not go through Inertia's axios.
6. **Queueing is a bespoke `Job`** per agent, with the principal (who the
   agent acts as) serialized however that job's author thought of it.

### Prior art (read 2026-09-15, not from memory)

- **laravel/ai** (0.x): an `Agent` contract plus a `Promptable` trait
  (`prompt()`, `stream()`, `queue()`, `broadcast()`), `HasTools` with a
  `Tool` contract (`description()`, `schema()`, `handle()`),
  `HasStructuredOutput` (`schema()` returning JSON Schema, response
  array-accessible), `Conversational` + `RemembersConversations`
  (`forUser($user)`, `continue($id)`, `response->conversationId`),
  `Agent::fake()` with `assertPrompted` / `assertNotPrompted` /
  `assertNeverPrompted`, `config/ai.php` with per-capability defaults,
  `agent()` for anonymous agents, `make:agent` / `make:tool`. It implements
  its own gateway per provider (OpenAI, Anthropic, Gemini, xAI, …) because
  PHP has no shared provider layer to lean on.
- **Vercel AI SDK** (`ai` 7.0.101 on npm at time of writing; Node ≥ 22,
  ESM-only): `ToolLoopAgent({ model, instructions, tools, output, stopWhen })`
  with `generate()` / `stream()`, `tool({ description, inputSchema, execute })`
  accepting Zod or `jsonSchema()`, `Output.object({ schema })`,
  `createAgentUIStreamResponse({ agent, uiMessages })` returning a streaming
  `Response` that `@ai-sdk/react`'s `useChat` consumes, `embed` / `embedMany`,
  `MockLanguageModelV4` and `MockEmbeddingModelV4` in `ai/test`, and a
  provider interface (`ProviderV4`) every first- and third-party provider
  implements. The TypeScript ecosystem *has* the shared layer laravel/ai
  had to write.

The shape to copy from laravel/ai is the application-facing one: a class
per agent, tools as first-class objects, one config file, one fake. The part
not to copy is the provider layer.

## Proposed Solution

Three layers, two of which exist:

| Layer | What it answers | Where |
|---|---|---|
| Tool surface | What can an agent do to this application? | RFC 0016, shipped (`@guren/server` agent module, `@guren/plugin-mcp`) |
| **Model calls** | How does application code ask a model to do something, with those tools? | **This RFC: `@guren/plugin-ai`** |
| Hosting substrate | Where does a long-lived agent process run? | RFC 0017 (Cloudflare), a later RFC (AgentCore) |

`@guren/plugin-ai` is a `definePlugin()` package on its own 0.x line, like
`@guren/plugin-agents`. It depends on `ai` and on nothing provider-specific;
the application installs the provider package it uses. Nothing here touches
`@guren/server` except one union member (§2.3), and nothing touches
`@guren/core`.

### 1. The `Agent` class

```ts
// app/Ai/Agents/SupportTriager.ts
import { Agent, Output, tool } from '@guren/plugin-ai'
import { z } from 'zod'

const Triage = z.object({
  category: z.enum(['billing', 'bug', 'question']),
  priority: z.number().int().min(1).max(4),
  summary: z.string(),
})

export class SupportTriager extends Agent {
  /** Stable wire name (queued runs, audit, fakes). Defaults to the class name; see Job.jobName. */
  static override agentName = 'support-triager'
  /** Least privilege for the model, in the RFC 0016 scope grammar: every appTools() name must be granted here. */
  static override scopes = ['tool:tickets.index', 'tool:tickets.show', 'tool:tickets.update'] as const

  instructions = 'You triage support tickets. Read before you write.'
  /** A provider name from config/ai.ts; never a model instance (§3, §7). Defaults to the configured default. */
  provider = 'anthropic'

  /** A method, not a field: it runs once per bound instance, after the principal is known (§1, construction). */
  tools() {
    return {
      ...this.appTools(['tickets.index', 'tickets.show', 'tickets.update']),
      similar: tool({
        description: 'Find tickets similar to a text',
        inputSchema: z.object({ text: z.string() }),
        execute: ({ text }) => this.make('search').similar(text),
      }),
    }
  }

  output = Output.object({ schema: Triage })
}
```

```ts
// In a controller, job or command: the container-bound form
const ai = this.make('ai')
const response = await ai.agent(SupportTriager).as(await this.auth.user()).prompt('Ticket #4812: ...')
response.output.priority   // typed from the class's `output` member, no generic to restate (§11)
response.text
response.steps             // AI SDK steps, tool calls included
response.usage

// Anywhere else: the ambient form, resolved from the default application (RFC 0023 §3)
await SupportTriager.as(user).prompt('...')
```

The class wraps `ToolLoopAgent`. Its members and their defaults:

| Member | Type | Default |
|---|---|---|
| `instructions` | `string` | required |
| `provider` | `string` | `AiConfig.default` (§3). A name only: model instances live in `config/ai.ts`, so every model resolution passes the manager and the fake (§7) |
| `tools()` | `() => Record<string, Tool>` | `{}`. A method because `appTools()` needs the principal, which `as()` supplies; a field initializer would run before it exists |
| `output` | `Output` | text |
| `stopWhen` | `StopCondition \| StopCondition[]` | `stepCountIs(20)` (AI SDK default) |
| `static agentName` | `string` | class name |
| `static scopes` | `readonly string[]` | `[]` (so `appTools()` with no scopes is a construction error, §2) |

Calling surface. `AiManager.agent(Class)` is the container-bound entry; it
returns a factory, and **`as(principal)` is what constructs the instance**,
with the manager's container and the principal both set before any member
initializer runs, so `this.make(key)` resolves from the application that
owns the request (as `Worker` calls `setContainer` on a `Job` before
`handle()`) and `tools()` sees the principal. The statics on the class are
sugar over the ambient default application, with the RFC 0023 §3 rule
intact: two live applications make the ambient call warn and name
`useAsDefaultApplication()`. `TestApp.fromApp(app)` keeps the application
it booted, which is how `fakeAi()` reaches the right container (§7).

```ts
interface AiManager {
  agent<A extends typeof Agent>(cls: A): BoundAgentFactory<A>   // .as(principal) → BoundAgent
  model(provider?: string): LanguageModel                        // the one resolution point
  embeddingModel(provider?: string): EmbeddingModel
}
static as(principal: AgentPrincipal | { id: string | number; kind?: 'user' | 'service' } | null): BoundAgent<this>
static prompt(input, options?): Promise<AgentResponse<TOutput>>   // as(null).prompt(...)

interface PromptOptions {
  provider?: string                  // a name from config/ai.ts; the one per-call override, serializable (§6)
  conversation?: string              // §5
  signal?: AbortSignal
}
interface AgentResponse<T> {
  text: string
  output: T
  steps: StepResult[]
  usage: LanguageModelUsage
  conversationId?: string
}
```

An `agent({ instructions, tools })` helper returns an anonymous subclass for
one-off calls, mirroring laravel/ai's `agent()`.

**Principal.** `as(principal)` fixes who the model acts as for the whole
prompt. `as()` normalizes its argument to `AgentPrincipal`
(`{ kind, id, abilities? }`; a user record contributes only its id and
`kind: 'user'`, and an `abilities` list on the argument is kept for §2.2)
because that is all the seam carries: `AgentPrincipalGuard.user()` rebuilds the user through
the configured user provider (RFC 0017 §2), so a policy that reads a role or
a tenant field needs that provider registered, and a field on the object
passed to `as()` never reaches the route. `this.auth.user()` is asynchronous,
hence the `await` above. The principal is what `appTools()` hands to the
invocation pipeline (§2), and it is recorded on every audit line the prompt
produces.

`as(null)` is an anonymous run, the right default for a cron-driven agent
that was never given an identity, and **its `appTools()` are restricted to
tools declared read-only** (a local `tool()` is outside this, §2.4):
the seam installs nothing for a null principal
(`pipeline.ts`, the `options.principal &&` guard), so the synthesized
request carries no cookie, no bearer and no seam mark, CSRF verification
runs on it and refuses a mutation, and the approval gate refuses an
approval-gated tool without recording a request (`gate.ts`,
`context.principal === null`). Rather than let the model discover those
refusals one call at a time, `appTools()` under `as(null)` refuses at
construction any tool whose derived `readOnlyHint` is false, naming it.
`readOnlyHint` is the route's declaration (`agent.readOnlyHint`, else the
method's default), so a route that mislabels a write as read-only is
reachable here exactly as it is over MCP; `guren check`'s annotation
honesty rule is what catches that, not this refusal.

### 2. `appTools()`: the application's tools, through the pipeline

`this.appTools(names)` returns AI SDK tools built from the agent tools the
application already derives. It is the one place this RFC touches
`@guren/server`'s agent module, and it adds nothing to it: every piece
below exists and is called as-is.

```ts
// packages/plugin-ai/src/app-tools.ts (sketch)
import { jsonSchema, tool } from 'ai'
import { createAgentInvocationPipeline, deriveAgentTools } from '@guren/core'

function appTools(agent: Agent, names: readonly string[]): Record<string, Tool> {
  const derived = deriveAgentTools(app.router.definitions())   // the one derivation (RFC 0016 §2)
  const pipeline = createAgentInvocationPipeline({
    app,
    principal: agent.principal,
    abilities: effectiveScopes(agent),   // class scopes ∩ principal.abilities, as granted tools (§2.2)
    surface: 'in-process',
    handoff: 'seam',                                            // RFC 0017 §2
    audit: runtime.audit(),                                     // §2.5: the plugin's own, or the published binding
    approvals: createAgentApprovalContext(config.approvals, agent.principal, defer),  // fail-closed when unconfigured
    approvalConfigureHint: 'aiPlugin({ approvals: { store, notify } })',
    interpose: agent.budget(),                                  // sliding-window rate budget, §2.2
    origin: env.APP_URL,                                        // the validated env, RFC 0027 §1
  })
  return Object.fromEntries(names.map((name) => {
    const t = derived.tools.find((candidate) => candidate.toolName === name)
    return [name, tool({
      description: t.description,
      inputSchema: jsonSchema(t.inputSchema),
      execute: async (args) => toToolResult(await pipeline.invoke({ tool: t, args })),
    })]
  }))
}
```

The sketch packages each derived tool as an AI SDK `tool()`, but the
packaging is the last line, not the substance. The plugin exposes the step
before it, `appToolDefinitions(agent, names)`, returning runtime-neutral
`{ name, description, inputSchema (JSON Schema), execute(args) }` records
whose `execute` is the pipeline call. `appTools()` is that list wrapped in
`tool()` / `jsonSchema()`; an adapter for another agent runtime (Mastra's
`createTool`, an MCP client's tool list, the AgentCore RFC's Runtime entry)
wraps the same records and gets the same gates, so the guarantee of §2.1 is
a property of the definition, not of the AI SDK.

#### 2.1 What the pipeline gives for free

Scope gate, approval gate, redaction, audit emission and duration measurement
run for an in-process call exactly as they do for an MCP, CLI or durable one.
An approval-gated tool returns the pipeline's `denied` result with the
pending-approval id; `toToolResult` hands the model
~~`{ denied: 'approval_pending', message, approvalId }`~~
**Amended in implementation:** `{ denied: reason, message, approval? }`
so it can tell the user, where `reason` is the pipeline's denial reason and
`approval` is the approval gate's body verbatim (`status`, `requestId`,
`expiresAt`, ...), the fields an MCP client parses rather than renamed
copies. A route answering with an error status is not a denial: the model
reads `{ error: true, status, body }`. A `failed` dispatch throws into the
tool, which the AI SDK reports to the model as a tool error. A `preflight`
rehearsal is not exposed: an in-process agent has no reason to rehearse
against itself.

`handoff: 'seam'` installs the principal on the synthesized request, so
`requireAuthenticated()`, `Controller.auth` and `Gate` answer for the user the
agent acts as, and the route's own policies decide the rest.

#### 2.2 Least privilege on the class

`static scopes` is written in the RFC 0016 scope grammar (`scopes.ts`:
`tool:<name>`, `tools:<prefix>.*`, `tools:read`, `tools:*`), because it is
handed to the pipeline as `abilities` and judged by `scopesAllowTool`; an
entry outside the grammar grants nothing, silently, which is why the
scaffold writes `tool:` entries and `guren check` reports any other
spelling. The scopes are *application-granted authority*, the agent's own
declaration of what the model may touch: a token is not involved, and the
seam already makes the route judge the user. If `as()` is given a principal
carrying `abilities`, the effective set is the intersection **of the tools
each grants** (expand both against the derived list, keep the tools in
both, pass them as explicit `tool:` entries), never a string intersection
of two scope lists, since `tools:tickets.*` and `tool:tickets.show` share a
tool and no string. A caller's consent can narrow an agent and never widen
it.

A name passed to `appTools()` that no route derives, or that `static scopes`
does not grant, is a **construction error naming both**, not a runtime
denial: a misconfigured agent should fail its first test, never silently
drop a tool the model then cannot find. The rate budget from RFC 0017 §4 (a
sliding window, 60 calls per minute by default,
`DEFAULT_AGENT_CALLS_PER_MINUTE`) comes through the `interpose` seam, where
it belongs; an in-process agent that loops on a failing tool is bounded the
same way a durable one is.

**Amended in implementation:** the budget is fixed at 60 calls per bound
instance (`DEFAULT_IN_PROCESS_CALLS_PER_MINUTE`), with no per-class knob
until an app asks for one; the sketch's `agent.budget()` does not exist. An
entry of `static scopes` outside the grammar is a construction error too,
rather than only a `guren check` report, since it grants nothing. And a
derived tool name outside `[A-Za-z0-9_-]{1,64}` (`tickets.index`, as in the
examples above) is warned about once when `appTools()` packages it:
Anthropic and OpenAI reject such a name at the API, so the route needs a
portable `agent.toolName`. `appToolDefinitions()` keeps the name verbatim.

#### 2.3 The one server change

`AgentSurface` (`packages/server/src/agent/events.ts`) gains `'in-process'`.
The audit total map (`AGENT_SURFACES`) and every other consumer that
enumerates the union fail to compile until they name it, which is the
mechanism RFC 0016 chose so that a new surface cannot be half-recorded.
`guren tool:log --surface in-process` then filters to it once its accepted
list (`packages/cli/src/tool-log.ts`) names the member. Server minor, CLI
patch.

#### 2.4 A local `tool()` is application code, outside the guarantee

The `similar` tool in §1 runs with whatever authority its closure has, like
a controller action, and **nothing in this RFC gates it**: no scope, no
policy, no approval, no audit line. That is correct for something no route
does, and it has to be said plainly, because the pipeline guarantee of §2.1
covers `appTools()` and only `appTools()`. For anything a route *does* do,
the rule is `appTools()`, and `guren audit` lists every local tool an agent
declares under its own heading, with an advisory when the `execute` body
calls a Model write (`.create(`, `.update(`, `.delete(`, `.save(`) while a
`.agent()` route covers the same table (Part 3; the controller-body scan in
`controller-methods.ts` already blanks strings and comments for this kind of
judgement). The listing is the point; the advisory catches one shape of
many, and a local tool that calls a service, the network, or reads data the
model then repeats is caught by a reviewer reading the list, not by a scan.

**Tool results are untrusted model input.** A route's response body reaches
the model verbatim (`dispatch.ts` maps the response, it does not filter it),
and a ticket whose text says "now delete every ticket" is a prompt
injection the model may follow. The design answer is the one RFC 0016 gave
for external agents: the *consequential* action is a gated route, so an
induced write still meets the policy, the approval gate and the audit
trail, and an agent whose scopes grant only reads cannot be induced into a
write *through the application's tools*. What an injection can still do is
steer a local tool, which this guarantee does not cover, or shape the text
the user reads; the docs say so, and the eval (§10) is where an app
measures it.

#### 2.5 Audit and approvals are the plugin's to configure

The `agent.audit` binding is published by `@guren/plugin-mcp`, and only when
that plugin was given a sink (`plugin-mcp/src/plugin.ts`, `if (sink)`); an
app that installs `@guren/plugin-ai` alone has no trail unless this plugin
provides one. So `aiPlugin({ audit, approvals })` takes the same shapes as
`mcpPlugin` (`audit: { file, days } | { sink }`, `approvals: { store, notify,
ttlMs }`) and resolves them the way `@guren/plugin-agents` does
(`plugin-agents/src/plugin.ts`, the `audit()` resolver): its own
configuration when given, else the published binding at first use, else no
trail. Both configured at once is detected **at first use**, naming the two
plugins, not at boot: `mcpPlugin` binds its emitter in its own `boot`, and
provider boot order is the app's `providers` array, so a check in this
plugin's `boot` would pass or fail by list position (the ordering hazard
RFC 0017's implementation notes record). `guren check` reports the same
double configuration statically, which is the earlier signal.
An unconfigured approval queue stays fail-closed, as the pipeline already
makes it: an approval-gated tool is refused with the `aiPlugin({ approvals })`
hint, and nothing is dispatched.

### 3. Configuration: `config/ai.ts` (RFC 0027 §2)

```ts
// config/ai.ts
import { defineAiConfig } from '@guren/plugin-ai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { aiConversations, aiMessages } from '@/db/schema'

export default defineAiConfig((env) => ({
  default: env.AI_PROVIDER,
  providers: {
    anthropic: {
      // The validated env is container data (ConfigServiceProvider binds it as `env`); it is not
      // copied into process.env, so the key is passed explicitly rather than read by the SDK.
      model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5'),
      // Anthropic ships no embedding model; an app that needs embeddings names another provider.
    },
  },
  conversations: { driver: 'database', conversations: aiConversations, messages: aiMessages },   // §5
}))
```

```ts
export interface AiConfig {
  default: string
  providers: Record<string, AiProviderConfig>
  conversations?: ConversationStoreConfig
}
export interface AiProviderConfig {
  model: () => LanguageModel
  embeddingModel?: () => EmbeddingModel
  imageModel?: () => ImageModel
  /** USD per million tokens; read by the eval runner (§10) only. */
  pricing?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
}

declare module '@guren/server' {
  interface ConfigDefinitions { ai: AiConfig }
  interface ServiceBindings { ai: AiManager }
}
```

`AiManager` is bound under `ai` in `bind()`; `model(name)` calls the factory
once, on first use, and memoizes. The env side is validated at boot, as RFC
0027 §1 intends: `guren add ai` adds `AI_PROVIDER` (defaulting to the
scaffolded provider) and that provider's key to `config/env.ts` as
`z.string().min(1)`, so a deployment missing the key fails env validation
rather than the first request, and `.env.test` carries a placeholder
because tests run against the fake (§7) and never build the client. What is
lazy is the provider *client*, not the key.

**Why factories in the config, not a driver registry.** RFC 0020 built
`SessionDrivers` as an augmentable registry because the framework itself
ships drivers a plugin extends by name. Here the framework ships no
provider: every model comes from a package the app installs, and a registry
would only relabel the factory the app already wrote. The named `providers`
map *is* the registry. The bundling lesson of RFC 0022 is the narrower
constraint this shape also satisfies: nothing in `@guren/plugin-ai` imports
a provider package, so a Worker carries exactly the providers `config/ai.ts`
imports. The config stays data in RFC 0027's sense (importing a provider
factory has no side effect), and a `'gateway'` string model
(`"anthropic/claude-opus-5"` through Vercel AI Gateway) is one more factory
line, since the AI SDK resolves the string itself.

### 4. Streaming

```ts
// app/Http/Controllers/SupportChatController.ts
export class SupportChatController extends Controller {
  async chat() {
    const { conversation, message } = await this.validateBody(ChatTurnSchema)
    const user = await this.auth.userOrFail()
    return this.make('ai').agent(SupportTriager).as(user)
      .continue(conversation)
      .stream(message, { signal: this.request.signal })
  }
}
```

`stream()` returns `createAgentUIStreamResponse(...)`: a streaming `Response`
`Router` already passes through untouched (`result instanceof Response`), so
`Controller` needs no new member. `ChatTurnSchema` is exported for
`validateBody`, because the body arrives as JSON from a `fetch`-based
transport and the route contract should say so.

**History is authoritative server-side.** The client sends the new user
turn and the conversation id, never the transcript: a history assembled
by the client is user-controlled input wearing assistant and tool roles,
and accepting it would let a browser fabricate what the model "already
did". With a conversation bound (§5) the store supplies the history. A
stateless chat (no conversation) accepts a `UiMessagesSchema` body instead,
and `stream()` keeps only the `user` parts of it; assistant and tool parts
from the client are dropped, which the docs say and `guren check` has no
way to see.

Client side, `@guren/plugin-ai/client` exports `createChatTransport(url)`, a
`ChatTransport` for `useChat` that speaks the protocol above rather than
`DefaultChatTransport`'s (which posts the whole `messages` array):

- **Request body** is `{ conversation, message }`: the last `user` message
  of the `useChat` state, and the conversation id the transport holds.
- **First turn** sends `conversation: null`; the server starts one (§5) and
  answers with the id in a `X-Guren-Conversation` response header, which
  the transport stores and sends on every later turn. A page reload
  re-enters through `useChat({ id })` with the conversation id the page
  props carry, and the initial messages come from the server's history in
  the same props, never from the client's memory.
- **CSRF**: the `XSRF-TOKEN` cookie goes back as the `X-XSRF-TOKEN` header
  with `credentials: 'same-origin'`, which is what Inertia's axios does and
  a bare `fetch` does not.

`@guren/inertia-client` stays untouched; the subpath keeps `ai` out of
every app that has no chat.

```tsx
const { messages, sendMessage } = useChat({
  id: conversationId,
  transport: createChatTransport(route('support.chat')),
})
```

`broadcast(input, channel)` (Part 2) queues the prompt (§6) and emits each
UI-message chunk over `BroadcastManager` to the channel, which is
laravel/ai's `broadcast()` on Guren's existing broadcasting layer.

### 5. Conversations

```ts
const first = await SupportTriager.as(user).prompt('Hello')          // starts one when conversations are on
const next = await SupportTriager.as(user).continue(first.conversationId).prompt('Tell me more')
```

```ts
export interface ConversationStore {
  create(meta: { agentName: string; owner: AgentPrincipal }): Promise<string>
  /** Resolves only when `owner` matches the recorded one; a mismatch is `null`, never another owner's rows. */
  load(id: string, owner: AgentPrincipal): Promise<{ agentName: string; messages: ModelMessage[] } | null>
  append(id: string, owner: AgentPrincipal, messages: ModelMessage[]): Promise<void>
}
/** Augmentable, the SessionDrivers pattern. */
export interface ConversationDrivers {
  memory: {}
  database: { conversations: Table; messages: Table }
}
```

The owner is on every call because the store is the only thing that can
enforce it: no route is involved, so no policy runs. `continue(id)` under a
principal other than the recorded owner, or under `as(null)`, is refused
before any model call; an anonymous run cannot start a conversation either,
since `'anonymous'` would be one owner shared by every unidentified caller.
The same check runs on the `conversation` option of `prompt()`, `stream()`
and `queue()`, which is why the owner travels in the queue payload (§6).
The agent name is recorded and compared too, so a conversation started with
one agent's instructions is not silently continued by another's.

Messages are stored in the AI SDK's `ModelMessage` shape, one row each, so a
stored conversation replays into any provider and a reader does not need the
plugin to interpret it. **A stored conversation is replay history, not a
sanitized record.** The pipeline's redaction (`redactAgentArguments`) masks
tool-call *arguments* for the audit trail; a tool's response body, the
user's own text and a local tool's result are never masked, and replay
needs the real values (a masked id cannot be acted on in the next turn).
So the store keeps the transcript as the model saw it, the table is
sensitive data and the docs say so, and anything that *exports* a
conversation (`--from-conversations` in §10, a future admin view) runs the
argument redaction on the way out and prints the retention question rather
than claiming the rows are safe.

`memory` lives in the plugin for tests and development. `database` lives in
the plugin as well, wrapping the two tables `guren add ai` scaffolds
(`ai_conversations`, `ai_messages`, per dialect, like `sessions` in RFC 0020
§2) in ORM Models; a plugin may depend on `@guren/core`, so the
server/core split that forced RFC 0020's `database` driver into core does
not apply. The `database` entry in `config/ai.ts` names both tables, as
`configureAttachments()` and the `database` session driver do. A third
driver is the seam the AgentCore RFC fills (`agentcore`: `create_event` per
turn, keyed by actor and session).

### 6. Queueing

```ts
await SupportTriager.as(user).queue('Ticket #4812: ...', { conversation: id })
```

One framework job, `RunAgentJob`, with payload
`{ agentName, input, principal, conversationId?, provider? }`, every field a
string or a plain object: `provider` is a config name (§3), never a model
instance, which is what makes the per-call override serializable. Agents are
resolved from `agentName` through a registry the plugin fills at boot from
`aiPlugin({ agents: [SupportTriager] })`, the same rule the queue uses for
jobs (`getJob`): a class name is not a durable key (the identifier-mangling
pitfall), and a queued message must survive a deploy. Completion emits
`AgentResponded { agentName, principal, conversationId, response }` on the
`EventManager`; laravel/ai's `->then(closure)` has no serializable
counterpart, and an event is what the rest of Guren already listens to.
`AgentPrincipal` is `{ kind, id, abilities? }`, serializable as-is.

### 7. Testing (`@guren/testing`)

```ts
using ai = app.fakeAi()
ai.respond(SupportTriager, [
  { output: { category: 'billing', priority: 2, summary: 'Refund request' } },
])

await app.post('/tickets/4812/triage').assertRedirect('/tickets/4812')

ai.assertPrompted(SupportTriager, (input) => input.includes('#4812'))
ai.assertNeverPrompted(ReviewAgent)
ai.calls(SupportTriager)[0].toolCalls   // what the (real) tools were asked
```

`fakeAi()` replaces the `ai` binding with `container.fake('ai', …)` on the
application `TestApp.fromApp()` booted; the fake's `model()` returns a
`MockLanguageModelV4` scripted by `respond()`: a text response, an
`output`, or a sequence that first requests tool calls and then answers.
The fake is total because `AiManager.model()` is the only place a model is
resolved (§1, §3): an agent names a provider, never holds a model, so no
class-level or per-call value can reach the network around the fake.
**Tools execute for real**: `appTools()` still goes through
the pipeline, so a test sees the approval gate refuse and the audit sink
record, which is the wiring the test exists to prove. A fake that also
stubbed the tools would pass with a route the agent could never reach.
`respond()` with nothing scripted makes any prompt a test failure naming the
agent, so an untested agent cannot pass by returning an empty string.

**Amended in implementation:** a scripted response is a string, `{ text }`,
`{ output }` or `{ toolCalls, then }`, and each prompt consumes one. Since
`model()` is told a provider and never a class, the fake constructs agents
through `bindAgent` (exported for this) with a per-class manager. An
unscripted prompt throws naming the agent, and disposing the fake throws
again, because a route turns the first throw into a 500 whose body names
nothing. `assertNotPrompted(Agent, predicate)` fails on a matching prompt and
`assertNeverPrompted(Agent)` on any prompt. `@guren/plugin-ai` and `ai` are
optional peers of `@guren/testing`, imported when `fromApp()` boots an app
that binds `ai`, which keeps `fakeAi()` synchronous.

A fake measures the wiring and nothing else; whether the instructions and
the tool descriptions get the right answer out of the model is §10's job.

### 8. CLI

- **`guren add ai`**: installs `ai` and the chosen provider package
  (`--provider anthropic|openai|gateway`, default `anthropic`), writes
  `config/ai.ts`, the env entries (`AI_PROVIDER`, the provider's key) into
  `config/env.ts` and `.env.example`, the two conversation tables plus a
  migration (`--no-conversations` skips them), and `aiPlugin()` into
  `createApp({ providers })`. `.env.test` gets a placeholder key, since
  tests run against the fake.
- **`make:ai-agent Name`** → `app/Ai/Agents/Name.ts`, appended to the
  `app/Ai/agents.ts` registry (§11); `--tools a,b` fills `appTools()` from
  route names it verifies exist; `--output` adds a Zod schema stub; `--test`
  writes the fake-driven test. **`make:ai-tool Name`** → `app/Ai/Tools/Name.ts`.
  **`guren codegen`** gains `AgentToolInputTypes` and the `@guren/plugin-ai`
  augmentation in `.guren/agents.gen.ts` (§11), emitted only for an app that
  depends on the plugin so an app without it sees no change. The names avoid
  `make:agent`, which RFC 0017
  owns (`app/Agents`, `config/agents.ts`, a Workers-only class); a durable
  agent and an in-process one are different things and the scaffold should
  not blur them.
- **`guren check`** (content-activated, nothing runs for an app with no
  `Agent` subclass): a literal `appTools([...])` name that no `.agent()`
  route derives; a name outside the class's `static scopes`; an `Agent`
  subclass in an app whose `createApp()` never registers `aiPlugin()`; a
  computed `appTools()` argument is reported unverifiable, never passed
  (the AST rule from RFC 0021's prototype check).
- **`guren audit`**: the local-tool advisory from §2.4.
- **`guren context`** and `spec:generate` list agents with their tools and
  output schema next to models (Part 3).
- **Deploy builds**: `ai` and the first-party providers are `fetch`-based;
  nothing joins `DEV_ONLY_MODULES`. The Cloudflare bundle probe
  (`wrangler-bundle.test.ts`) gains a fixture that imports the plugin, so a
  future provider that reaches `node:*` is caught by the measurement rather
  than by a user's deploy. Node ≥ 22 is the AI SDK's floor, already Lambda's.

### 9. Harness

The agent harness template (RFC 0008) gains `.claude/skills/ai-agent/`: how
to write an `Agent`, when to reach for `appTools()` over a local tool, the
fake-first test, and how to read and run an eval (§10). `guren agent:sync`
distributes it (Part 3).

### 10. Evals

A fake (§7) proves the wiring: deterministic, free, in `bun test` and CI. It
says nothing about whether the model, the instructions and the tool
descriptions produce the right answer, and nothing can, short of calling the
model. An eval is that call, run over a case set with a grader, on purpose
and at a cost. The two are not substitutes, and the mistakes on each side
are symmetric: a fake-only app ships a prompt nobody measured; an eval in
`guren check` makes every PR pay for a nondeterministic gate. So evals are
**opt-in, on demand, never part of `guren check` or `guren gate`**, and never
a substitute for the fake in a test file.

What the framework owns here is small, on purpose: **isolation, the real
invocation, and structured outcomes.** Each case runs the application's
agent through the real path in a disposable app, and the runner records
what happened in a shape a reporter can read. Everything else (the on-disk
layout, the report viewer, the split, the statistics, the hill-climbing
loop) is a *reporter*, and the default reporter writes the layout the
claude-api harness's builders and `hillclimb` read, because that method
already exists and its own rule is that a tool must not mandate a format
or reimplement the app. An app with a different eval framework registers a
different reporter and keeps the runner.

```ts
// tests/evals/support-triage.eval.ts
import { defineEval, fromJsonl } from '@guren/plugin-ai/eval'
import { factory } from '@guren/testing'

export default defineEval({
  agent: SupportTriager,
  cases: fromJsonl('tests/evals/support-triage/cases.jsonl'),  // { id, input, expected?, tags }
  as: () => factory(User).create({ role: 'support' }),        // the principal each case runs as
  setup: async (app, c) => { await factory(Ticket).create({ id: c.expected.ticketId, ...c.seed }) },
  grade: async ({ app, response, expected }) => ({
    category: response.output.category === expected.category ? 1 : 0,
    // End state over transcript: what the tools actually wrote, read back from the test database.
    prioritySet: (await Ticket.find(expected.ticketId))?.priority === expected.priority ? 1 : 0,
  }),
  judge: { agent: TriageJudge, provider: 'judge' },   // optional; a config/ai.ts provider, usage recorded separately
  metrics: [{ id: 'category', kind: 'binary' }, { id: 'prioritySet', kind: 'binary' }],
})
```

```bash
bunx guren ai:eval support-triage --reps 2 --max-cost-usd 5           # baseline/
bunx guren ai:eval support-triage --variant v1 --cases 20             # a round
bunx guren ai:eval support-triage --from-conversations 50 --dry-run   # sample stored cases, write nothing
```

What the runner does, and why each rule is there:

- **Each case runs in a `TestApp`** with the test database, mail and queue
  already faked, and a fresh `setup()`. The agent's `appTools()` dispatch
  through the pipeline against that app, so a case exercises scopes,
  policies, the approval gate and redaction, and the grader can read the
  **end state** (rows the tools wrote) rather than the transcript. This is
  the "thin test-mode wrapper" the eval method allows, and the only thing it
  mocks is what production would touch.
- **The default reporter writes `.claude/hillclimb/<flow>/<variant>/`**:
  `results.jsonl` appended per `(case, rep)` as each completes,
  `traces/<id>_rep<k>.json` in the `{role, content, name?}` turn shape,
  `summary.json`, and an `errors.jsonl` sidecar for attempts that produced
  nothing scorable. `_state.json` is written once with the case ids split
  at random, stratified by `tags[0]`, and never edited by the runner after
  that. Guren emits this layout because it is the one the harness's report
  builders and `hillclimb` already read; it ships no viewer of its own, and
  a `reporter` option on `defineEval()` swaps the layout for another.
- **Model and usage come from the response**, never from config: the AI SDK
  returns both on every step. Cost is computed by the runner, not the
  reporter, from the recorded tokens and the row's model against
  `AiProviderConfig.pricing` (`{ input, output, cacheRead? }` per million
  tokens, optional, in `config/ai.ts`), so every reporter sees the same
  number and a provider with no pricing yields a row with no cost rather
  than a zero. Judge usage and cost go in their own fields, so a judge
  cannot dampen a difference between variants. A row missing `model`,
  `usage` or the trace is a runner failure that stops the run, not a row
  with zeros.
- **Plumbing is not a model result, and it is not hidden either.**
  `finishReason === 'length'` is `status: truncated`, kept out of the
  quality mean and **counted in the summary line next to it**; a refusal is
  a graded outcome with its own metric; a provider error after jittered
  backoff, a tool that threw, a grader crash and the per-case wall-clock
  ceiling all go to the sidecar with a failure class and the retry count,
  and the sidecar's count is printed beside the headline. A variant that
  "improves" by truncating or erroring more shows it on the same line.
  Resume is idempotent at `(case, rep)`; a crash after the model answered
  but before the row was written re-runs and re-pays that case, which the
  docs say rather than promising otherwise.
- **`--max-cost-usd`** is a soft ceiling: no new case starts once the
  derived cost crosses it, and cases in flight complete. The summary prints
  an approximate half-width for a binary pass rate (`1/sqrt(n·reps)`, the
  eval method's own rule of thumb) beside the headline, labelled as such,
  so a two-point move on twenty cases reads as the noise it is; reps of one
  case tighten sampling noise and nothing else.
- **`--from-conversations N`** samples stored conversations (§5) as cases,
  running the argument redaction on the way out. That masks tool
  arguments only: the user's text and every tool response are in the rows
  as the model saw them, so the command prints the PII and retention
  question before writing a file, and `--dry-run` answers it without one.

The grader is the app's. `grade()` is a function because the eval method's
first rule for an agent that acts on an environment is a programmatic check
of what it left behind, and a Guren app can read its own database. A judge
is an `Agent` with an `Output.object` rubric (§1), which keeps it in the
same class the app already tests; the guide's rules for judges (a different
model from the one under test, randomized A/B in pairwise, one property per
call, candidate text as data) are documented, not enforced.

A scheduled workflow template (`guren add ai --evals`, opt-in) runs the
baseline nightly with a cost cap and reports the headline against the last
committed baseline, the shape the repo already uses for the published
package drift check. It never runs on a PR.

Ships in Part 3, after the fake and `stream()` exist to be measured.

### 11. Type safety

The RFC 0016 surface is stringly typed at its edges by nature (an MCP client
sends a name), and every string it introduces here is a place a typo grants
nothing, silently. The rule for this plugin is the one the rest of Guren's
codegen follows: **a name the compiler can know is a type, a name it cannot
know is a `guren check` rule, and a runtime error is the last line.** Each
string in the sections above, and what types it:

| String | Typed by | Mechanism |
|---|---|---|
| `appTools(['tickets.index'])` names | `AgentToolName` from `.guren/agents.gen.ts` (exists today) | the generated file augments `interface AppAgentTools` in `@guren/plugin-ai`, as `translations.gen.ts` augments `GurenTranslationKeys` |
| each tool's input and result | `AgentToolInputTypes` (new) and `AgentToolOutputTypes` (exists) in the same file | `appTools()` returns `{ [K in N]: Tool<AgentToolInputTypes[K], AgentToolOutputTypes[K]> }`, so a local tool that composes a result is typed against the route's contract |
| `static scopes` entries | `` `tool:${AgentToolName}` \| `tools:${string}.*` \| 'tools:read' \| 'tools:*' `` | a template-literal type; the `tool:` form is exact, the prefix form is checked only for shape (a prefix is not a name) |
| "every `appTools()` name is granted" | `Granted<typeof Class.scopes, N>` over an `as const` tuple, for `tool:` entries | conditional type on the tuple; a prefix grant is settled at construction (§2.2) and by `guren check` |
| `provider` and `PromptOptions.provider` | `AiProviderName` | `config/ai.ts` is scaffolded with `declare module '@guren/plugin-ai' { interface AiProviders extends InferProviders<typeof config> {} }`, the `OrmConnectionEnv extends AppEnv` pattern in `@guren/core`; no codegen, the config is the source |
| `env.ANTHROPIC_API_KEY` in `config/ai.ts` | `AppEnv` (RFC 0027 §1) | already typed; a key absent from `config/env.ts` is a compile error in the resolver |
| `agentName` in `queue()`, `AgentResponded`, `respond()`, `assertPrompted()` | `AiAgentName` | `app/Ai/agents.ts` is the registry `aiPlugin({ agents })` reads (the `config/agents.ts` shape of RFC 0017), and it augments `interface AiAgents`; `make:ai-agent` appends to it |
| `response.output` | `InferAgentOutput<this>` | inferred from the class's `output` member through the polymorphic `this` type, so a class declares its schema once and never restates it as a generic |
| `respond(Class, [...])`, `grade({ response })` | `AgentResponse<InferAgentOutput<Class>>` | a scripted `output` that does not match the schema is a compile error in the test, not a runtime parse failure |
| conversation ids | `ConversationId`, a branded string | `continue(ticketId)` does not compile; `create()` is the only producer |
| `route('support.chat')` in `createChatTransport` | the route manifest (`createTypedLink` precedent) | already typed; `ChatTurnSchema` bound on the route contract puts the body in `ApiRoutes['support.chat']['body']`, so the transport's request type and the controller's `validateBody` type are one |
| `metrics` in `defineEval()` | `keyof ReturnType<typeof grade>` | `metrics` is constrained to the ids `grade()` returns, so a metric that is never scored is a compile error |
| `this.make('ai')` | `ServiceBindings['ai']` | the augmentation in §3 |

What types cannot reach, and where it goes instead:

- A **computed** `appTools()` argument or scopes list widens to `string`;
  `guren check` reports the call as unverifiable rather than passed (the
  RFC 0021 rule), and the construction error of §2.2 stands behind it.
- The **JSON Schema** a tool advertises is data at runtime. The type twin in
  `agents.gen.ts` is derived from the same Zod extraction `api-client.gen.ts`
  uses, so the two cannot disagree about a route, but a schema the extractor
  cannot render (the unresolved-type warning codegen already prints) types
  as `unknown` there, never as a guess.
- The **model's own output** is validated by the AI SDK against the `output`
  schema at runtime; the type says what a valid response is, and a
  `finishReason` that is not `'stop'` or a refusal is surfaced on the
  response, not typed away.
- **Stored conversations** replay as `ModelMessage[]`, typed by the AI SDK;
  the agent name recorded on the row is compared at `load` (§5) because a
  row written by a previous deploy is data, not a type.

The manifest additions land in Part 1 with `appTools()`; nothing in this
section is a new runtime, only the compile-time twin of names the runtime
already checks.

### Package boundaries

| Layer | Package |
|---|---|
| `'in-process'` surface member | `@guren/server` (minor) |
| `Agent`, `agent()`, `appTools`, `defineAiConfig`, `AiManager`, conversation stores, `RunAgentJob`, `AgentResponded`, `stream`, `broadcast`, `/client` transport, `/eval` (`defineEval`, the runner) | `@guren/plugin-ai` (0.x) |
| `fakeAi()` | `@guren/testing` |
| `guren add ai` (`--evals`), `make:ai-agent`, `make:ai-tool`, `ai:eval`, the `agents.gen.ts` type additions, checks, audit advisory, context/spec | `@guren/cli` |
| Harness skill | `packages/cli/templates/agent/` |

### Phasing

1. ~~**Part 1**: `Agent` (§1), `appTools()` and the surface (§2), `config/ai.ts`
   (§3), `fakeAi()` (§7), `guren add ai` and `make:ai-agent` (§8), the typed
   names of §11. Everything a first feature needs, testable without a
   network and with every name checked by the compiler.~~
   **Amended in implementation:** Part 1 ships as two PRs.
   - **Part 1a**: the `'in-process'` surface member (§2.3), `Agent` with
     `prompt()` (§1), `appToolDefinitions()` / `appTools()` (§2),
     `aiPlugin({ audit, approvals })` (§2.5), `defineAiConfig` and
     `AiManager` (§3), and the empty augmentation targets `AppAgentTools`,
     `AiProviders` and `AiAgents` (§11) with `InferProviders`. `Agent` and
     `appTools()` land together, so no release has a model-calling class
     whose only route into the application is a hand-written closure.
     `AgentResponse` carries `finishReason`; `conversationId` and
     `PromptOptions.conversation` wait for §5 in Part 2. Tested against
     `MockLanguageModelV4` from `ai/test` directly.
   - **Part 1b**: `fakeAi()` (§7), `guren add ai` and `make:ai-agent` (§8),
     and the `.guren/agents.gen.ts` additions that fill the §11 targets
     (`AgentToolInputTypes`, `Granted`).
2. **Part 2**: `stream()` and the client transport (§4), `database`
   conversations (§5), `queue()` and `AgentResponded` (§6), `broadcast()`.
3. **Part 3**: `embed()` / `image()` thin wrappers on the configured
   provider, `guren check` and `guren audit` rules, `context` /
   `spec:generate`, `defineEval()` and `guren ai:eval` (§10), the harness
   skill, `docs/en/guides/ai-agents.md`, the blog example gaining one agent
   and one eval.

Each PR references `RFC 0029`. A tutorial chapter follows Part 2.

## Alternatives Considered

- **Port laravel/ai's gateways: a provider layer of our own.** Eight
  provider implementations to maintain, a second message shape the
  ecosystem's client hooks do not understand, and no `useChat`. laravel/ai
  wrote gateways because nothing in PHP offered them; `ai` offers them and
  every provider implements its interface.
- **Wrap `@anthropic-ai/sdk` and its tool runner directly.** The best
  Anthropic-specific surface, and the wrong altitude for a framework layer:
  one provider, no `useChat`, no shared mock. An app that wants it passes a
  custom `LanguageModel` (the AI SDK's Anthropic provider is that wrapper
  already), and nothing here prevents calling the SDK from a tool.
- **Build on Mastra (`@mastra/core` 1.67 at time of writing) instead of the
  AI SDK.** Mastra has the most of what this RFC leaves out: memory beyond
  thread history (working memory, semantic recall over a vector store),
  workflows with suspend/resume, live scorers with sampling, sub-agents,
  RAG, a playground, and a Hono server adapter. It is the right base for an
  app whose *product* is an agent system. It is the wrong base for this
  plugin for four reasons, each a duplication of something Guren already
  owns: a `Mastra` instance is a second registry and container beside
  Guren's (agents, workflows, storage, logger resolved from it, not from
  `createApp()`); its storage adapters (LibSQL, Postgres, D1) are a second
  way to reach the database beside the ORM, with their own tables and
  migrations; its model router reads provider keys from `process.env`,
  which is the trap §3 avoids with the validated env; and its MCP server
  bridges through Node `IncomingMessage` (`toReqRes` in the Hono adapter)
  where `@guren/plugin-mcp` is web-standard, which matters on Workers. Its
  core dependency list (`execa`, `ws`, `posthog-node`, three `@ai-sdk/provider`
  spec versions, `@modelcontextprotocol/server`) is also the footprint RFC
  0016 kept out of every app that has no agent surface. What Mastra shows
  is the seam to keep: its `beforeToolCall` hook is the pipeline's
  `interpose`, and its `tools` accept a plain definition, so
  `appToolDefinitions()` (§2) is what a later `@guren/plugin-mastra` adapter
  would wrap, giving an app that wants workflows or semantic recall
  Mastra's runtime with Guren's gates. That adapter is out of scope here
  and listed under Open Questions.
- **Put `Agent` in `@guren/server` or `@guren/core`.** Every app would carry
  `ai`, and the deploy builds would grow a stub for it. RFC 0016 kept the MCP
  transport out of server for the same reason.
- **Extend `@guren/plugin-agents`' `GurenAgent` with model calls.** RFC 0017
  §8 refuses this on purpose; its import graph reaches `cloudflare:workers`,
  so the class cannot be evaluated on Bun, and a durable agent is a
  different thing (identity, alarms, state) from a class a controller calls.
  A durable agent *uses* an `Agent` from this plugin; it does not become one.
- **Hand-declared tools only.** Smaller plugin, and the privileged path from
  the Problem section in every app. The whole reason to do this in the
  framework is that `deriveAgentTools` already exists.
- **A provider driver registry (`AiDrivers`) with lazy imports inside the
  plugin.** The framework ships no provider, so a registry would relabel a
  factory the app wrote anyway, and the variant that imports providers from
  inside the plugin is the barrel shape RFC 0022 measured. A registry fed
  by app-imported factories would bundle cleanly; it is just the `providers`
  map of §3 with a second name.
- **Store conversations in `sessions`.** Different lifecycle (a conversation
  outlives a login), many per user, unbounded size, and no redaction pass.
- **`.then(closure)` on `queue()`.** Not serializable across a worker; an
  event is.
- **Make `Controller.stream()` a base-class member.** `Controller` is in
  server, `createAgentUIStreamResponse` is in `ai`; the static `stream()` on
  the agent returns a `Response` the router already passes through.

## Migration Path

Additive. No existing call changes behaviour.

- `AgentSurface` gains a member. App code that switches over it exhaustively
  (the pattern the audit module uses) gets a compile error naming the new
  case; that is the intended effect, and the change ships as a server minor
  with a changeset that says so.
- `ConfigDefinitions` and `ServiceBindings` are augmented from the plugin;
  an app that does not install it sees no change.
- `make:agent`, `app/Agents` and `config/agents.ts` remain RFC 0017's.
- No deprecation is introduced.

## Open Questions

1. **Scaffold default provider.** `anthropic` (the harness is Claude-based,
   and `claude-opus-5` is the model the docs will show) versus `gateway`
   (one key for every provider, a Vercel account). Leaning `anthropic`, with
   `--provider gateway` documented on the Vercel deploy page.
2. **Thinking display.** The AI SDK exposes Anthropic's adaptive thinking
   through provider options; should `Agent` default `display: 'summarized'`
   when streaming so a chat UI does not show a long pause? Provider-specific,
   so probably a documented `providerOptions` on the class rather than a
   default.
3. **`appTools()` with no argument.** Every `.agent()` route within
   `static scopes`, or an error? Leaning error: an agent's tool list is the
   thing a reviewer reads first, and "everything I am allowed" hides growth.
4. **Conversation row shape.** `ModelMessage` (provider-neutral, what the
   model saw) or `UIMessage` (what the client rendered, parts included)? The
   client can be rebuilt from `ModelMessage`; the reverse loses provider
   metadata. Leaning `ModelMessage` with `UIMessage` conversion at `stream()`.
5. **Embeddings and a vector column.** `embed()` in Part 3 returns numbers;
   where they go is the ORM's business, and `@guren/orm` has no vector type
   today. Out of scope here, noted because the first RAG user will ask.
6. **Naming.** `app/Ai/Agents` versus `app/Agents/Ai`; `make:ai-agent` versus
   `make:agent --ai`. The RFC picks the first of each so a durable agent and
   an in-process one never share a directory.
7. **The eval report.** The harness's report builder is the viewer for the
   §10 layout, and the lite one is a 15 KB dependency-free script that the
   claude-api skill extracts, not something an app's repo holds. Should
   `guren add ai --evals` vendor it into the app (self-contained evals, a
   copy to keep current) or should `ai:eval` print the path and the
   command (no copy, a harness the app must have installed)? Leaning print:
   Guren emits data, and the eval method owns its viewer.
8. **Conversation retention and redaction hooks.** §5 stores the transcript
   as the model saw it. Should the store take a per-agent `retain` (days)
   and a `beforeStore(message)` hook so an app can mask its own fields
   (an order number, an email) before a row is written, at the cost of a
   replay that no longer matches what the model saw? Leaning: `retain` yes
   (a `ai:conversations:prune` command, like `sessions:prune`), `beforeStore`
   deferred until an app asks, since it changes what "history" means.
9. **A Mastra adapter.** `appToolDefinitions()` is runtime-neutral so that a
   `@guren/plugin-mastra` could hand a Mastra `Agent` the application's
   gated tools and mount `MastraServer` on Guren's Hono under a prefix with
   the request's principal bridged into Mastra's `requestContext`. Worth
   its own small RFC once an app asks for workflows or semantic recall;
   the open question is whether `ConversationStore` should also be
   expressible as a Mastra storage adapter or whether the two memories
   simply stay separate.
10. **AgentCore seams.** The follow-up RFC needs `ConversationDrivers.agentcore`
   and an `'agentcore'` surface member, and its Runtime entry hosts an
   `Agent` from this plugin behind `POST /invocations`. Is `stream()`
   returning a `Response` enough for that entry, or does the Runtime need
   the `createAgentUIStream` iterable form exposed as well? Leaning: export
   both, since the iterable is what a non-HTTP host (a Job, a Worker) wants.
