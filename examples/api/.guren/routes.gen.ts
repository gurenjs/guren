// Generated from routes/api.ts — DO NOT EDIT
// Run `guren codegen` to regenerate.

export const routeManifest = {
  'auth.login': { method: 'POST', path: '/api/auth/login' },
  'auth.register': { method: 'POST', path: '/api/auth/register' },
  'auth.tokens.destroy': { method: 'DELETE', path: '/api/auth/tokens/:id' },
  'auth.tokens.index': { method: 'GET', path: '/api/auth/tokens' },
  'auth.tokens.store': { method: 'POST', path: '/api/auth/tokens' },
  'auth.user': { method: 'GET', path: '/api/auth/user' },
  'tasks.destroy': { method: 'DELETE', path: '/api/tasks/:id' },
  'tasks.index': { method: 'GET', path: '/api/tasks' },
  'tasks.show': { method: 'GET', path: '/api/tasks/:id' },
  'tasks.store': { method: 'POST', path: '/api/tasks' },
  'tasks.update': { method: 'PUT', path: '/api/tasks/:id' },
} as const

export type RouteManifest = typeof routeManifest
export type RouteName = keyof RouteManifest
export type RouteMethod = [RouteName] extends [never] ? string : RouteManifest[RouteName]['method']
export type RoutePath = [RouteName] extends [never] ? string : RouteManifest[RouteName]['path']

type PrimitiveQueryValue = string | number | boolean | null | undefined
type QueryValue = PrimitiveQueryValue | readonly PrimitiveQueryValue[]
export type RouteQuery = Record<string, QueryValue>

type SegmentParamKey<TSegment extends string> = TSegment extends `:${infer TParam}`
  ? TParam extends `${infer TName}{${string}`
    ? TName
    : TParam extends `${infer TName}?`
      ? TName
      : TParam
  : never
type PathParamKeys<TPath extends string> = TPath extends `${infer THead}/${infer TRest}`
  ? SegmentParamKey<THead> | PathParamKeys<TRest>
  : SegmentParamKey<TPath>
type HasPathParams<TPath extends string> = [PathParamKeys<TPath>] extends [never] ? false : true
type PathParamsOf<TPath extends string> =
  HasPathParams<TPath> extends false
    ? Record<string, never>
    : { [TKey in PathParamKeys<TPath>]: string | number }

export type RouteParams<TName extends RouteName> = PathParamsOf<RouteManifest[TName]['path']>

type RouteArgs<TName extends RouteName> =
  HasPathParams<RouteManifest[TName]['path']> extends false
    ? [query?: RouteQuery]
    : [params: RouteParams<TName>, query?: RouteQuery]

export function route<TName extends RouteName>(name: TName, ...args: RouteArgs<TName>): string {
  const definition: { method: RouteMethod; path: RoutePath } | undefined = routeManifest[name]
  if (!definition) {
    throw new Error(`Route [${String(name)}] not defined.`)
  }

  const [firstArg, secondArg] = args as [RouteQuery | RouteParams<TName> | undefined, RouteQuery | undefined]
  const params = (args.length > 1 ? firstArg : hasPathParams(definition.path) ? firstArg : undefined) as RouteParams<TName> | undefined
  const query = (args.length > 1 ? secondArg : hasPathParams(definition.path) ? undefined : firstArg) as RouteQuery | undefined
  const path = substituteParams(definition.path, params as Record<string, string | number> | undefined)
  return appendQueryString(path, query)
}

export const routes = {
  auth: {
    login: (query?: RouteQuery) => route('auth.login', query),
    register: (query?: RouteQuery) => route('auth.register', query),
    tokens: {
      destroy: (params: RouteParams<'auth.tokens.destroy'>, query?: RouteQuery) => route('auth.tokens.destroy', params, query),
      index: (query?: RouteQuery) => route('auth.tokens.index', query),
      store: (query?: RouteQuery) => route('auth.tokens.store', query)
    },
    user: (query?: RouteQuery) => route('auth.user', query)
  },
  tasks: {
    destroy: (params: RouteParams<'tasks.destroy'>, query?: RouteQuery) => route('tasks.destroy', params, query),
    index: (query?: RouteQuery) => route('tasks.index', query),
    show: (params: RouteParams<'tasks.show'>, query?: RouteQuery) => route('tasks.show', params, query),
    store: (query?: RouteQuery) => route('tasks.store', query),
    update: (params: RouteParams<'tasks.update'>, query?: RouteQuery) => route('tasks.update', params, query)
  }
} as const

function hasPathParams(path: string): boolean {
  return /(?:^|\/):[A-Za-z0-9_-]/u.test(path)
}

function substituteParams(path: string, params?: Record<string, string | number>): string {
  if (!params) {
    return path
  }

  return path.replace(/(^|\/):([A-Za-z0-9_-]+\*?)(?:\{[^}]*\}(?:[^/]*\})*)?\??/gu, (match, prefix, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return `${prefix}${encodeURIComponent(String(params[key]))}`
  })
}

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
  return serialized ? `${path}?${serialized}` : path
}
