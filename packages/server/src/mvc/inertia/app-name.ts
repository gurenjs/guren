import type { ContainerLike } from '../../container/types'

/** The `app` shared prop: the application's name, from the `APP_NAME` key of `createApp({ env })` (RFC 0040 §5). */
export interface AppSharedProp {
  readonly name: string
}

/**
 * `{ app: { name } }` once the validated environment holds a non-empty `APP_NAME`, else nothing.
 * Read on each request, since `env` is bound at boot, after the app registers this resolver.
 */
export function appNameSharedProps(container: ContainerLike): { app?: AppSharedProp } {
  if (!container.has?.('env')) return {}
  const name = (container.make('env') as Record<string, unknown>).APP_NAME
  return typeof name === 'string' && name.trim() !== '' ? { app: { name } } : {}
}
