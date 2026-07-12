import type { Context } from 'hono'

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

let resolver: SharedInertiaPropsResolver<ResolvedSharedInertiaProps> | null = null

export function setInertiaSharedProps<Props extends Record<string, unknown> = ResolvedSharedInertiaProps>(
  resolverFn: SharedInertiaPropsResolver<Props> | null,
): void {
  resolver = resolverFn as SharedInertiaPropsResolver<ResolvedSharedInertiaProps> | null
}

export function getInertiaSharedPropsResolver(): SharedInertiaPropsResolver<ResolvedSharedInertiaProps> | null {
  return resolver
}

/**
 * Register additional shared props without replacing resolvers registered
 * earlier — the new resolver's props are merged over the previous ones.
 * Use this from app providers so multiple providers can each contribute
 * shared props (setInertiaSharedProps replaces the resolver wholesale).
 */
export function shareInertiaProps<Props extends Record<string, unknown>>(
  resolverFn: SharedInertiaPropsResolver<Props>,
): void {
  const previous = resolver
  resolver = async (ctx) => {
    const prev = previous ? await previous(ctx) : ({} as ResolvedSharedInertiaProps)
    const next = await resolverFn(ctx)
    return { ...prev, ...next } as ResolvedSharedInertiaProps
  }
}

export async function resolveSharedInertiaProps(ctx: Context): Promise<ResolvedSharedInertiaProps> {
  if (!resolver) return {} as ResolvedSharedInertiaProps

  const shared = await resolver(ctx)
  if (shared && typeof shared === 'object') {
    return shared as ResolvedSharedInertiaProps
  }

  return {} as ResolvedSharedInertiaProps
}
