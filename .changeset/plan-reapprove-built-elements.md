---
'@guren/cli': patch
---

`guren plan:approve` re-approves an edited plan whose own elements are already built. On a plan that carries a baseline, a collision or an absence no longer refuses on an element that was stamped at the state the plan starts it from and that the application now reads exactly as the plan leaves it (an added name that exists, a renamed or dropped name that is gone); the report lists those elements as `builtByPlan`, and `plan:render` shows the same findings as passes. A collision the plan did not build still refuses: its table declared by another app root, a revision turning an existing element into an add of that name, or an add retargeted onto a name the application already had. `plan:status` reports the difference as `basis` on a fresh verdict. A draft is judged as before.
