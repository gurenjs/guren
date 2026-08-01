---
"@guren/openapi": patch
---

Keep array element types, Zod 3 pipelines, and response-side types in the
generated OpenAPI document.

Every array rendered as `items: {}`. Zod 4 keeps an array's element in
`_def.element` and puts the literal string `'array'` in `_def.type`, and the
walker read `_def.type` first — so it handed that string back to itself,
failed to recognize it as a schema, and fell back to an empty item schema.
Zod 3 stores the element in `_def.type`, so both orderings have to be tried,
with `element` first.

Zod 3 names a pipe `ZodPipeline`, which the walker did not recognize at all:
a `.pipe()`ed property was dropped from the document rather than mis-typed.
Zod 4's `prefault()` and `nonoptional()` were dropped the same way, as was a
Zod 3 `.brand()`, which keeps its inner schema under a key the walker read as
a type name.

Request and response schemas are now walked in their own direction. A pipe
carries a separate type per side, so a `z.string().pipe(z.coerce.number())`
response documented the string a caller sends instead of the number it
receives; a `.transform()` has no readable output type, so its input side
stays the answer for both. A `.default()`ed field is likewise omittable from
a request but always present in a response, and now appears in the response's
`required` list.

A `query` or `params` schema wrapped in `.default()`, `.optional()`,
`.catch()` or `.nullable()` lost every one of its parameters, because the walk
that finds the object behind a parameter schema looked through a shorter list
of wrappers than the two walks that render types and decide presence. All
three now read one shared set, so a wrapper cannot reach one walk and miss
another.

Two more properties were described as required when they are not, and one
the reverse. A `.catch()`ed field substitutes its fallback for any failure, a
missing value included, so a request never has to carry it. A `.pipe()`d field
runs both stages, so it may be omitted only when neither stage rejects a
missing value — reading just the side being documented promised an omission
the other stage refuses.

A `z.lazy()` schema keeps its contents behind a getter this walker does not
call, so the property cannot be documented. It is now reported as a warning
instead of vanishing, along with any other wrapper whose contents cannot be
read — a silently missing property reads as a schema that never declared one.

Coercion is deliberately not widened: OpenAPI describes JSON in both
directions, so `z.coerce.date()` already documents as the ISO string a caller
sends, and widening `z.coerce.number()` to accept a string would cost callers
precision in exchange for nothing the schema requires.
