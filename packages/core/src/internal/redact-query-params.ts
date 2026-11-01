/**
 * Kept so `@guren/core/internal/redact-query-params` stays the specifier plugins
 * write. The rule lives in `@guren/server` because core builds after server, so
 * a server module cannot import a core one.
 */
export * from '@guren/server/internal/redact-query-params'
