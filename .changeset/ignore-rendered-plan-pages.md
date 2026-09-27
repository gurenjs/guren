---
'create-guren-app': patch
---

A new app's `.gitignore` now leaves out the review pages `guren plan:render` writes (`docs/plans/**/*.html` and `*.plan.html`), so rendering a plan no longer leaves untracked files for you to ignore by hand.
