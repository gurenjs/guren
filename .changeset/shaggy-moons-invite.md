---
"@guren/cli": minor
---

Add `guren ai:eval <flow>`, which runs one eval against the real model
(RFC 0029 §10).

It resolves `tests/evals/<flow>.eval.ts` and the runner from the app's own
`@guren/plugin-ai`, so the `defineEval()` that wrote the definition and the
`runEval()` that reads it are one installed copy. `--variant`, `--reps`,
`--cases`, `--max-cost-usd`, `--concurrency`, `--dry-run`, `--file`, `--dir`
and `--json` shape the run. The command emits data and prints where it landed:
the `.claude/hillclimb/` layout is read by the claude-api harness's report
builder and `hillclimb`, and Guren vendors no viewer of its own.

Evals are opt-in. Nothing in `guren check` or `guren gate` runs one.

Refs: RFC 0029
