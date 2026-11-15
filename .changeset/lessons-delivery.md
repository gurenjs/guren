---
'@guren/cli': minor
---

`guren change:policy` now delivers cross-cutting lessons (RFC 0040 §11): a stable lesson that names `paths` and no entity is listed in the generated block of `REVIEW.md`, and written into a `lessons` rule for each installed agent (`.claude/rules/lessons.md`, `.agents/rules/lessons.md`, `.cursor/rules/lessons.mdc`, `.github/instructions/lessons.instructions.md`), scoped to the lessons' globs. The rule is removed once no such lesson stands, `--check` judges it with the block, and a file of that name `change:policy` did not write is refused.
