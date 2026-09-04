/**
 * Kept so `@guren/core/internal/zod-json-schema` stays the specifier consumers
 * outside `@guren/server` write. The walker lives in `@guren/server` for a
 * build-order reason, not a layering one: core builds after server, and RFC
 * 0016's `deriveAgentTools` must derive from the same walker OpenAPI uses.
 */
export * from '@guren/server/internal/zod-json-schema'
