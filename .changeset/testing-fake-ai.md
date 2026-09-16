---
'@guren/testing': minor
'@guren/plugin-ai': minor
---

`app.fakeAi()` scripts in-process AI agents in tests (RFC 0029 §7). It replaces the app's `ai` binding for the `using` scope. Each agent's model answers from `respond()`, and its tools still run through `appTools()` and the invocation pipeline.

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
