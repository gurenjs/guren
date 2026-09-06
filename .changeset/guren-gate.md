---
'@guren/cli': minor
---

`guren gate`: one exit-coded verdict on a change

`bunx guren gate` runs the stages the scaffolded CI runs — codegen, `check`
(the `--ci` rule), lint, typecheck, `audit`, and the test suite — reports every
stage, and exits non-zero if any fails. A stage that cannot run (no oxlint
behind an `.oxlintrc.json`, no `typecheck` script, routes that will not load)
fails rather than skips; only an app with no `.oxlintrc.json` skips lint.
`--changed` narrows `check` and lint to the files changed against `main`,
`--deps` adds the dependency scan to the audit stage, and `--json` returns the
report. `runGate` and `describeGateFailures` are exported for hooks and tools.

The Claude Code harness gains a `Stop` hook (`.claude/hooks/gate-on-stop.ts`)
that runs the gate when a turn ends with uncommitted changes and blocks the stop
once with the findings, so the fix happens in the same turn rather than in CI.
`.claude/settings.json` is user-owned, so existing apps add the hook entry by
hand (or rerun `agent:init --force`); `agent:sync` delivers the hook file. The
`AGENTS.md` workflow for other agents now ends with the same command.

The edit hook's `guren check` step now applies the `check --ci` rule (warns
count, advisory checks do not) instead of reporting failures only, so the three
places that judge a change — the edit hook, the gate, and CI — agree.
