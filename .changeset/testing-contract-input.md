---
'@guren/testing': minor
---

`contractInput({ route, params, query, body })` seeds what `Controller.validated()` reads, for a controller unit test built with `createControllerContext()`. The controller module mock implements `validated()` over the same seeded record.
