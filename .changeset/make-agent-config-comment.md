---
"@guren/cli": patch
---

Trim the comment `make:agent` writes into `config/agents.ts` to the length the shipped `guren/comment-length` lint rule allows. A scaffolded app installs those rules, so `guren make:agent` followed by `bun run lint` failed on the scaffolder's own output.
