---
'@guren/cli': patch
---

`guren check` no longer counts a commented-out call as wiring. A routes registrar whose only call in `routes/web.ts` is `// registerAdminRoutes(router)` (or sits in a string) is reported as unmounted, and a console command whose only mention in `registerMany([...])` is a comment as unregistered.
