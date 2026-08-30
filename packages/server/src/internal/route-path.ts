/**
 * The one Hono route-path lexing rule, shared by every surface that has to say
 * what parameters a path declares: the router's own substitution and binding
 * scanners, RFC 0016's agent tool input, and `@guren/openapi`'s path template
 * and parameter list.
 *
 * Internal by the rules in `contributing/api-stability.md` — reachable only
 * through a deep import under `internal/`, never re-exported from an index.
 * It lives in `@guren/server` and is re-exported by
 * `@guren/core/internal/route-path` for the same build-order reason the
 * JSON Schema walker beside it does: core's index is
 * `export * from '@guren/server'`, so a server module cannot import a core
 * one.
 *
 * It exists because two lexers is how two surfaces come to describe one path
 * differently. They did: `@guren/openapi` carried its own copy with the `*`
 * outside the capture group, so `/files/:name*` yielded the parameter `name`
 * there and `name*` — what Hono actually registers — everywhere else. What
 * *does* legitimately differ is rendering, not lexing, and that difference now
 * lives at the one call site that needs it (see `stripExplodeModifier`).
 */

// A param starts only at a segment boundary (`/status/foo:bar` is a literal),
// an attached regex constraint is consumed whole (`{[0-9]{2}}` and `{[^/]{2}}`
// stay intact), and a trailing `?`/`*` modifier belongs to the token. The `*`
// sits *inside* the capture because Hono keeps it in the parameter's name;
// the `?` does not, because Hono does not.
//
// The constraint is spelled out to one level of nesting rather than with a
// nested quantifier: every class here excludes both braces, so a scan stops
// at the next brace instead of running to the end of the string. The
// `\{[^}]*\}(?:[^/]*\})*` shape it replaces was quadratic (CodeQL
// js/polynomial-redos; measured 2.9s for a 16k-char path, vs 1.9ms here).
export const PATH_PARAM_PATTERN = /(^|\/):([A-Za-z0-9_-]+\*?)(?:\{[^{}]*\{[^{}]*\}[^{}]*\}|\{[^{}]*\})?\??/gu

/**
 * Param labels in path order, exactly as Hono registers them: constraints
 * dropped, a trailing `*` kept (it is part of the name), a trailing `?`
 * dropped (it is not).
 */
export function extractPathParamNames(path: string): string[] {
  return Array.from(path.matchAll(PATH_PARAM_PATTERN), (match) => match[2]!)
}
