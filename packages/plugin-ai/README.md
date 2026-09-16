# @guren/plugin-ai

In-process AI agents for Guren applications (RFC 0029), on the [Vercel AI SDK](https://ai-sdk.dev). An `Agent` calls a model configured in `config/ai.ts` and reaches the application only through `appTools()`, which runs every tool call through the same invocation pipeline as the App MCP endpoint: scopes, the route's policies, approvals, redaction and the audit trail.

```bash
bun add @guren/plugin-ai @ai-sdk/anthropic
```

```ts
// config/ai.ts
import { defineAiConfig } from '@guren/plugin-ai'
import { createAnthropic } from '@ai-sdk/anthropic'

export default defineAiConfig((env) => ({
  default: 'anthropic',
  providers: {
    anthropic: { model: () => createAnthropic({ apiKey: env.ANTHROPIC_API_KEY })('claude-opus-5') },
  },
}))
```

```ts
// src/app.ts
createApp({ config: [ai], providers: [aiPlugin()] })
```

```ts
// app/Ai/Agents/SupportTriager.ts
import { Agent, Output } from '@guren/plugin-ai'

export class SupportTriager extends Agent {
  static override agentName = 'support-triager'
  static override scopes = ['tool:tickets_show', 'tool:tickets_update'] as const
  instructions = 'You triage support tickets. Read before you write.'
  output = Output.object({ schema: Triage })

  override tools() {
    return this.appTools(['tickets_show', 'tickets_update'])
  }
}

const response = await this.make('ai').agent(SupportTriager).as(await this.auth.user()).prompt('Ticket #4812: ...')
```

A tool defined with `tool()` inside `tools()` runs with whatever authority its closure has, and nothing gates or audits it. Anything a route already does belongs in `appTools()`.

Tool names reach the model provider verbatim. Anthropic and OpenAI accept only `[A-Za-z0-9_-]{1,64}`, so a route named `tickets.show` needs `.agent({ toolName: 'tickets_show' })`.

Requires Node 22 or later (the AI SDK's floor), or Bun.
