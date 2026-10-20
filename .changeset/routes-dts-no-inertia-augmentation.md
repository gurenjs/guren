---
"@guren/cli": patch
---

`guren codegen` no longer writes the `@inertiajs/react` and `@inertiajs/core` augmentations into `types/generated/routes.d.ts`. Neither narrowed anything: `BaseInertiaLinkProps` is not exported from `@inertiajs/react`, so `<Link href="/nope">` typechecked, and the `Router` overloads sat beside Inertia's `string` ones. The file also stops importing `@inertiajs/core`, which an API-only app does not install. Type-checked links are `createTypedLink(routeManifest)` from `@guren/inertia-client`; `<Link href>` stays a `string`, so `href={route(...)}` keeps working.
