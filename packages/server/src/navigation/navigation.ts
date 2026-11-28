/**
 * The application's navigation as data (RFC 0040 §5): each entry names a route
 * and when to show it, the server filters by the current user, and the client
 * receives only `{ label, path, current }` for what that user may see.
 */
import type { Context } from 'hono'
import { getAuthContext } from '../auth/context'
import { resolveGate, type Gate } from '../authorization/Gate'
import type { AuthUser } from '../authorization/types'
import { defineConfig, type ConfigDefinition } from '../config/define'
import type { Container } from '../container/Container'
import { resolveOptional } from '../container/resolve-optional'
import type { Application } from '../http/Application'
import { isParameterlessPath } from '../internal/route-path'
import type { Router } from '../mvc/Router'
import { shareInertiaProps } from '../mvc/inertia/shared'

export type NavigationAuth = 'any' | 'required' | 'guest'

/** The class a policy is bound to with `gate.policy()`. */
export type NavigationModel = abstract new (...args: never) => unknown

export type NavigationFieldValue = string | number | boolean | null

export interface NavigationShow {
  /** `required` shows the entry to a signed-in user, `guest` to a visitor; `any` (the default) to both. */
  readonly auth?: NavigationAuth
  /** Asked as `gate.forUser(user).allows(ability, Model)`, the call `this.authorize()` makes with the bare class. */
  readonly can?: readonly [ability: string, model: NavigationModel]
  /** Fields of the user, each compared by strict equality; a guest matches none. */
  readonly where?: Readonly<Record<string, NavigationFieldValue>>
}

/**
 * The route names a navigation entry may use, keyed by name. `guren codegen` writes the
 * named `GET` routes with no path parameter once the app has `config/navigation.ts`; a
 * route a provider registers, which codegen does not read, is added by merging a key here.
 */
export interface GurenNavigationRoutes {}

/** Codegen sets `generated: true` beside the names it writes; until then any name passes. */
export interface GurenNavigationRegistry {}

/** A route name a navigation entry accepts: one the registry lists, or any string before codegen has run. */
export type NavigationRouteName = GurenNavigationRegistry extends { generated: true }
  ? keyof GurenNavigationRoutes & string
  : string

export interface NavigationEntry {
  readonly label: string
  /** A named `GET` route with no path parameter. */
  readonly route: NavigationRouteName
  /** Every condition given must hold. */
  readonly show?: NavigationShow
}

/** What the `navigation` shared prop holds for each entry the current user may see. */
export interface NavigationItem {
  readonly label: string
  readonly path: string
  readonly current: boolean
}

export interface NavigationConfig {
  readonly entries: readonly NavigationEntry[]
}

interface LinkedEntry {
  readonly label: string
  readonly path: string
  readonly show: NavigationShow | undefined
}

const AUTH_VALUES: ReadonlySet<string> = new Set<NavigationAuth>(['any', 'required', 'guest'])
const SHOW_KEYS: ReadonlySet<string> = new Set(['auth', 'can', 'where'])

/**
 * The navigation module, given to `createApp({ config })`. Its `boot` links each
 * entry to its route and shares `navigation` as a lazy prop, so a partial reload
 * that does not ask for it runs no gate check.
 */
export function defineNavigation(entries: readonly NavigationEntry[]): ConfigDefinition<'navigation'> {
  assertEntries(entries)
  const config: NavigationConfig = { entries: Object.freeze([...entries]) }
  return defineConfig({
    key: 'navigation',
    resolve: () => config,
    bind: (container, resolved) => {
      container.instance('navigation', resolved)
    },
    boot: (container, resolved) => {
      const app = container.make<Application>('app')
      const links = linkEntries(app.router, resolved.entries)
      shareInertiaProps((ctx) => ({ navigation: () => navigationItems(ctx, links, container) }), container)
    },
  })
}

function assertEntries(entries: readonly NavigationEntry[]): void {
  if (!Array.isArray(entries)) {
    throw new TypeError('[guren] defineNavigation() takes an array of entries.')
  }
  const routes = new Set<string>()
  entries.forEach((entry, index) => {
    const at = `defineNavigation()[${index}]`
    if (typeof entry !== 'object' || entry === null) throw new TypeError(`[guren] ${at} is not an entry.`)
    if (typeof entry.label !== 'string' || entry.label.trim() === '') throw new TypeError(`[guren] ${at} has no label.`)
    if (typeof entry.route !== 'string' || entry.route === '') throw new TypeError(`[guren] ${at} names no route.`)
    if (routes.has(entry.route)) {
      throw new TypeError(`[guren] ${at} names route "${entry.route}" a second time; the navigation holds one entry per route.`)
    }
    routes.add(entry.route)
    if (entry.show !== undefined) assertShow(entry.show, at)
  })
}

