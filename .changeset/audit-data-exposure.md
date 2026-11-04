---
'@guren/cli': minor
---

`guren audit` follows what each action sends in a response (RFC 0039 §7): the props of `this.inertia()`, the value of `this.json()`, and what a Resource's `toArray()` returns. A sensitive column reaching one, whether the model lists it in `hidden` or its name has `password`, `token`, `secret`, `hash`, `apiKey` or `otp` as a segment, is an `exposure-sensitive-column:<Model>.<column>:<file>:<where>` warning naming the action, its routes and whether their chains authorize. A whole record carries every column, `Model.serialize()` what `visible` and `hidden` leave, and `auth.user()` what the model provider leaves when introspection reports one. A value the audit cannot follow is listed as not read under `dataExposure`, never treated as safe. `// guren-audit-ignore` on the sending line accepts one.
