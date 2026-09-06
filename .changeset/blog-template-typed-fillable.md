---
'create-guren-app': patch
---

Declare the blog template's Post allowlist as the typed `defineModel` option

`app/Models/Post.ts` scaffolded a `static fillable = [...]`, the untyped form.
The `defineModel(posts, { fillable: [...] })` option is the documented,
preferred one because TypeScript checks every name against the table's columns,
and the template's own `User.ts` already used it. The field list is unchanged,
and the comment recording that `authorId` is set from the signed-in user rather
than from request input now sits directly above the list it explains.
