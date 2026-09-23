---
"@guren/cli": patch
---

`guren plan:status` now judges a planned validator's and resource's fields instead of reporting them as having no reader. A validator's fields are read from the exported schema (existence, type, whether a client must send it, and `min`/`max`/`email`/`url`/`uuid` rules), and a resource's fields from the payload type `guren codegen` reads. A field the plan lists and the code does not declare is a `differ`; a union, a refinement or a type written as an alias stays `unknown`. `plan:status` now imports every validator file, not only when a route carries a contract schema.
