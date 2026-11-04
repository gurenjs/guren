---
'@guren/cli': minor
---

`guren audit` proposes a fix for each dependency advisory and checks it (RFC 0039 §5). A package the app declares is updated to its lowest release outside the affected ranges; a package another dependency brings in is fixed by updating that dependency to the lowest release whose tree leaves the ranges, or by an override when none does. The audit applies the steps to a temporary copy of `package.json`, `bun.lock` and `bunfig.toml` and runs `bun install --lockfile-only` there: the fix is `verified` only when no version in range is left. A fixed version younger than the release-age gate becomes an exact `minimumReleaseAgeExcludes` step with its publish date. A fix it could not check stays `candidate` with the reason. `--no-fix` skips the search. Each `guren deps:exposure` entry now also carries `version`, `direct` and `paths`.
