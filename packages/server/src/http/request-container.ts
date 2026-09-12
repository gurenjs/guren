import type { Container } from '../container/Container'

/**
 * Context variable the serving Application's container is stamped under
 * (RFC 0023 §2). The stamp is the first middleware `Application` mounts, so
 * nothing an app registers runs ahead of it. The one place a middleware
 * reaches its app's container without holding the app.
 */
export const CONTAINER_CONTEXT_KEY = 'guren.container'

declare module 'hono' {
  interface ContextVariableMap {
    [CONTAINER_CONTEXT_KEY]: Container
  }
}

/** The narrowest surface every Hono `Context` and `ContextVariableMap`-typed context satisfies. */
export interface RequestContextLike {
  get: (key: string) => unknown
}

/** The container of the Application serving `ctx`, or undefined off an Application (bare Hono). */
export function tryGetRequestContainer(ctx: RequestContextLike): Container | undefined {
  const container = ctx.get(CONTAINER_CONTEXT_KEY)
  return container ? (container as Container) : undefined
}

/** The container of the Application serving `ctx`; throws off an Application (bare Hono). */
export function getRequestContainer(ctx: RequestContextLike): Container {
  const container = tryGetRequestContainer(ctx)
  if (!container) {
    throw new Error(
      'No Application container on this request. The container is stamped by Application; ' +
      'a bare Hono app has none — pass the service explicitly there.',
    )
  }
  return container
}
