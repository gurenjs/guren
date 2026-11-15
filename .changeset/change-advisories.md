---
'@guren/cli': minor
---

`change:lane` and `change:evidence` now judge `dependency-advisory` (RFC 0040). When a change touches dependencies, `bun audit` runs on the `bun.lock` and manifests of both sides, exported from git objects with nothing installed, and each advisory the head has and the base does not is a `high` fact. Both sides are read against today's advisories, so an advisory published since the base on an unchanged dependency is not counted against the change. A side that cannot be scanned (no `bun.lock`, no registry access) is listed under "Not judged", and `--no-deps` skips the scan.
