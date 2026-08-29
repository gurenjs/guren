---
"@guren/core": minor
---

Add the `@guren/core/internal/zod-json-schema` entry point: the one Zod 4 → JSON
Schema 2020-12 walker, promoted out of `@guren/openapi` so every surface that
describes an application's contracts to something outside the process derives
the same schema. It now carries Zod's checks into JSON Schema constraints —
string `minLength`/`maxLength`/`pattern`/`format` (`email`, `uri`, `uuid`,
`date-time`, `date`, `duration`, `hostname`, `ipv4`, `ipv6`), number
`minimum`/`maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`, and
array `minItems`/`maxItems` — where before it dropped them. An integer-formatted
number (`z.int()`, `z.int32()`, `z.uint32()`) now renders as `type: "integer"`
rather than `type: "number"`, and a surplus `pattern` or `multipleOf` that one
keyword cannot hold is conjoined under `allOf` rather than dropped.

`internal/zod-compat` gains `schemaChecks()` and `schemaFormat()`, the two reads
that made this possible: zod stores refinements in a heterogeneous `_def.checks`
array, and records a format either on the node (`z.email()`) or as a check
(`z.string().email()`).

Internal by `contributing/api-stability.md` — no stability guarantee.
