---
'@guren/server': minor
'@guren/core': minor
---

Add the agent invocation pipeline and the principal seam (RFC 0017 Part 1)

The steps that make an agent tool call trustworthy — scope gate, approval gate,
dispatch, redaction, audit — now live in the framework instead of in the App MCP
plugin, so every surface that invokes a tool passes the same checks in the same
order. `app.fetch` on its own only executes the HTTP request; a caller that
dispatched through it directly would bypass scopes, approvals and the audit
trail while looking exactly like a gated call.

- **`createAgentInvocationPipeline(options)`** runs, in order: the scope gate, a
  single **interposition hook**, the approval gate, dispatch, redaction and
  audit. It is protocol-neutral — it knows nothing about MCP — and returns a
  discriminated result an adapter maps onto its own shapes. The hook's position
  is fixed rather than configurable: it sits between scope and approval, because
  the approval gate writes a record and notifies humans, so a meter behind it
  would guard the execution while the amplification happened in front of it.
- **Fail-closed approvals.** A tool declaring `approval: 'required'` with no
  approval queue configured is refused, nothing is dispatched, and the denial is
  audited. The refusal names the configuration line of the surface that was
  reached, through the new `configureHint` option.
- **`gateToolCall`, `gatePreflight`, `gateApproval`, `notifyApprovers`** and
  their types are now exported from `@guren/core` (they were internal to
  `@guren/plugin-mcp`).
- **The principal seam.** A pipeline call made with `handoff: 'seam'` installs
  its principal on the exact `Request` handed to the application, keyed on
  object identity — no header, nothing on the wire to forge, and a copied or
  rebuilt request carries nothing. The auth context consults it before any
  header-based guard, so `requireAuthenticated()`, `Controller.auth` and
  `Gate`/policies all answer for the caller. It is not a token:
  `createBearerTokenMiddleware` and `tokenCan*` judge an `ApiToken`, and there
  is none, so routes behind those still refuse.
- **CSRF.** A seam-marked request skips verification on the same terms as a
  cookie-less bearer request, and the middleware *asserts* that premise: a
  seam-marked request carrying any `Cookie` header is refused with 403 whatever
  its method, so the exemption cannot be widened by a bug elsewhere. Issuance of
  the `XSRF-TOKEN` cookie is unchanged.
- **`AgentSurface` gains `'durable'`**, for agents an application hosts itself.
  Nothing emits it yet; `parseAuditRecord` and `guren tool:log` accept it, so a
  trail written by a later release is readable by this one.
