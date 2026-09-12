import type { ServiceBindings } from './bindings'
import type { ContainerLike } from './types'

/**
 * The binding `container` holds under `key`, undefined when it holds none.
 * Prefers `makeOptional` where the container has it: `has()` sees neither a
 * fake nor a deferred provider, so a consumer spelling `has()` itself answers
 * differently from the same key resolved through the container (RFC 0023 §2).
 */
export function resolveOptional<K extends keyof ServiceBindings>(
  container: ContainerLike | null | undefined,
  key: K,
): ServiceBindings[K] | undefined
export function resolveOptional<T>(container: ContainerLike | null | undefined, key: string): T | undefined
export function resolveOptional(container: ContainerLike | null | undefined, key: string): unknown {
  if (!container) {
    return undefined
  }

  const optional = (container as { makeOptional?: (key: string) => unknown }).makeOptional
  if (typeof optional === 'function') {
    return optional.call(container, key)
  }

  return container.has?.(key) ? container.make(key) : undefined
}
