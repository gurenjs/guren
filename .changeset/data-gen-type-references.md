---
"@guren/cli": minor
---

Emit payload types data.gen.ts cannot copy as import-type references

A Resource whose payload type is exported but has no copyable object body — a
`z.infer<typeof Schema>` alias, an intersection, a merged interface — is now
emitted as `export type X = import('../app/Http/Resources/XResource').XData`
instead of being omitted with a warning. One zod schema can therefore serve as
the single source of truth for a route's `output:` contract and its Resource's
`Data.*` type. Unexported and generic declarations stay refused; the
unexported warning now says that exporting the declaration fixes it.
