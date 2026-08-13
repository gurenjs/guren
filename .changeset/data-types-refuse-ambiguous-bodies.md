---
"@guren/cli": patch
---

`guren codegen` refuses to emit a `Data.*` type it would have to guess at, and says which declaration it could not read.

Three shapes each yielded *some* brace body with no warning — the wrong one, which is worse than none: the frontend gets a type that compiles and lies about the payload.

- `interface PostResourceData extends Record<string, { nested: true }> { … }` emitted the generic argument, not the body. Detected by the heritage clause's unbalanced angle brackets, which is what a clause cut off at the wrong brace looks like.
- Two `interface PostResourceData` blocks in one file emitted the first and dropped the second's members, though TypeScript merges them.
- `type PostResourceData = { id: number } & { title: string }` emitted only the first term. An alias's right-hand side runs to the end of the statement, so a body followed by `&`, `|`, or a conditional `extends` is not the whole type.

Each is now named, with the reason and the shape to write instead. A `type X = { … }` whose body stands alone still reads exactly as before, and output for every shape that already worked is byte-identical.
