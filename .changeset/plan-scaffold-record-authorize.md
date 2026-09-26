---
"@guren/cli": patch
---

`plan:scaffold` controller stubs ask a policy ability of the record the route binds: when every route to the action binds one record of the policy's model, the stub writes `const comment = this.model(Comment)` and `this.authorize('delete', [Comment, comment])`, the form the gate resolves a policy from. Otherwise it keeps the bare class, and for a record ability (`view`, `update`, `delete` and the like) the comment above the action names the tuple to pass once the action loads the record. An action a `POST` route sends a body to also lists, in its comment, the model's foreign keys outside `fillable`, which `create()` refuses in its data and which go through `Model.create(data, { set: { … } })` (RFC 0031).
