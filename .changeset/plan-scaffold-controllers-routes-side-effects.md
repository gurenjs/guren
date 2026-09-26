---
'@guren/cli': minor
---

`guren plan:scaffold` now writes the rest of a slice except its pages (RFC 0030 §5). Each added controller holds exactly the planned actions: each validates with the planned validators (`validateBody()` and its siblings, which compile before the route is mounted) and authorizes with the planned policy ability, then answers 501 until the `http` step writes its body and response. The routes to those actions go in `routes/<collection>.ts`, with their contract schemas, bindings, `auth` middleware and `.agent()` metadata, and are not mounted. Jobs, events, listeners, mails and notifications are written as the `make:*` commands write them, under the plan's class names. `@docs docs/entities/<Model>.md` is added where that document exists.

`guren plan:scaffold <plan> --step <http step> --mount`, which `plan:next` names for the `http` step holding those routes, calls the routes file first in the entry registrar. It refuses, writing nothing, a step holding no scaffolded routes, a missing routes file, and a file already mounted.

`guren check` reports an unmounted routes file as advisory while it was written by the scaffold of an approved, unclosed plan whose `http` step is not verified, so `guren gate` does not block the steps before the mount. The warning counts again once that step verifies or the plan closes. `make:controller`, `make:route`, `make:feature` and the side-effect generators write through the same templates, with unchanged output.
