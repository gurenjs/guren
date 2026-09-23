# @guren/plugin-ai

## 0.4.0

### Minor Changes

- 002d087: Evaluation models in `config/ai.ts` (RFC 0029 §3, amended). A provider entry may carry `evaluationModel: () => AiEvaluationModel`, an AI SDK evaluation model such as `createTypeSafeAi().evaluationModel('jev-latest')` or `gateway.evaluationModel('typesafe-ai/jev')`, and `model` is now optional so an entry may exist for evaluation alone. `AiConfig.defaultEvaluation` names the entry evaluations use when the call names none (checked at boot like `default`; `default` when absent). `AiManager` gains `evaluationModel(provider?)`, memoized like `model()`, and `evaluate({ state, questions, provider?, manager? })` joins `embed()` and `image()`: the AI SDK's `experimental_evaluate` with the model resolved by provider name, so `fakeAi()` scripts every answer. The `AiEvaluation*` types re-export the SDK's; the SDK marks the API experimental and may change it in a patch release, so `ai` now needs `^7.0.106`.

### Patch Changes

- Updated dependencies [002d087]
- Updated dependencies [002d087]
- Updated dependencies [002d087]
- Updated dependencies [002d087]
- Updated dependencies [002d087]
- Updated dependencies [002d087]
- Updated dependencies [002d087]
  - @guren/core@1.21.0

## 0.3.0

### Minor Changes

- 1cfe6a0: `broadcast(input, channel, options)` (RFC 0029 §4) queues the run like `queue()`, and the worker publishes each UI-message chunk to `channel` as the `AgentChunk` broadcast event:

  ```ts
  await SupportTriager.as(user).broadcast(
    "Ticket #4812: ...",
    `private-support.${user.id}`,
    { conversation: true }
  );
  ```

  - `AGENT_CHUNK_EVENT` is exported from `@guren/plugin-ai` and `@guren/plugin-ai/client`.
  - Publishing is not authorized: register the channel as a private channel with an authorizer, or anyone subscribed reads the transcript.
  - A run that fails before finishing publishes one `error` chunk, so subscribers are not left waiting. An `error` chunk fails the job.
  - A broadcast run emits no `AgentResponded`; the `finish` chunk ends it. An agent with an `output` schema is refused.

- 43f80e6: Add `embed()`, `embedMany()` and `image()` (RFC 0029 Part 3): the AI SDK's own
  calls with the model resolved by provider name through `AiManager`, so nothing
  in an application holds a model and `fakeAi()` answers them as it answers a
  prompt. `AiManager` gains `imageModel(provider?)` beside `embeddingModel()`.
  Each wrapper takes the SDK's own options plus `provider` (a name from
  `config/ai.ts`) and `manager` (the default application's `ai` binding when
  absent). Vector storage stays out of scope.
- 731d296: Agents queue (RFC 0029 §6). `queue(input, options)` runs `prompt()` on a worker, which emits `AgentResponded` when the model answers:

  ```ts
  providers: [aiPlugin({ agents: [SupportTriager] })]

  const { conversationId } = await SupportTriager.as(user).queue('Ticket #4812: ...', { conversation: true })

  events.on(AgentResponded, ({ agentName, principal, conversationId, response }) => { ... })
  ```

  - A queued agent must be registered with `aiPlugin({ agents })`. The worker resolves the class from its `agentName`, and `queue()` refuses an unregistered class before dispatching. Two classes under one name are refused at boot.
  - `conversation: true` creates the conversation before dispatching and returns its id, which can be continued or queued on at once.
  - `RunAgentJob` runs once (`maxAttempts: 1`): a retry would re-run every tool the first attempt ran. Keep the worker `--timeout` and the driver's visibility timeout above the longest run, or it is delivered again.
  - `AgentResponded.response` carries `text`, `output`, `usage` and `finishReason`, not `steps`.
  - The principal is recorded when the run is queued, abilities included.

- eae78ea: Add `@guren/plugin-ai/eval`: `defineEval()` and the eval runner (RFC 0029 §10).

  An eval calls the real model over a case set with a grader, which is the one
  thing a fake cannot measure. Each case runs in its own disposable app, so the
  agent's `appTools()` dispatch through the invocation pipeline and the grader
  reads the end state its tools wrote rather than the transcript. The runner
  records model and usage from the response, derives cost from the provider's
  `pricing` (absent, a row carries no cost rather than a zero), keeps a
  truncated answer out of every metric mean and counts it beside them, and sends
  an attempt that produced nothing scorable to a sidecar with its failure class
  and retry count. `hillclimbReporter()` writes the `.claude/hillclimb/` layout
  the claude-api harness's report builders read; `defineEval({ reporter })`
  swaps it.

  Evals are opt-in and never part of `guren check` or `guren gate`.

  Refs: RFC 0029

