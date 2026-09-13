---
'@guren/server': patch
---

`this.inertia(pages.x, props)` with a missing or mistyped prop now fails typechecking with an error that names the prop, such as "Property 'description' is missing in type '{ title: string; }'". TypeScript reports a call that matches no overload against the last overload, and the string-component overload came last, so the error read "Argument of type 'PageContract<…>' is not assignable to parameter of type 'string'" and never named the prop. The page-contract overload is now declared last. Which overload a valid call resolves to is unchanged.
