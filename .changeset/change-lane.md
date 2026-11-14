---
'@guren/cli': minor
---

Add `guren change:lane --base <sha> --head <sha>`, the first part of RFC 0040's report. It reads the change between two commits from git objects and prints its facts and the review lane they set as a floor: `high` for a changed gate input, plan record, destructive or edited migration, acceptance test, removed test, removed policy ability or new `guren-audit-ignore`; `medium` for schema, migration, policy, dependency and source changes; `low` for documentation, translation catalogs, generated files and added tests. What this version does not read yet (per-route security records, the audit against the base, dependency advisories) is listed as not judged and keeps the floor at `medium` or above. The command writes nothing and exits 0 whatever the lane; `--json` prints the versioned report.
