---
'@guren/cli': minor
'create-guren-app': patch
---

Restyle the `make:auth` and `make:feature` scaffold output with the Guren UI design tokens: pages render in the guren.dev light/dark themes via `bg-g-*` / `text-g-*` utilities, flash and error messages become diagnostic rows, and the destructive delete action is an outline + confirm instead of red text. Both commands now ensure the app carries `resources/css/guren.css` and its `app.css` import (idempotent — apps scaffolded by create-guren-app ship them already). The blog blueprint's dashboard page moves in lockstep.
