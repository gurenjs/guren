/**
 * Prop evaluation for the Inertia protocol's partial reloads and deferred
 * props (https://inertiajs.com/the-protocol, "Prop Evaluation Model").
 * `@guren/testing`'s controller mock resolves through the same function, so a
 * test cannot pass on a prop set production would not send.
 */

const DEFERRED_BRAND = Symbol.for('guren.inertia.deferred')

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
export function defer<T>(resolve: () => T, group = 'default'): DeferredProp<Awaited<T>> {
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

/**
 * A header list as its top-level prop names: `author.name` selects `author`.
 * The prototype client (`@guren/inertia-client/prototype`) answers a fixture
 * with the same rule; the two cannot import each other, so keep them in step.
 */
function propNames(value: string | null): Set<string> {
  const names = (value ?? '').split(',').map((item) => item.trim().split('.')[0])
  return new Set(names.filter((name): name is string => Boolean(name)))
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
 * Starts one prop's value. Through a promise so a resolver that throws
 * synchronously rejects like one that throws later: `Promise.all` then settles
 * every sibling rather than leaving the ones already started unhandled.
 */
function startProp(value: unknown): Promise<unknown> {
  return Promise.resolve().then(() =>
    isDeferredProp(value) ? value.resolve() : (value as () => unknown)(),
  )
}

/**
 * The props a response carries under the protocol's evaluation rules: a full
 * visit resolves every prop but the deferred ones, which it announces; a
 * partial reload resolves only the selected props, deferred ones included, and
 * announces nothing; a lazy prop (a function value) runs only when sent.
 * Resolvers run concurrently, unlike Laravel's.
 */
export async function resolveInertiaProps(
  input: Record<string, unknown>,
  partial: PartialReload | undefined,
): Promise<ResolvedInertiaPage> {
  const props: Record<string, unknown> = {}
  const deferredProps: Record<string, string[]> = {}
  const pending: Promise<void>[] = []

  for (const [key, value] of Object.entries(input)) {
    const deferred = isDeferredProp(value)
    if (partial) {
      if (!isSelected(key, partial)) continue
    } else if (deferred) {
      ;(deferredProps[value.group] ??= []).push(key)
      continue
    }
    if (deferred || typeof value === 'function') {
      // The key is claimed now so the props keep their declared order.
      props[key] = undefined
      pending.push(startProp(value).then((resolved) => { props[key] = resolved }))
    } else {
      props[key] = value
    }
  }

  if (pending.length > 0) await Promise.all(pending)
  return Object.keys(deferredProps).length > 0 ? { props, deferredProps } : { props }
}
