---
"@guren/cli": patch
---

`guren codegen` refuses to emit a `Data.*` type it would have to guess at, and says which declaration it could not read.

Three shapes each yielded *some* brace body with no warning — the wrong one, which is worse than none: the frontend gets a type that compiles and lies about the payload.

- `interface PostResourceData extends Record<string, { nested: true }> { … }` emitted the generic argument, not the body. Detected by the heritage clause's unbalanced angle brackets, which is what a clause cut off at the wrong brace looks like.
- Two `interface PostResourceData` blocks in one file emitted the first and dropped the second's members, though TypeScript merges them.
- `type PostResourceData = { id: number } & { title: string }` emitted only the first term. An alias's right-hand side runs to the end of the statement, so a body followed by `&`, `|`, or a conditional `extends` is not the whole type.

`type PostResourceData = { id: number }[]` and `= { … }['payload']` emitted the object operand as if it were the whole type; both are refused now too.

Declarations are matched at the top level only. A type of the same name inside a namespace, an ambient module, or a function body is a different type that merely shares it: its members were emitted as the Resource's payload when nothing at the top level declared one, and it counted as a second block against a top-level declaration that was in fact the only one.

A generic declaration is refused too, as it always was, but now says so: `{ id: T }` copied out of `interface PostResourceData<T>` would not compile, and "not a plain object type" sent the author to rewrite a shape that was never the problem.

Each is now named, with the reason and the shape to write instead. A `type X = { … }` whose body stands alone still reads exactly as before, and output for every shape that already worked is byte-identical.
