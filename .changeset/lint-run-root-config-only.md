---
'@guren/cli': patch
---

`guren gate`'s lint stage, the edit hook and the Stop hook run oxlint with `--disable-nested-config`, so only the app's own `.oxlintrc.json` applies. A `.oxlintrc.json` in a directory inside the app (a vendored checkout, a cloned example) is no longer read, and the JS plugins it names are no longer loaded into the lint run. An app that kept a nested config on purpose should move its rules into the root config, under `overrides` for the paths they cover.
