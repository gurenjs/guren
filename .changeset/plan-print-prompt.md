---
'@guren/cli': minor
---

Add `guren plan "<request>" --print-prompt`, which prints the prompt and the plan JSON Schema an agent writes an implementation plan from (RFC 0030 §8), for an agent already in a session. The prompt names the read-only commands to read the application with, the plan's conventions (questions as data, no `baseline`, ids by section, every `alter` stated in properties `plan:status` reads, `AC-` behaviours, generator-only `commands`), and has the agent check its file with `plan:render --json` until no check fails. It calls no model and spawns nothing; `--json` prints `{ prompt, schema }`. Without `--print-prompt` the command exits 1, since asking a model directly is not available yet, `--revise` exits 1 naming `plan:revise`, and an unquoted request that holds a flag is refused with a hint to quote it.

`guren plan:render --json` prints `{ path, checks }` instead of the path alone, so an agent can read the failing checks without opening the page.
