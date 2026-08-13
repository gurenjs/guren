---
"@guren/cli": patch
"@guren/server": patch
"@guren/openapi": patch
"@guren/inertia-client": patch
"create-guren-app": patch
---

Fix Hono path modifiers (`{regex}`, `?`, `*`) leaking into generated route param types, substituted URLs, and OpenAPI output.

A route path like `/items/:id{[0-9]+}` or `/archive/:slug?` previously produced a `RouteParams<'items.show'>` key of `"id{[0-9]+}"` instead of `"id"`, and `router.route()` / the generated API client / `<Link>`/`<Form>` left the modifier text in the substituted URL (`/items/5{[0-9]+}`). The shared `PathParamKeys` type helper and `substituteParams` runtime helper (`@guren/cli`'s `routes-types-fragments.ts`, mirrored in `@guren/inertia-client`'s `components.tsx`, and duplicated in `@guren/server`'s `Router.route()`) now strip a regex constraint and a trailing `?` before deriving the param key. `@guren/openapi`'s `toOpenApiPath`/`extractPathParamNames`/`buildOperationId` get the same treatment, converting `/items/:id{[0-9]+}` to the valid template `/items/{id}` instead of `/items/{id}{[0-9]+}`.

`:name*` is deliberately **not** treated as a modifier: verified directly against Hono, it is not wildcard syntax — it registers a literal, single-segment param whose real runtime key is `name*` (asterisk included). The param-key rule now keeps that key as-is rather than stripping it, so generated types and substituted URLs agree with what Hono actually does. `@guren/openapi` is the one exception — OpenAPI path templates follow RFC 6570, where `{name*}` already means "explode", so the `*` is dropped there to avoid emitting a template that means something else. Route model binding (`Router`'s `resolveModelBindings`/`serializeBindings`) is not extended to resolve a `:name*` key; docs now call out `:name*` as a pattern to avoid, recommending a constrained parameter like `:path{.+}` for multi-segment matching instead.

`@guren/server`'s `Router.route()`, `resolveModelBindings`, and `serializeBindings` also stop misreading a `:` that appears inside a regex constraint's character class (e.g. `{[a-z:]+}`) as the start of another param.

`create-guren-app`'s `default` and `blog` template `.guren/routes.gen.ts` / `.guren/api-client.gen.ts` are regenerated with the fix.
