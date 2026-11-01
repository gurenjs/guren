---
"@guren/cli": minor
"create-guren-app": minor
"@guren/inertia-client": patch
---

`guren add ui` copies a `Field` component (RFC 0036 §2.3), and the default starter ships it. `Field` renders one form key from `useField()` with the copied `Label`, `Input`, `Textarea`, `Select` and `Checkbox`, all of which `add ui` and the generators now write along with it. `make:feature`'s New and Edit pages bind `useRouteForm()` to the route's contract from `.guren/forms.gen.ts` and render each field as `<Field form={form} name="…" />`, so labels read as words ("Starts at") and each control carries the `required`, length and range limits its validator declares. A nullable column starts at `null`. `make:feature` and `add ui field` refuse, before writing, when the installed `@guren/inertia-client` predates the `forms` subpath. `@guren/inertia-client/forms` exports `FieldForm`, the form type `useField()` accepts.
