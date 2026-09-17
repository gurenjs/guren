---
'@guren/plugin-ai': minor
---

`broadcast(input, channel, options)` (RFC 0029 §4) queues the run like `queue()`, and the worker publishes each UI-message chunk to `channel` as the `AgentChunk` broadcast event:

```ts
await SupportTriager.as(user).broadcast('Ticket #4812: ...', `private-support.${user.id}`, { conversation: true })
```

- `AGENT_CHUNK_EVENT` is exported from `@guren/plugin-ai` and `@guren/plugin-ai/client`.
- Publishing is not authorized: register the channel as a private channel with an authorizer, or anyone subscribed reads the transcript.
- A run that fails before finishing publishes one `error` chunk, so subscribers are not left waiting. An `error` chunk fails the job.
- A broadcast run emits no `AgentResponded`; the `finish` chunk ends it. An agent with an `output` schema is refused.
