---
"@guren/cli": patch
---

`make:view` no longer writes a page that redeclares an import when the page is named `Head` or `FC`: the colliding import takes an alias (`Head as InertiaHead`, `FC as ReactFC`).
