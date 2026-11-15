---
'@guren/cli': minor
---

`change:lane` and `change:evidence` now judge `dependency-advisory` (RFC 0040). When a change touches dependencies, `bun audit` runs on both sides of the `bun.lock` that governs each changed file, exported from git objects with nothing installed and with the base's `.npmrc` and `bunfig.toml`, so the change cannot choose the registry it is judged against. Each advisory the head has and the base does not is a `high` fact. Both sides are read against today's advisories, so an advisory published since the base on an unchanged dependency is not counted against the change. A manifest whose `bun.lock` did not change, a binary `bun.lockb`, a base with dependencies but no `bun.lock`, and a scan that does not complete are listed under "Not judged", and `--no-deps` skips the scan. Any `.npmrc` is now a gate input (`high`), since it names the registry an install asks.
