---
'@guren/server': minor
'@guren/core': minor
---

Add `classifyRegistrationScope`, the narrower scope rule for unattended principals

Agent tool scopes have always had four forms: `tool:<name>`, `tools:read`,
`tools:*`, and `tools:<prefix>.*`. An API token may hold any of them — someone
issued it and is watching it.

A *registration* is different: it grants an agent that runs unattended, and it
is written once and then outlived by the route graph. `classifyRegistrationScope`
is the rule for that narrower case — `tool:<name>` and `tools:read` only, with
set grants refused by name and with the reason, because an unattended principal
must not acquire consent to tools that did not exist when a human read the
config.

One exported rule rather than two implementations: `guren check` and the agent
runtime both read it, so a check that passes cannot describe a runtime that
refuses.

Also adds `createAgentApprovalContext`, which builds the invocation pipeline's
approval context — the TTL default, the route's redaction rules, and the
fire-and-forget notification wrapping — from a surface's own `approvals` option
and the caller it is answering for. Those three are invariants of an approval
record rather than of a protocol, so every surface that offers a queue now
shares one of them instead of restating it.

Adds `Application.booted()`, which resolves when the boot that is running — or
has already run — completes. A service provider's `boot` hook runs during the
application's own boot, so anything it publishes is published while later
providers are still unbooted; awaiting this first is what turns "published" into
"usable".