### Patch Changes

- 50dbc9c: Fix the README's controller snippet, which passed a principal `as()` cannot use. `this.auth.user()` resolves to `Authenticatable`, which carries no `id`, and it can be `null`; `as(null)` is an anonymous run restricted to read-only tools, so the snippet's own `tickets_update` is refused at `as()`, which calls `tools()` eagerly. Written inline the call still compiles, because `user<T>()` infers `T` from the argument position and the generic collapses to whatever `as()` accepts; hoisted into a variable the same call is a TS2345. The README now shows `await this.auth.userOrFail<{ id: number }>()`.
- b280d7e: Add an npm `description` and `keywords` to every package. Thirteen of the sixteen packages published with neither, so their npm pages and search results showed no summary. The wording states the runtime story once: develop on Bun, deploy to Bun, AWS Lambda (Node.js), Vercel or Cloudflare Workers.
- Updated dependencies [b280d7e]
  - @guren/core@1.20.1

## 0.2.0

### Minor Changes

- d6e8b00: Agents keep conversations (RFC 0029 §5). Configure a store in `config/ai.ts`, then start a conversation with `prompt(input, { conversation: true })` and continue it with `continue(id)`:

  ```ts
  const first = await SupportTriager.as(user).prompt("Hello", {
    conversation: true,
  });
  const next = await SupportTriager.as(user)
    .continue(first.conversationId!)
    .prompt("Tell me more");
  ```

  - `conversations: { driver: 'memory' }` keeps history in the process. `{ driver: 'database', conversations, messages }` stores it in two tables through ORM Models, one row per `ModelMessage`.
  - A plain `prompt()` stores nothing.
  - A conversation belongs to the principal that started it and to its agent. `continue()` under another principal, another agent or `as(null)` is refused before any model call. So is a conversation with an `agent()` that has no `agentName`.
  - Each turn is appended in one transaction, after the model answers.
  - The stored transcript is what the model saw, tool results included, so treat the tables as sensitive data.
  - `AiManager` gains a required `conversations()` method. A hand-written `AiManager` implementation must add it.
  - The `database` driver appends inside `Model.transaction()`, so it needs a database driver with interactive transactions.

- 180194e: Agents stream (RFC 0029 §4). `stream(input, options)` returns a UI-message stream `Response` for `useChat`, and `@guren/plugin-ai/client` exports `createChatTransport()` to consume it:

  ```ts
  async chat() {
    const { conversation, message } = await this.validateBody(ChatTurnSchema)
    const user = await this.auth.userOrFail()
    return this.make('ai').agent(SupportTriager).as(user).stream(message, { conversation: conversation ?? true, signal: this.request.raw.signal })
  }
  ```

  ```tsx
  const { messages, sendMessage } = useChat({
    transport: createChatTransport("/support/chat", {
      conversation: props.conversationId,
    }),
  });
  ```

  - An agent that declares `output` cannot stream; call `prompt()` for its parsed value.
  - A started or continued conversation is named in the `X-Guren-Conversation` response header. The turn is stored when the stream ends. An aborted turn stores nothing, and a storage failure is logged.
  - A chat needs `conversations` in `config/ai.ts`: the server holds the history, and the first turn fails naming the missing store when none is configured.
  - The transport posts `{ conversation, message }` with the `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`. That is the last user message as text, never the transcript, since the server holds the history. It refuses `regenerate-message` and a message with a file attached.
  - `ChatTurnSchema` validates that body. `zod` is now a peer dependency, on the range `ai` itself requires.

### Patch Changes

- Updated dependencies [de87223]
- Updated dependencies [727d017]
  - @guren/core@1.20.0

## 0.1.0

### Minor Changes

