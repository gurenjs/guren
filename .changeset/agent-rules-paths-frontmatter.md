---
'@guren/cli': patch
---

The agent harness rules (`.claude/rules/*.md` and `.agents/rules/*.md`) now scope themselves with `paths:` frontmatter instead of `globs:`. Claude Code reads only `paths` from a rule and ignores any other key without an error, so every rule was loaded into every session rather than when the agent works on the files it covers. The rules also gained the matching `modules/*/…` patterns, so a module's controllers, models, routes, validators and tests get the same rules as the app root's. The rule files carry no other frontmatter key: the Cursor (`.cursor/rules/guren-*.mdc`, still scoped with `globs`) and Copilot (`.github/instructions/guren-*.instructions.md`, `applyTo`) renderings now take their `description` from each rule's heading. The rule files are framework-managed, so an existing app picks the change up with `bunx guren agent:sync`, which reports each rewritten rule as replaced.
