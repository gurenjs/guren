---
"@guren/cli": patch
"create-guren-app": patch
---

Codegen types a schema ending in `.transform()` as `unknown` where it renders the parsed value: the `this.validated()` types in `.guren/routes.gen.ts`, response types and agent tool results. It used to render the transform's input, so `z.string().transform(Number)` came out `string`. Follow the transform with a schema to type it: `z.string().transform(Number).pipe(z.number())` is `number`. A controller that read such a field as its input type now needs that `.pipe()` to typecheck.

`.guren/forms.gen.ts` reads two shapes it used to leave out. A field like `z.string().trim().min(1).toLowerCase().pipe(z.email())` carries `format: 'email'`, and a union every member of which parses to a boolean (`z.union([z.boolean(), z.string().transform(…).pipe(z.boolean())])`) is typed `boolean`. The auth pages `make:auth` writes and the blog template's sign-in, sign-up and profile pages no longer pass `as="email"` or `as="checkbox"`; the field reads both from its contract.