- 029a516: New package: in-process AI agents on the Vercel AI SDK (RFC 0029 Part 1a).

  ```ts
  // config/ai.ts
  export default defineAiConfig((env) => ({
    default: "anthropic",
    providers: {
      anthropic: {
        model: () =>
          createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })("claude-opus-5"),
      },
    },
  }));

  // app/Ai/Agents/SupportTriager.ts
  export class SupportTriager extends Agent {
    static override agentName = "support-triager";
    static override scopes = [
      "tool:tickets_show",
      "tool:tickets_update",
    ] as const;
    instructions = "You triage support tickets.";
    output = Output.object({ schema: Triage });
    override tools() {
      return this.appTools(["tickets_show", "tickets_update"]);
    }
  }

  // a controller
  const response = await this.make("ai")
    .agent(SupportTriager)
    .as(await this.auth.user())
    .prompt("Ticket #4812");
  response.output.priority;
  ```

  - `appTools(names)` hands the model the application's own `.agent()` routes. Every call goes through the agent invocation pipeline as the principal given to `as()`: scopes, the route's policies, the approval queue, redaction, a rate budget, and an audit record under `surface: 'in-process'`. `appToolDefinitions()` is the same list before AI SDK packaging, for another agent runtime to wrap.
  - A name no route derives, a name `static scopes` does not grant, or a write tool under `as(null)` fails at `as()`, before any model call.
  - `aiPlugin({ audit, approvals })` takes `mcpPlugin`'s shapes. Without its own `audit`, calls record into the trail `mcpPlugin({ audit })` publishes; configuring both is refused at first use.
  - Route names outside `[A-Za-z0-9_-]{1,64}` are warned about: Anthropic and OpenAI reject them as tool names, so set `agent.toolName`.

  `fakeAi()`, `guren add ai` and `make:ai-agent` follow in Part 1b.

- b1977d5: `appTools(names)` is typed from `.guren/agents.gen.ts` (RFC 0029 §11): a name no route derives fails to compile, and each returned tool is `Tool<AgentToolInput<K>, AgentToolOutput<K> | AppToolDenial | AppToolError>`. Declaring the class as `Agent<typeof MyAgent.scopes>`, with `scopes` written `as const`, makes a name without a `tool:` grant a compile error too; a prefix grant is still settled when `as()` constructs the agent.

  ```ts
  export class SupportTriager extends Agent<typeof SupportTriager.scopes> {
    static override scopes = ["tool:tickets_show"] as const;
    override tools() {
      return this.appTools(["tickets_show", "tickets_update"]); // error: tickets_update is not granted
    }
  }
  ```

- 1e7943e: `app.fakeAi()` scripts in-process AI agents in tests (RFC 0029 §7). It replaces the app's `ai` binding for the `using` scope. Each agent's model answers from `respond()`, and its tools still run through `appTools()` and the invocation pipeline.

  ```ts
  using ai = app.fakeAi()
  ai.respond(SupportTriager, [
    { toolCalls: [{ name: 'tickets_show', input: { id: 4812 } }], then: { output: { priority: 2 } } },
  ])

  await app.post('/tickets/4812/triage').assertRedirect('/tickets/4812')

  ai.assertPrompted(SupportTriager, (input) => input.includes('#4812'))
  ai.assertNeverPrompted(ReviewAgent)
  ai.calls(SupportTriager)[0].toolCalls   // [{ name, input, output }]
  ```

  - A response is a string, `{ text }`, `{ output }`, or `{ toolCalls, then }`. Each prompt consumes one response.
  - A prompt with nothing scripted throws, naming the agent. Disposing the fake throws again, so the test still fails when a route turned that error into a 500. Disposing also fails when an agent's `stopWhen` ended the loop before it reached the scripted answer.
  - `assertNotPrompted(Agent, predicate)` fails on a matching prompt, and `assertNeverPrompted(Agent)` fails on any prompt.
  - Works on `TestApp.fromApp(app)`. `@guren/plugin-ai` and `ai` are optional peers of `@guren/testing`, loaded only for an app that binds `ai`.
  - `@guren/plugin-ai` exports `bindAgent`, which the fake uses to construct agents the way `AiManager.agent().as()` does.

### Patch Changes

- Updated dependencies [029a516]
- Updated dependencies [61c401c]
- Updated dependencies [a798a10]
- Updated dependencies [dcb81a7]
- Updated dependencies [909b4b6]
- Updated dependencies [3e11a0f]
- Updated dependencies [83143a7]
- Updated dependencies [0eabb37]
- Updated dependencies [1c9ccae]
- Updated dependencies [8d4275c]
- Updated dependencies [218db73]
- Updated dependencies [000a5e0]
- Updated dependencies [13b9205]
- Updated dependencies [d67480f]
  - @guren/core@1.19.0
