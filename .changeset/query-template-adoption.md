---
"@guren/cli": patch
"create-guren-app": minor
---

The generated API client now compiles against its own documented usage, and the blog starter puts it to work on an HTTP QUERY search endpoint.

`createApiClient<ApiRoutes>()` rejected every real call site: the `Record<...>` generic constraint turned away the generated `ApiRoutes` interface (interfaces carry no implicit index signature), and param-less routes — emitted as `params: Record<string, never>` — were misread as requiring a `params` argument because `keyof Record<string, never>` is `string`, not `never`. The constraint is now a mapped-object type and the param check matches the emitted shape, with a compile-level test that runs `tsc` over the generated module and its documented usage.

The blog blueprint gains `QUERY /posts/search` (RFC 10008): a route-bound Zod body schema, a read-only controller action, a starter test driving `TestApp.query()`, and a search box on the posts page calling the endpoint through the generated typed client — the first template consumer of `createApiClient`.
