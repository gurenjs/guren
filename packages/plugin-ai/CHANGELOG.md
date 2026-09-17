# @guren/plugin-ai

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
