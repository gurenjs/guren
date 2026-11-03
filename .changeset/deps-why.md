---
'@guren/cli': minor
---

`guren deps:why <name>` reads the app's `bun.lock` and prints every installed version of a package, the path each direct dependency brings it in by, and whether `bun install --production` installs it. An app inside a monorepo is read as its workspace in the nearest `bun.lock` above it. `--json` prints the matching entries with the lockfile's coverage; the command exits 1 when the app does not have the package, or when the lockfile is binary, missing, or cannot be read in full. This is the dependency tree RFC 0039 §3 describes, which later milestones join to routes and advisories.
