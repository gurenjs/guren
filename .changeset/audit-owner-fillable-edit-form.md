---
"@guren/cli": minor
---

`guren audit` reports two more access-control gaps, as warnings:

- `owner-fillable:<Model>`: a model lists in `fillable` a column that references the users table (an authenticatable model's table), so a request can choose the record's owner. Set it on the server with `create(data, { set: { authorId: user.id } })` instead.
- `policy:GET <path>` for a record's edit form: the `edit` action of a controller loads a model the app keeps a policy for and never authorizes, so any signed-in user can open another user's edit form. Until now the policy rule read mutating routes only.
- The policy rule judges a mutating action on the models it writes (`create`, `update`, `delete`, their `force` forms and `restore`, directly or down a query chain), no longer on every policed model its body names. An action that loads a parent to write a child (a comment's post) stops warning about the parent.
