---
'@guren/server': minor
'@guren/core': minor
---

Share the approval-status rule and the audit recorder across agent surfaces

`toApprovalStatusReport`, `approvalStatusNotFoundMessage` and the
`ApprovalStatusReport` / `ApprovalStatusOutcome` types move out of
`@guren/plugin-mcp` and into the framework, so every surface that answers "what
became of this approval request" answers it the same way — including the part
that is a *refusal* to distinguish: an unknown request id and another
principal's request id produce one message, byte for byte, because any
difference between them turns the check into a way to enumerate other
principals' pending actions. The found/not-found distinction stays in the audit
trail, where the operator can see it.

`ApprovalStatusReport` also gains **`consumedAt`**, present once an approval has
been spent (MCP advertises it as an additive output property). "Approved" alone
does not say whether the one call it permitted has already run, and a caller that
repeats a spent approval finds no unconsumed match, files a fresh request, pages
a human again, and performs the action a second time. The field is what lets a
caller tell "approved, go ahead" from "approved, and already used".

`createAgentAuditRecorder(options)` is extracted from the invocation pipeline
and exported alongside it. A surface that reaches the approval store without
dispatching a tool still has to write a record under the same principal, the
same `surface`, and the same argument masking; a second copy of that is how one
surface comes to record a field the other redacts.

No behavior changes for existing callers. `@guren/plugin-mcp` imports the moved
helpers and keeps its own MCP schema and tool description.
