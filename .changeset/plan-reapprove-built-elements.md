---
'@guren/cli': patch
---

`guren plan:approve` re-approves an edited plan whose own elements are already built. On a plan that carries a baseline, a collision or an absence on an element the application reads exactly as the plan leaves it (an added name that exists, a renamed or dropped name that is gone) no longer refuses; the report lists those elements as `builtByPlan`, and `plan:render` shows the same findings as passes. A collision the plan's end state does not explain, such as its table declared by another app root, still refuses, and a draft is judged as before.
