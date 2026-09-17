---
'@guren/plugin-ai': minor
---

Agents queue (RFC 0029 §6). `queue(input, options)` runs `prompt()` on a worker, which emits `AgentResponded` when the model answers:

```ts
providers: [aiPlugin({ agents: [SupportTriager] })]

const { conversationId } = await SupportTriager.as(user).queue('Ticket #4812: ...', { conversation: true })

events.on(AgentResponded, ({ agentName, principal, conversationId, response }) => { ... })
```

- A queued agent must be registered with `aiPlugin({ agents })`. The worker resolves the class from its `agentName`, and `queue()` refuses an unregistered class before dispatching. Two classes under one name are refused at boot.
- `conversation: true` returns the new conversation's id immediately, and the worker creates it under that id.
- `RunAgentJob` runs once (`maxAttempts: 1`): a retry would re-run every tool the first attempt ran.
- `AgentResponded.response` carries `text`, `output`, `usage` and `finishReason`, not `steps`.
- The principal is recorded when the run is queued, abilities included.
