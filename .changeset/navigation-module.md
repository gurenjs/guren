---
"@guren/server": minor
---

Add `defineNavigation()`, a config definition that declares the layout's links on the server. Each entry names a `GET` route with no path parameter and may be shown by sign-in (`auth`), by fields of the user (`where`) or by a gate check on the model class (`can`). The server shares `navigation` as a lazy Inertia prop holding only the label, path and current flag of each entry the user may see. An entry whose route is missing, is not a `GET` or has a parameter is hidden with a warning at boot.
