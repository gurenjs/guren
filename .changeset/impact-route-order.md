---
"@guren/cli": patch
---

`guren plan:render`'s Impact hangs a test request off the route that answers it, not off every route whose path matches: with `GET /meetups/create` registered before `GET /meetups/:id`, a `get('/meetups/create')` is no longer listed as reaching `meetups.show`. The order is the one `plan:status` reads a shadowed route by (the entry registrar's routes, then each module's); where two modules' order or an earlier route's pattern leaves it open, the request is listed under a note of its own as one that may reach the route.