function assertShow(show: NavigationShow, at: string): void {
  if (typeof show !== 'object' || show === null) throw new TypeError(`[guren] ${at}.show is not an object.`)
  for (const key of Object.keys(show)) {
    if (!SHOW_KEYS.has(key)) throw new TypeError(`[guren] ${at}.show has "${key}"; it takes auth, can and where.`)
  }
  if (show.auth !== undefined && !AUTH_VALUES.has(show.auth)) {
    throw new TypeError(`[guren] ${at}.show.auth is "${String(show.auth)}"; it takes any, required or guest.`)
  }
  if (show.can !== undefined) {
    const [ability, model] = Array.isArray(show.can) ? show.can : []
    if (show.can.length !== 2 || typeof ability !== 'string' || ability === '' || typeof model !== 'function') {
      throw new TypeError(`[guren] ${at}.show.can takes [ability, Model], the model class its policy is bound to.`)
    }
  }
  if (show.where !== undefined) {
    if (typeof show.where !== 'object' || show.where === null || Array.isArray(show.where)) {
      throw new TypeError(`[guren] ${at}.show.where takes an object of user fields.`)
    }
    for (const [field, value] of Object.entries(show.where)) {
      if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new TypeError(`[guren] ${at}.show.where.${field} is not a string, number, boolean or null.`)
      }
    }
  }
}

/**
 * Hidden rather than failing the request: `Router.route()` throws on a missing
 * name, and the layout renders on every page. The path is the one `Router.route()`
 * gives, the route last named so, whatever order the routes were registered in.
 */
function linkEntries(router: Router, entries: readonly NavigationEntry[]): LinkedEntry[] {
  const definitions = router.definitions()
  const links: LinkedEntry[] = []
  for (const entry of entries) {
    const path = router.hasRoute(entry.route) ? router.route(entry.route) : undefined
    const route = path === undefined
      ? undefined
      : [...definitions].reverse().find((definition) => definition.name === entry.route && definition.path === path)
    const hidden = (reason: string) => console.warn(`[guren] The navigation entry "${entry.label}" is hidden: route "${entry.route}" ${reason}.`)
    if (route === undefined) {
      hidden('is not registered')
    } else if (route.method !== 'GET') {
      hidden(`is a ${route.method} route, and a link can only follow a GET`)
    } else if (!isParameterlessPath(route.path)) {
      hidden(`has a path parameter (${route.path}), which an entry cannot fill`)
    } else {
      links.push({ label: entry.label, path: route.path, show: entry.show })
    }
  }
  return links
}

async function navigationItems(ctx: Context, links: readonly LinkedEntry[], container: Container): Promise<NavigationItem[]> {
  const user = links.some((link) => link.show !== undefined) ? await currentUser(ctx) : null
  const shown = links.filter((link) => passesAuth(link.show?.auth, user) && passesWhere(link.show?.where, user))
  const allowed = askGate(shown, user, container)
  const visible: LinkedEntry[] = []
  for (const link of shown) {
    if (link.show?.can === undefined || await allowed.get(link.show.can[1])!.get(link.show.can[0])!) visible.push(link)
  }
  const current = currentIndex(visible.map((link) => link.path), ctx.req.path)
  return visible.map((link, index) => ({ label: link.label, path: link.path, current: index === current }))
}

async function currentUser(ctx: Context): Promise<AuthUser | null> {
  const auth = getAuthContext(ctx)
  if (!auth) return null
  return ((await auth.user()) as AuthUser | null) ?? null
}

function passesAuth(auth: NavigationAuth | undefined, user: AuthUser | null): boolean {
  if (auth === 'required') return user !== null
  if (auth === 'guest') return user === null
  return true
}

function passesWhere(where: NavigationShow['where'], user: AuthUser | null): boolean {
  if (where === undefined) return true
  if (user === null) return false
  const fields = user as unknown as Record<string, unknown>
  return Object.entries(where).every(([field, value]) => fields[field] === value)
}

/** Every distinct ability and model is asked once, and all of them together. */
function askGate(
  links: readonly LinkedEntry[],
  user: AuthUser | null,
  container: Container,
): Map<NavigationModel, Map<string, Promise<boolean>>> {
  const asked = new Map<NavigationModel, Map<string, Promise<boolean>>>()
  let gate: Gate | undefined
  for (const link of links) {
    const can = link.show?.can
    if (can === undefined) continue
    const [ability, model] = can
    const abilities = asked.get(model) ?? new Map<string, Promise<boolean>>()
    asked.set(model, abilities)
    if (abilities.has(ability)) continue
    gate ??= (resolveOptional<Gate>(container, 'gate') ?? resolveGate()).forUser(user)
    const forUser = gate
    abilities.set(ability, Promise.resolve()
      .then(() => forUser.allows(ability, model))
      .catch((error: unknown) => {
        warnThrownCheck(ability, model, error)
        return false
      }))
  }
  return asked
}

const thrownChecks = new WeakMap<NavigationModel, Set<string>>()

function warnThrownCheck(ability: string, model: NavigationModel, error: unknown): void {
  const abilities = thrownChecks.get(model) ?? new Set<string>()
  thrownChecks.set(model, abilities)
  if (abilities.has(ability)) return
  abilities.add(ability)
  const reason = error instanceof Error ? error.message : String(error)
  console.warn(
    `[guren] The navigation check can('${ability}', ${model.name || 'an anonymous class'}) threw, so its entries are hidden: ${reason}. `
      + 'A guest is asked with a null user; a policy that reads the user needs a guard for that.',
  )
}

/** The entry whose path is the request's, else the longest that prefixes it by whole segments; `/` prefixes nothing. */
function currentIndex(paths: readonly string[], requestPath: string): number {
  const exact = paths.indexOf(requestPath)
  if (exact !== -1) return exact
  let best = -1
  for (const [index, path] of paths.entries()) {
    if (path === '/') continue
    const prefix = path.endsWith('/') ? path : `${path}/`
    if (requestPath.startsWith(prefix) && (best === -1 || path.length > paths[best]!.length)) best = index
  }
  return best
}
