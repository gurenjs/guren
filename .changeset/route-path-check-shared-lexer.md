---
"@guren/cli": patch
---

The `:name*` route path check reads paths through the shared path-param pattern.

The rule was written when no shared lexer existed, so it carried its own segment reading: split on `/`, take everything up to a `{`, strip a trailing `?`. `PATH_PARAM_PATTERN` now answers the same question — it anchors params at a segment boundary, consumes an attached constraint whole including one level of nesting, and keeps a trailing `*` as part of the label, which is the finding itself. Detection and the suggested rewrite are both driven by it, so the check and the code generators can no longer come to disagree about what a path binds.

No behaviour change for any path a scaffolder or guide produces; the shared pattern is stricter than the old reading only for a label with punctuation in it (`:name.:ext*`).
