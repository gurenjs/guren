/**
 * Kept so `@guren/core/internal/zod-compat` stays the specifier consumers
 * outside `@guren/server` write. The rule lives in `@guren/server` because core
 * builds after server, so a server module cannot import a core one.
 */
export * from '@guren/server/internal/zod-compat'
