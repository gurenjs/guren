---
'@guren/plugin-ai': minor
---

New package: in-process AI agents on the Vercel AI SDK (RFC 0029 Part 1a).

```ts
// config/ai.ts
export default defineAiConfig((env) => ({
  default: 'anthropic',
  providers: { anthropic: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5') } },
}))

// app/Ai/Agents/SupportTriager.ts
export class SupportTriager extends Agent {
  static override agentName = 'support-triager'
  static override scopes = ['tool:tickets_show', 'tool:tickets_update'] as const
  instructions = 'You triage support tickets.'
  output = Output.object({ schema: Triage })
  override tools() {
    return this.appTools(['tickets_show', 'tickets_update'])
  }
}

// a controller
const response = await this.make('ai').agent(SupportTriager).as(await this.auth.user()).prompt('Ticket #4812')
response.output.priority
```

- `appTools(names)` hands the model the application's own `.agent()` routes. Every call goes through the agent invocation pipeline as the principal given to `as()`: scopes, the route's policies, the approval queue, redaction, a rate budget, and an audit record under `surface: 'in-process'`. `appToolDefinitions()` is the same list before AI SDK packaging, for another agent runtime to wrap.
- A name no route derives, a name `static scopes` does not grant, or a write tool under `as(null)` fails at `as()`, before any model call.
- `aiPlugin({ audit, approvals })` takes `mcpPlugin`'s shapes. Without its own `audit`, calls record into the trail `mcpPlugin({ audit })` publishes; configuring both is refused at first use.
- Route names outside `[A-Za-z0-9_-]{1,64}` are warned about: Anthropic and OpenAI reject them as tool names, so set `agent.toolName`.

`fakeAi()`, `guren add ai` and `make:ai-agent` follow in Part 1b.
