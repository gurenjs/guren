---
"@guren/cli": minor
"create-guren-app": minor
---

`make:auth` binds each validator it writes to its route as the body schema: login, register, forgot password, reset password and profile. The router validates the body after the route's guard and throttle, and the actions read it with `this.validated()`. Checks that need the database or the session stay in the action, so wrong credentials still report under `message`.

The auth pages `make:auth` writes, and the blog template's sign-in, sign-up and profile pages, use the copied `Field`, `Button` and `Alert` components with `useRouteForm()` and the contracts in `.guren/forms.gen.ts`. `make:auth` refuses to write them into an app whose installed `@guren/inertia-client` lacks `./forms`.

The `remember` field of `LoginSchema` and the password fields of `ProfileUpdateSchema` now end in a schema rather than a transform, so codegen types the parsed values as `boolean` and `string`. They accept and produce the same values as before.
