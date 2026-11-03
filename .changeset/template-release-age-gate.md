---
'create-guren-app': minor
---

Scaffolded apps ship a `bunfig.toml` that sets Bun's `minimumReleaseAge` to three days, so `bun install` and `bun add` hold back package versions published more recently than that, for transitive dependencies too. The `@guren` packages the scaffold installs are listed in `minimumReleaseAgeExcludes` by name (Bun does not read a scope pattern there), because each scaffold asks for the release it shipped with. To take a security fix younger than three days, add its exact `name@version` to that list. The operations guide describes the gate.
