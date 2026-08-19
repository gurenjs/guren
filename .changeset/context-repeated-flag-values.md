---
'@guren/cli': patch
---

Fix `guren context` misreading a flag that is passed twice

citty hands an argument back as an array once its flag is repeated, and
`guren context` read all five of its own straight through.
`--entity User --entity User` exited 1 on `entityName.toLowerCase is not a
function`, and `--app . --app .` exited 1 inside `resolve()`. The other three
never said anything untrue out loud: `--module app --module app` exited 1
blaming a module named `app,app`; `--routes web.ts --routes web.ts` exited 0
reporting the entity's routes as none, because the same `resolve()` failure
lands in the `catch` that exists for a routes file the CLI genuinely cannot
load; and `--json=true --json=false` printed JSON, because every array is
truthy. Each of the five now resolves to the value passed last.
