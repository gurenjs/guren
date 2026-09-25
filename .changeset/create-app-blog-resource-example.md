---
'create-guren-app': patch
---

`--blueprint blog` now suggests `bunx guren add resource tags --fields "name:string"` under "Add features:" instead of `add resource posts`. The blog template already ships Post, so `add resource posts` stopped at the existing `PostValidator.ts` and wrote nothing, and the `--force` it suggested would have replaced the template's own Post files with generic ones. The default and worker blueprints still suggest `add resource posts`.
