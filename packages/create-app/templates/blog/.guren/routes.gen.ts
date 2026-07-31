// Generated from routes/web.ts — DO NOT EDIT
// Run `guren codegen` to regenerate.

export const routeManifest = {
  'dashboard': { method: 'GET', path: '/dashboard' },
  'home': { method: 'GET', path: '/' },
  'login': { method: 'GET', path: '/login' },
  'login.store': { method: 'POST', path: '/login' },
  'logout': { method: 'POST', path: '/logout' },
  'posts.create': { method: 'GET', path: '/posts/create' },
  'posts.destroy': { method: 'DELETE', path: '/posts/:id' },
  'posts.edit': { method: 'GET', path: '/posts/:id/edit' },
  'posts.index': { method: 'GET', path: '/posts' },
  'posts.show': { method: 'GET', path: '/posts/:id' },
  'posts.store': { method: 'POST', path: '/posts' },
  'posts.update': { method: 'PUT', path: '/posts/:id' },
  'profile.edit': { method: 'GET', path: '/profile' },
  'profile.update': { method: 'PUT', path: '/profile' },
  'register': { method: 'GET', path: '/register' },
  'register.store': { method: 'POST', path: '/register' },
} as const

export type RouteManifest = typeof routeManifest
export type RouteName = keyof RouteManifest
export type RouteMethod = [RouteName] extends [never] ? string : RouteManifest[RouteName]['method']
export type RoutePath = [RouteName] extends [never] ? string : RouteManifest[RouteName]['path']

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
  dashboard: (query?: RouteQuery) => route('dashboard', query),
  home: (query?: RouteQuery) => route('home', query),
  login: Object.assign(
    (query?: RouteQuery) => route('login', query),
    {
    store: (query?: RouteQuery) => route('login.store', query)
  }
  ),
  logout: (query?: RouteQuery) => route('logout', query),
  posts: {
    create: (query?: RouteQuery) => route('posts.create', query),
    destroy: (params: RouteParams<'posts.destroy'>, query?: RouteQuery) => route('posts.destroy', params, query),
    edit: (params: RouteParams<'posts.edit'>, query?: RouteQuery) => route('posts.edit', params, query),
    index: (query?: RouteQuery) => route('posts.index', query),
    show: (params: RouteParams<'posts.show'>, query?: RouteQuery) => route('posts.show', params, query),
    store: (query?: RouteQuery) => route('posts.store', query),
    update: (params: RouteParams<'posts.update'>, query?: RouteQuery) => route('posts.update', params, query)
  },
  profile: {
    edit: (query?: RouteQuery) => route('profile.edit', query),
    update: (query?: RouteQuery) => route('profile.update', query)
  },
  register: Object.assign(
    (query?: RouteQuery) => route('register', query),
    {
    store: (query?: RouteQuery) => route('register.store', query)
  }
  )
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
