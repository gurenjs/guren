---
'@guren/cli': minor
---

`guren check --plan` (RFC 0030 §8) reports approved, unclosed implementation plans whose elements `plan:status` calls drifted, two such plans that change the same model, table, column, controller, action, route, endpoint or page, two plans sharing a slug, and a draft with approvals beside it (a plan that lost its baseline). Plans are found as the app root's `*.plan.json` and `plan.json` / `*.plan.json` under `docs/plans/`; a plan, approvals file or directory that will not read is reported. It runs only under `--plan`, since judging a plan imports the app's `db/schema.ts` and every validator file; plain `guren check`, `check --ci` and `guren gate` are unchanged. Every result is advisory, so `check --plan` exits 0.
