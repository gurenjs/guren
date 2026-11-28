---
'@guren/server': minor
'@guren/core': minor
---

`.agent({ confirm: true })` asks the calling user before an agent's call runs (RFC 0042 §2). `confirm` also takes `{ message }` for the question's text.

The invocation pipeline gains a confirmation step between the interposition hook and the approval gate. A call to a `confirm` tool is first rehearsed (the route's middleware and validation, never its action). A call the route refuses is answered with that refusal. A call it accepts is denied with the new reason `confirmation`, and the denial carries `confirmation: { tool, message, input, fingerprint }`. A surface that can ask repeats the call with `confirmed: fingerprint`; every surface that cannot keeps refusing, which today is all of them: in-process agents, durable agents, MCP Apps views and the MCP endpoint. A rehearsal the caller asks for (`preflight: true`) is not held.

A `confirm` tool resolves `expose.webMcp` to `false` whatever the route declares, since the browser calls a WebMCP tool's route without passing through the pipeline.

`AgentToolDenialReason` gains `'confirmation'`. Code that switches over it exhaustively stops compiling until it names the new member.
