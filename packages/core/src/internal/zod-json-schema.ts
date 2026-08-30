/**
 * Re-export of `@guren/server/internal/zod-json-schema`, kept so
 * `@guren/core/internal/zod-json-schema` stays the specifier every consumer
 * outside `@guren/server` writes — `@guren/openapi` renders the walker's
 * output as OpenAPI 3.1 schema objects and depends on `@guren/core`, not on
 * the server package.
 *
 * The walker itself lives in `@guren/server` for a build-order reason, not a
 * layering one: `@guren/core`'s index is `export * from '@guren/server'`, so
 * core builds *after* server and a server module importing a core one would
 * close a cycle. RFC 0016's `deriveAgentTools` lives in `@guren/server` and
 * must derive from the very same walker an OpenAPI document is built from —
 * so the rule moved down to the package both surfaces can see. Same shape as
 * `store-utils.ts` re-exporting `@guren/server/support/expiry`.
 */
export * from '@guren/server/internal/zod-json-schema'
