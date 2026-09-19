---
"@guren/cli": minor
---

Add `guren plan:render <plan.json> [-o <file>]` (RFC 0030 §3): an implementation
plan rendered as one self-contained HTML file, written beside the plan. The page
opens from disk and makes no request of any kind — no CDN, no fonts, no Mermaid,
and a `default-src 'none'` content security policy that allows only its own
inline style and script. It shows the questions the plan could not decide as a
form with the assumed answer preselected, a tab per section with a per-entity
filter and a "changes only" toggle, an ER diagram drawn from the plan's own
models and foreign keys, acceptance behaviours as Given / When / Then, failed
checks and breaking changes pinned to the top, and an approve / request-changes
toggle per element whose "Export feedback" button downloads `feedback.json`.

Every string in a plan is model output, so the page treats all of it as hostile:
the data travels as a JSON block with `<`, `>`, `&`, U+2028 and U+2029 escaped as
`\uXXXX`, and the template writes it with `textContent` only. No plan string ever
becomes an `href`, and in-page anchors are built from ids the schema validated.

The command has no producer yet, so it is undocumented until one exists.
