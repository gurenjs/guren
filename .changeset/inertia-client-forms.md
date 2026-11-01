---
"@guren/inertia-client": minor
---

Add the `@guren/inertia-client/forms` subpath (RFC 0036 §2.2). `useRouteForm(contract, initial)` binds an Inertia form to a route's form contract from `.guren/forms.gen.ts`, with `params` required exactly when the route's path has parameters, `adoptPageErrors` to take the errors of a redirect-back once on mount, and a `handleSubmit` that sends a blank control as `null` for a nullable key, leaves out an optional key that was always blank, and sends a cleared one as `''`. `useField(form, name)` returns one key's label, control props and error state, deriving the input kind and HTML constraints (`required`, lengths, `min`/`max`, `step`) from the contract; a plain Inertia form works too. `humanizeFieldName()` is the default label (`startsAt` → "Starts at"). The styled `Field` component that renders it is copied by `guren add ui` in a later release.
