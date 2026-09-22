---
'@guren/cli': minor
---

`guren check --plan` (RFC 0030 §8) reports approved, unclosed implementation plans whose elements `plan:status` calls drifted, and two such plans that change the same model, table, column, controller, action, route or page. Plans are found as the app root's `*.plan.json` and `plan.json` / `*.plan.json` under `docs/plans/`; a plan or approvals file that will not read is reported. It also runs in plain `guren check`. Every result is advisory, so `check --ci` and `guren gate` never fail on it, and an app with no plan file gets no new output.
