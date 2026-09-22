---
'@guren/cli': patch
---

`guren plan:status` no longer calls a route `wired` while a route registered before it, with the same method or `ALL`, answers every request its path matches (a planned `GET /comments/new` after `GET /comments/:id`). The route, and an action or validator only it reaches, stays `present` with a note naming the earlier route and the registrar that declared it, so `plan:verify` cannot verify it. A comparison the path matcher cannot make (a constraint or a `*`), two modules' routes, and a module's route while another module failed to load are reported unconfirmed rather than passed.

`guren plan:close` now prints, under each element it refuses, the command that moves it: `plan:verify <plan> --step <id>` for the step that verifies it, fixing the code first where it is below its completion state, or `plan:waive <plan> <id> --reason` where no `plan:verify` run can lift it (no step verifies it, nothing of it can be fingerprinted, or no step's behaviour reaches an element none of whose planned properties matched).
