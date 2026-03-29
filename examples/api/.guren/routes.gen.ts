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
export type RouteMethod = RouteManifest[RouteName]['method']
export type RoutePath = RouteManifest[RouteName]['path']

type PrimitiveQueryValue = string | number | boolean | null | undefined
type QueryValue = PrimitiveQueryValue | readonly PrimitiveQueryValue[]
export type RouteQuery = Record<string, QueryValue>

type NormalizeParamKey<TValue extends string> = TValue extends `${infer Key}?` ? Key : TValue
type PathParamKeys<TPath extends string> =
  TPath extends `${string}:${infer Param}/${infer Rest}`
    ? NormalizeParamKey<Param> | PathParamKeys<`/${Rest}`>
    : TPath extends `${string}:${infer Param}`
      ? NormalizeParamKey<Param>
      : never

export type RouteParams<TName extends RouteName> =
  [PathParamKeys<RouteManifest[TName]['path']>] extends [never]
    ? Record<string, never>
    : { [TKey in PathParamKeys<RouteManifest[TName]['path']>]: string | number }

type RouteArgs<TName extends RouteName> =
  [PathParamKeys<RouteManifest[TName]['path']>] extends [never]
    ? [query?: RouteQuery]
    : [params: RouteParams<TName>, query?: RouteQuery]

export function route<TName extends RouteName>(name: TName, ...args: RouteArgs<TName>): string {
  const definition = routeManifest[name]
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
  return /:[A-Za-z0-9_-]+/u.test(path)
}

function substituteParams(path: string, params?: Record<string, string | number>): string {
  if (!params) {
    return path
  }

  return path.replace(/:([A-Za-z0-9_-]+)/gu, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) {
      return match
    }

    return encodeURIComponent(String(params[key]))
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
