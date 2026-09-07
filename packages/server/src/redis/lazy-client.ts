import { isPromiseLike } from '../logging/Logger'

/**
 * The one rule for a `client` option that may be an ioredis instance or a
 * function returning one: the function runs here, not where the config object
 * was declared, so a declared-but-unselected store never dials. Cache and
 * session both resolve through it — a second copy is how the two subsystems
 * come to disagree about what `client` accepts.
 */
export function resolveLazyRedisClient(client: unknown, label: string): unknown {
  const resolved = typeof client === 'function' ? (client as () => unknown)() : client

  if (isPromiseLike(resolved)) {
    throw new Error(
      `${label}: \`client\` returned a Promise. Return the ioredis client synchronously; it connects lazily on first use.`,
    )
  }

  return resolved
}
