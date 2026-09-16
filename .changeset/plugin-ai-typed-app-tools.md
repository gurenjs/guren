---
'@guren/plugin-ai': minor
---

`appTools(names)` is typed from `.guren/agents.gen.ts` (RFC 0029 §11): a name no route derives fails to compile, and each returned tool is `Tool<AgentToolInput<K>, AgentToolOutput<K> | AppToolDenial | AppToolError>`. Declaring the class as `Agent<typeof MyAgent.scopes>`, with `scopes` written `as const`, makes a name without a `tool:` grant a compile error too; a prefix grant is still settled when `as()` constructs the agent.

```ts
export class SupportTriager extends Agent<typeof SupportTriager.scopes> {
  static override scopes = ['tool:tickets_show'] as const
  override tools() {
    return this.appTools(['tickets_show', 'tickets_update']) // error: tickets_update is not granted
  }
}
```
