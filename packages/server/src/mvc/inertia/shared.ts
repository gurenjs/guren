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

export async function resolveSharedInertiaProps(ctx: Context): Promise<ResolvedSharedInertiaProps> {
  if (!resolver) return {} as ResolvedSharedInertiaProps

  const shared = await resolver(ctx)
  if (shared && typeof shared === 'object') {
    return shared as ResolvedSharedInertiaProps
  }

  return {} as ResolvedSharedInertiaProps
}
