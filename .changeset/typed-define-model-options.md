---
'@guren/orm': minor
'@guren/cli': minor
---

Add typed allowlist options to `defineModel`: `fillable`, `hidden`, `visible`, `accessors`, and `appends` can now be passed as options, checked at compile time against the table's columns (and, for `fillable`, fields contributed by the `base` such as `AuthenticatableModel`'s virtual `password`). Accessor functions receive the table's inferred record, and `appends` may only name declared accessors. `static` declarations keep working and shadow the options. `guren audit` and `guren check` recognize the option form with the same shadowing order.
