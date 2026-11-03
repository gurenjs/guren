---
'@guren/cli': patch
---

Three generator defaults no longer let through what the plan or the scaffold did not ask for.

- `plan:scaffold` writes `.min(1)` on a required `string` or `text` validator field that plans no `min` and no format, so an empty value (the `""` an empty form field sends) gets a 422 instead of being saved into a required column. The bound refuses the empty string only: a value of spaces or line breaks still passes, so a field that must hold visible text needs that rule stated in the plan, and a planned `min 0` keeps the empty string. Query and params validators get the same bound, since a GET form sends an empty field as `""` too. `plan:status` still reads every scaffolded field as matching its plan.
- `plan:scaffold` writes a model the plan gives `fillable: []` as `defineModel(table, { fillable: [] })`. It used to drop the empty list, which left the model with no allowlist at all: `create(data)` accepted every key, and `create(data, { set })` refused every `set` with `no-fillable`. The model now refuses every key in `data` and takes the server's columns through `set`, as the plan states, and the controller stub's comment names every column that has to go through `set` rather than only the foreign keys. `make:model`, which is given no `fillable`, writes `defineModel(table)` as before.
- `make:policy` (and `make:feature --policy`) writes `viewAny` and `view` as `return user !== null` instead of `return true`, so a guest no longer passes a `view` check on every record. The comments above them say how to open each to guests or narrow `view` to the owner. The controller `make:feature` writes asks only `create`, `update` and `delete`, so `--public` behaves as before. An existing policy file is not rewritten.
