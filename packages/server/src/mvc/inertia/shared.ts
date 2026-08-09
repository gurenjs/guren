import type { Context } from 'hono'
import type { ContainerLike } from '../../container/types'

/**
 * Application-level shared props shape for Inertia responses.
 * Extend this interface in your app (via declaration merging) to type shared props.
 */
export interface InertiaSharedProps { }

type SharedPropsDefault = Record<string, unknown>
export type ResolvedSharedInertiaProps = InertiaSharedProps extends Record<string, unknown> ? InertiaSharedProps : SharedPropsDefault

export type SharedInertiaPropsResolver<Props extends Record<string, unknown> = ResolvedSharedInertiaProps> = (
  ctx: Context,
) => Promise<Props> | Props

/**
 * Container able to own a scoped registry. `Container` satisfies this; the
 * read-only {@link ContainerLike} does not, so a partial container cannot
 * silently register app props into the module-global registry.
 */
export interface SharedPropsContainer extends ContainerLike {
  has(key: string): boolean
  instance(key: string, value: unknown): unknown
}

/** Container binding key for the scoped {@link SharedInertiaPropsRegistry}. */
export const INERTIA_SHARED_PROPS_BINDING = 'inertia.sharedProps'

/**
 * Registrations are numbered from one process-wide counter so that props keep
 * resolving in registration order — later registrations win on conflicting
 * keys — no matter which registry each one landed in.
 */
let registrationSequence = 0

interface OrderedResolver {
  seq: number
  resolve: SharedInertiaPropsResolver<ResolvedSharedInertiaProps>
}

/**
 * Holds the shared-props resolvers for one scope: either a single
 * Application's container or the module-global fallback for bare-Hono apps.
 */
export class SharedInertiaPropsRegistry {
  private resolvers: OrderedResolver[] = []

  /** Replace every resolver registered in this scope. */
  set<Props extends Record<string, unknown> = ResolvedSharedInertiaProps>(
    resolverFn: SharedInertiaPropsResolver<Props> | null,
  ): void {
    this.resolvers = resolverFn ? [orderedResolver(resolverFn)] : []
  }

  /**
   * Register additional shared props without replacing resolvers registered
   * earlier — the new resolver's props are merged over the previous ones.
   */
  share<Props extends Record<string, unknown>>(resolverFn: SharedInertiaPropsResolver<Props>): void {
    this.resolvers.push(orderedResolver(resolverFn))
  }

  /** The resolvers registered in this scope, ordered by registration. */
  entries(): readonly OrderedResolver[] {
    return this.resolvers
  }

  /**
   * The scope's registrations composed into one resolver, or null when empty.
   * The composition is a snapshot: resolvers registered later are not picked up.
   */
  get(): SharedInertiaPropsResolver<ResolvedSharedInertiaProps> | null {
    if (this.resolvers.length === 0) return null
    if (this.resolvers.length === 1) return this.resolvers[0]!.resolve

    const snapshot = [...this.resolvers]
    return (ctx) => applyResolvers(snapshot, ctx)
  }

  async resolve(ctx: Context): Promise<ResolvedSharedInertiaProps> {
    return applyResolvers(this.resolvers, ctx)
  }
}

function orderedResolver<Props extends Record<string, unknown>>(
  resolverFn: SharedInertiaPropsResolver<Props>,
): OrderedResolver {
  return {
    seq: registrationSequence++,
    resolve: resolverFn as SharedInertiaPropsResolver<ResolvedSharedInertiaProps>,
  }
}

async function applyResolvers(
  entries: readonly OrderedResolver[],
  ctx: Context,
): Promise<ResolvedSharedInertiaProps> {
  const merged: Record<string, unknown> = {}

  for (const entry of entries) {
    const props = await entry.resolve(ctx)
    if (props && typeof props === 'object') {
      Object.assign(merged, props)
    }
  }

  return merged as ResolvedSharedInertiaProps
}

// Module-global fallback registry, for bare-Hono apps and any provider that
// registers without a container. Framework providers register on the
// container-scoped registry so two Application instances booted in one process
// (test suites, serverless warm reuse) don't cross-contaminate.
const globalRegistry = new SharedInertiaPropsRegistry()

/** The registry bound to `container`, or null when it owns none yet. */
function scopedRegistry(container?: ContainerLike | null): SharedInertiaPropsRegistry | null {
  if (!container?.has?.(INERTIA_SHARED_PROPS_BINDING)) return null
  return container.make(INERTIA_SHARED_PROPS_BINDING) as SharedInertiaPropsRegistry
}

/**
 * The shared-props registry scoped to `container`, binding a fresh one on
 * first use.
 */
export function ensureSharedInertiaPropsRegistry(container: SharedPropsContainer): SharedInertiaPropsRegistry {
  const existing = scopedRegistry(container)
  if (existing) return existing

  const registry = new SharedInertiaPropsRegistry()
  container.instance(INERTIA_SHARED_PROPS_BINDING, registry)
  return registry
}

/**
 * Replace the module-global shared props resolver. Props registered on an
 * application's container (see {@link shareInertiaProps}) are unaffected.
 */
export function setInertiaSharedProps<Props extends Record<string, unknown> = ResolvedSharedInertiaProps>(
  resolverFn: SharedInertiaPropsResolver<Props> | null,
): void {
  globalRegistry.set(resolverFn)
}

/**
 * The module-global registrations composed into one resolver, for manual
 * composition. Container-scoped props are not included — get those from
 * `ensureSharedInertiaPropsRegistry(container).get()`.
 */
export function getInertiaSharedPropsResolver(): SharedInertiaPropsResolver<ResolvedSharedInertiaProps> | null {
  return globalRegistry.get()
}

/**
 * Register additional shared props without replacing resolvers registered
 * earlier — the new resolver's props are merged over the previous ones.
 * Use this from app providers so multiple providers can each contribute
 * shared props (setInertiaSharedProps replaces the resolver wholesale).
 *
 * Pass the provider's `this.container` to scope the props to one application.
 * Without it the props are module-global, so a second Application booted in
 * the same process shares them.
 *
 * @example
 * ```typescript
 * export class AuthProvider extends ServiceProvider {
 *   boot(): void {
 *     shareInertiaProps(async (ctx) => ({ auth: { user: await currentUser(ctx) } }), this.container)
 *   }
 * }
 * ```
 */
export function shareInertiaProps<Props extends Record<string, unknown>>(
  resolverFn: SharedInertiaPropsResolver<Props>,
  container?: SharedPropsContainer,
): void {
  const registry = container ? ensureSharedInertiaPropsRegistry(container) : globalRegistry
  registry.share(resolverFn)
}

/**
 * Resolve shared props for a request, merging the module-global registrations
 * with those scoped to `container` in registration order.
 */
export async function resolveSharedInertiaProps(
  ctx: Context,
  container?: ContainerLike | null,
): Promise<ResolvedSharedInertiaProps> {
  const scoped = scopedRegistry(container)
  if (!scoped) return globalRegistry.resolve(ctx)

  const globalEntries = globalRegistry.entries()
  if (globalEntries.length === 0) return scoped.resolve(ctx)

  const ordered = [...globalEntries, ...scoped.entries()].sort((a, b) => a.seq - b.seq)
  return applyResolvers(ordered, ctx)
}
