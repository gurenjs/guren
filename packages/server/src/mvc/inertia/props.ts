/**
 * Prop evaluation for the Inertia protocol's partial reloads and deferred
 * props (https://inertiajs.com/the-protocol, "Prop Evaluation Model").
 * `@guren/testing`'s controller mock resolves through the same function, so a
 * test cannot pass on a prop set production would not send.
 */

const DEFERRED_BRAND = Symbol.for('guren.inertia.deferred')

/** The group a `defer()` call without one joins; the client fetches one group per request. */
export const DEFAULT_DEFERRED_GROUP = 'default'

/**
 * Props sent on every response, partial reloads included, whatever the
 * `only`/`except` lists say. `errors` is the protocol's own always prop.
 */
const ALWAYS_PROPS: ReadonlySet<string> = new Set(['errors'])

export interface DeferredProp<T> {
  readonly [DEFERRED_BRAND]: true
  readonly resolve: () => T | Promise<T>
  readonly group: string
}

/**
 * A prop resolved in a follow-up request rather than the initial visit
 * (Laravel's `Inertia::defer()`). The initial response announces the key under
 * `deferredProps[group]` and the client fetches each group with one partial
 * reload; `resolve` runs only on the request that asks for the key.
 */
export function defer<T>(resolve: () => T, group: string = DEFAULT_DEFERRED_GROUP): DeferredProp<Awaited<T>> {
  return Object.freeze({
    [DEFERRED_BRAND]: true as const,
    resolve: resolve as () => Awaited<T> | Promise<Awaited<T>>,
    group,
  })
}

export function isDeferredProp(value: unknown): value is DeferredProp<unknown> {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[DEFERRED_BRAND] === true
}

/** What a controller may pass for a prop the page declares as `T`. */
export type InertiaPropInput<T> = T | DeferredProp<T> | (() => T | Promise<T>)

export type InertiaPropsInput<Props> = { [K in keyof Props]: InertiaPropInput<Props[K]> }

/** The value the page receives for one prop input: a deferred or lazy prop as its resolved type. */
export type ResolvedInertiaProp<V> = V extends DeferredProp<unknown>
  ? Awaited<ReturnType<V['resolve']>>
  : V extends () => infer R
    ? Awaited<R>
    : V

export type ResolvedInertiaProps<Props> = { [K in keyof Props]: ResolvedInertiaProp<Props[K]> }

export interface PartialReload {
  /** Top-level prop names listed in `X-Inertia-Partial-Data`; empty means every prop. */
  readonly only: ReadonlySet<string>
  readonly except: ReadonlySet<string>
}

export interface ResolvedInertiaPage {
  readonly props: Record<string, unknown>
  /** Present on a full visit that carried at least one deferred prop. */
  readonly deferredProps?: Record<string, string[]>
}

/** A header list as its top-level prop names: `author.name` selects `author`. */
function propNames(value: string | null): Set<string> {
  const items = value ? value.split(',').map((item) => item.trim()).filter(Boolean) : []
  return new Set(items.map((item) => item.split('.')[0]!))
}

/**
 * The partial reload a request asks for, or undefined for a full visit. A
 * partial reload is an Inertia request whose `X-Inertia-Partial-Component`
 * names the component being rendered; a different component (the visit was
 * redirected elsewhere) is a full visit again.
 */
export function readPartialReload(request: Request | undefined, component: string): PartialReload | undefined {
  if (!request?.headers.get('X-Inertia')) return undefined
  if (request.headers.get('X-Inertia-Partial-Component') !== component) return undefined
  return {
    only: propNames(request.headers.get('X-Inertia-Partial-Data')),
    except: propNames(request.headers.get('X-Inertia-Partial-Except')),
  }
}

function isSelected(key: string, partial: PartialReload): boolean {
  if (ALWAYS_PROPS.has(key)) return true
  if (partial.only.size > 0 && !partial.only.has(key)) return false
  return !partial.except.has(key)
}

/**
 * The props a response carries, with the protocol's evaluation rules applied.
 * A full visit resolves every regular and lazy prop and announces deferred
 * ones without resolving them; a partial reload resolves only the selected
 * props, deferred ones included, and announces nothing. A lazy prop (a function
 * value) is called only when its key is sent.
 */
export async function resolveInertiaProps(
  props: Record<string, unknown>,
  partial: PartialReload | undefined,
): Promise<ResolvedInertiaPage> {
  const deferredProps: Record<string, string[]> = {}
  // Resolvers start in key order and settle together: one response, N
  // independent queries, deliberately concurrent rather than Laravel's sequence.
  const pending: Array<[string, unknown]> = []

  for (const [key, value] of Object.entries(props)) {
    if (partial) {
      if (!isSelected(key, partial)) continue
    } else if (isDeferredProp(value)) {
      ;(deferredProps[value.group] ??= []).push(key)
      continue
    }
    pending.push([key, isDeferredProp(value) ? value.resolve() : typeof value === 'function' ? value() : value])
  }

  const resolved = await Promise.all(pending.map(async ([key, value]) => [key, await value] as const))
  const page: { props: Record<string, unknown>; deferredProps?: Record<string, string[]> } = {
    props: Object.fromEntries(resolved),
  }
  if (Object.keys(deferredProps).length > 0) page.deferredProps = deferredProps
  return page
}
