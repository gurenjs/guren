---
'@guren/cli': patch
---

`guren codegen --introspect`, `guren context` and the route contract check in `guren check` now pair a route two unprefixed modules both register within its own module. Before, a module order that differed between `createApp({ modules })` and the `modules/` directory handed one module's route the other's Zod: codegen and context rendered the wrong schema types, and the route contract check judged a params schema against the wrong route.
