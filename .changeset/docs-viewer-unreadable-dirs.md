---
'@guren/cli': patch
---

Show the docs viewer what it could not read. A directory under `docs/` that would not list (a `docs/plans` the user cannot read, say) made the docs scan throw, so `/_guren/docs/data.json` answered 500 and the page stayed empty or stale without a word, while `guren_get_plans` named the directory. The viewer now catches that one failure: the payload carries `docsScanFailure` (no document is drawn) and `unreadablePlanDirs`, the plan directories `guren_get_plans` reports, and the page lists both above the open plans, which it still shows. `guren check --docs` still reports it as a failed `discovery:read`. `guren_get_plans` and `guren check --plan` now name an unreadable directory the same way the viewer does: app-relative with `.` for the app root, and with the app root removed from the error's paths, which `guren_get_plans` used to print in full.
