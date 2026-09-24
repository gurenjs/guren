---
'@guren/cli': minor
---

`guren check` findings that regenerating files clears now carry a `fix` field in `--json` output: `{ "kind": "command", "args": [...] }`, the arguments after `guren`. A missing `.guren/*.gen.ts` manifest names `codegen` (with `--routes` for any routes entry other than `routes/web.ts`, so an API-only app's `routes/api.ts` is named) and a drifted `docs/spec/` view names `spec:generate`. The new `guren check --fix` runs each distinct fix once, checks again, and reports that second run with the commands it ran under `fixes`; it exits non-zero when one of them fails or leaves its findings reported, and it is refused together with `--ci`. Findings that need a code change keep only their `suggestion` text.
