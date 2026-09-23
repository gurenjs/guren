---
"@guren/cli": patch
---

`guren plan:status` now judges a planned validator's and resource's fields instead of reporting them as having no reader. A validator's fields are read from the exported schema (whether it declares the key, the validated value's type, whether a client must send it, and `min`/`max`/`email`/`url`/`uuid` rules), and a resource's fields from the payload type `guren codegen` reads. A field is a `differ` only where both readings cannot hold (a key the code does not declare, a type of another JSON family, a bound tighter than planned); a transform, a union, a refinement or a type written as an alias stays `unknown`. Every command that reads the plan's status (`plan:status`, `plan:verify`, `plan:next`, `plan:close`, `guren check --plan`, the Stop hook) now imports every validator file, not only when a route carries a contract schema.
