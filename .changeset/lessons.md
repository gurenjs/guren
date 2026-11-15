---
'@guren/cli': minor
---

Add `guren make:lesson` and the `lesson` document type (RFC 0040 §11). A lesson is a numbered file under `docs/lessons/` with one `rule:` line; it starts as a draft, and once a person merges it as `stable`, `guren context <Entity>` prints its rule under Lessons for each entity it names. `--from <commit|pr>` records where it came from, `--paths` the globs a lesson without an entity governs. `guren check --docs` fails a missing or over-long rule and an `enforcedBy: <file>#<name>` the file does not hold, and warns when the `review:` date has passed or a deprecated lesson names no `supersededBy`.
