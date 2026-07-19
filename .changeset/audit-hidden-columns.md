---
'@guren/cli': minor
---

`guren audit` now warns when a model's schema table has sensitive-looking columns (password, secret, token, salt, hash) that are not excluded from serialization via `static hidden` or a `static visible` allowlist. Records passed to `serialize()`/`toJSON()` or Inertia props would otherwise expose those values. Models whose sensitive columns are all covered get a pass finding; models without sensitive columns produce no output.
