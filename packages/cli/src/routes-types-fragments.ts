/**
 * Static code fragments emitted by the route type generators.
 *
 * These string constants represent TypeScript code that is identical
 * regardless of which routes are defined.  Keeping them separate from
 * the builder logic makes both easier to read and modify.
 */

/** Module augmentations for @inertiajs/react and @inertiajs/core. */
export const DECLARATION_MODULE_AUGMENTATION = `\
declare module '@inertiajs/react' {
  interface BaseInertiaLinkProps {
    href: Guren.RouteUrl
  }
}

declare module '@inertiajs/core' {
  interface Router {
    visit(href: Guren.RouteUrl, options?: VisitOptions): void
    get(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    post(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    put(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    patch(url: Guren.RouteUrl, data?: RequestPayload, options?: Omit<VisitOptions, 'method' | 'data'>): void
    delete(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'method'>): void
    replace(url: Guren.RouteUrl, options?: Omit<VisitOptions, 'replace'>): void
  }
}
`

/** Type definitions emitted after the route manifest object. */
export const RUNTIME_TYPE_DEFINITIONS = `\
export type RouteManifest = typeof routeManifest
export type RouteName = keyof RouteManifest
export type RouteMethod = [RouteName] extends [never] ? string : RouteManifest[RouteName]['method']
export type RoutePath = [RouteName] extends [never] ? string : RouteManifest[RouteName]['path']

type PrimitiveQueryValue = string | number | boolean | null | undefined
type QueryValue = PrimitiveQueryValue | readonly PrimitiveQueryValue[]
export type RouteQuery = Record<string, QueryValue>

// Mirrors Hono's path lexing: a param starts only at a segment boundary, its
// key ends at the first \`{\` (regex constraints, which may nest braces, are
// never part of it), and a trailing \`?\`/\`*\` modifier is dropped.
type SegmentParamKey<TSegment extends string> = TSegment extends \`:\${infer TParam}\`
  ? TParam extends \`\${infer TName}{\${string}\`
    ? TName
    : TParam extends \`\${infer TName}?\`
      ? TName
      : TParam extends \`\${infer TName}*\`
        ? TName
        : TParam
  : never
type PathParamKeys<TPath extends string> = TPath extends \`\${infer THead}/\${infer TRest}\`
  ? SegmentParamKey<THead> | PathParamKeys<TRest>
  : SegmentParamKey<TPath>

export type RouteParams<TName extends RouteName> =
  [PathParamKeys<RouteManifest[TName]['path']>] extends [never]
    ? Record<string, never>
    : { [TKey in PathParamKeys<RouteManifest[TName]['path']>]: string | number }

type RouteArgs<TName extends RouteName> =
  [PathParamKeys<RouteManifest[TName]['path']>] extends [never]
    ? [query?: RouteQuery]
    : [params: RouteParams<TName>, query?: RouteQuery]
`

/** The `route()` function emitted into the runtime module. */
export const RUNTIME_ROUTE_FUNCTION = `\
export function route<TName extends RouteName>(name: TName, ...args: RouteArgs<TName>): string {
  const definition = routeManifest[name]
  if (!definition) {
    throw new Error(\`Route [\${String(name)}] not defined.\`)
  }

  const [firstArg, secondArg] = args as [RouteQuery | RouteParams<TName> | undefined, RouteQuery | undefined]
  const params = (args.length > 1 ? firstArg : hasPathParams(definition.path) ? firstArg : undefined) as RouteParams<TName> | undefined
  const query = (args.length > 1 ? secondArg : hasPathParams(definition.path) ? undefined : firstArg) as RouteQuery | undefined
  const path = substituteParams(definition.path, params as Record<string, string | number> | undefined)
  return appendQueryString(path, query)
}
`

/**
 * The `substituteParams()` emitted into every generated module that builds
 * URLs (the route helpers and the API client), and hand-mirrored in
 * `@guren/inertia-client`'s components (a dependency-free package). A sync
 * test asserts the mirror matches this constant character for character.
 */
export const RUNTIME_SUBSTITUTE_PARAMS_FUNCTION = `\
// Mirrors Hono's path lexing: a param starts only at a segment boundary, an
// attached regex constraint runs to the last \`}\` before the next \`/\` (so
// \`{[0-9]{2}}\` stays whole), and a trailing \`?\`/\`*\` modifier is consumed
// with the token: \`/items/:id{[0-9]+}\` -> \`/items/1\`.
function substituteParams(path: string, params?: Record<string, string | number>): string {
  if (!params) {
    return path
  }

  return path.replace(/(^|\\/):([A-Za-z0-9_-]+)(?:\\{[^}]*\\}(?:[^/]*\\})*)?[?*]?/gu, (match, prefix, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return \`\${prefix}\${encodeURIComponent(String(params[key]))}\`
  })
}
`

/** Runtime utility functions used by the `route()` helper. */
export const RUNTIME_UTILITY_FUNCTIONS = `\
function hasPathParams(path: string): boolean {
  return /(?:^|\\/):[A-Za-z0-9_-]/u.test(path)
}

${RUNTIME_SUBSTITUTE_PARAMS_FUNCTION}
function appendQueryString(path: string, query?: RouteQuery): string {
  if (!query) {
    return path
  }

  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(query)) {
    if (value == null) {
      continue
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (item != null) {
          search.append(key, String(item))
        }
      }
      continue
    }

    search.set(key, String(value))
  }

  const serialized = search.toString()
  return serialized ? \`\${path}?\${serialized}\` : path
}
`
