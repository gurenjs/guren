/**
 * Re-export of `@guren/server/internal/zod-compat`, kept so
 * `@guren/core/internal/zod-compat` stays the specifier every consumer
 * outside `@guren/server` writes — `@guren/openapi` and `@guren/cli` both
 * depend on `@guren/core`, not on the server package.
 *
 * The rule itself lives in `@guren/server` because `@guren/server` builds
 * before `@guren/core` (core's index is `export * from '@guren/server'`), so
 * a server module cannot import a core one: that edge would close a
 * build-order cycle, and RFC 0016's `deriveAgentTools` — which lives in
 * `@guren/server` — has to reach the same walker the OpenAPI document is
 * built from. Same shape as `store-utils.ts` re-exporting
 * `@guren/server/support/expiry`.
 */
export * from '@guren/server/internal/zod-compat'
