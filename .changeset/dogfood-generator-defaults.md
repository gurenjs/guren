---
'@guren/cli': patch
---

Three generator defaults no longer let through what the plan or the scaffold did not ask for.

- `plan:scaffold` writes `.min(1)` on a required `string` or `text` validator field that plans no `min` and no format, so a blank form field (sent as `""`) gets a 422 instead of saving an empty value into a required column. Query and params validators get the same bound, since a GET form sends a blank field as `""` too. A planned `min 0` is written as it is and keeps the empty string, and `plan:status` still reads every scaffolded field as matching its plan.
- `plan:scaffold` writes a model the plan gives `fillable: []` as `defineModel(table, { fillable: [] })`. It used to drop the empty list, which left the model with no allowlist at all: `create(data)` accepted every key, and `create(data, { set })` refused every `set` with `no-fillable`. The model now refuses every key in `data` and takes the server's columns through `set`, as the plan states. `make:model`, which is given no `fillable`, writes `defineModel(table)` as before.
- `make:policy` (and `make:feature --policy`) writes `viewAny` and `view` as `return user !== null` instead of `return true`, so a guest no longer passes a `view` check on every record. A comment above each says how to open it to guests or narrow `view` to the owner. The controller `make:feature` writes asks only `create`, `update` and `delete`, so `--public` behaves as before. An existing policy file is not rewritten.
