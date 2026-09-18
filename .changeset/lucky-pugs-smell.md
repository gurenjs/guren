---
"@guren/plugin-ai": minor
---

Add `@guren/plugin-ai/eval`: `defineEval()` and the eval runner (RFC 0029 §10).

An eval calls the real model over a case set with a grader, which is the one
thing a fake cannot measure. Each case runs in its own disposable app, so the
agent's `appTools()` dispatch through the invocation pipeline and the grader
reads the end state its tools wrote rather than the transcript. The runner
records model and usage from the response, derives cost from the provider's
`pricing` (absent, a row carries no cost rather than a zero), keeps a
truncated answer out of every metric mean and counts it beside them, and sends
an attempt that produced nothing scorable to a sidecar with its failure class
and retry count. `hillclimbReporter()` writes the `.claude/hillclimb/` layout
the claude-api harness's report builders read; `defineEval({ reporter })`
swaps it.

Evals are opt-in and never part of `guren check` or `guren gate`.

Refs: RFC 0029
