import { getContainer } from '../container/Container'
import type { ServiceBindings } from '../container/bindings'

/**
 * Create a proxy-based facade that lazily resolves a service from the global container.
 *
 * The returned proxy intercepts all property access and method calls,
 * resolving the underlying service from the container on each access.
 * This ensures that container fakes and flushes are respected.
 *
 * Resolution is deferred until the first property access, so facades
 * can be imported at module level before the container is initialized.
 *
 * @example
 * ```typescript
 * import { Cache, Events } from '@guren/server/facades'
 *
 * // These calls resolve the service lazily from the container:
 * await Cache.get('key')
 * Events.emit('user.created', payload)
 * ```
 */
function createFacade<K extends keyof ServiceBindings>(key: K): ServiceBindings[K] {
  function resolveService(): ServiceBindings[K] {
    try {
      return getContainer().make(key)
    } catch (error) {
      throw new Error(
        `Facade "${key}" could not be resolved: ${error instanceof Error ? error.message : String(error)}. ` +
          `Ensure the container is initialized and the "${key}" service is registered.`
      )
    }
  }

  const proxy = new Proxy(Object.create(null) as object, {
    get(_target: object, prop: string | symbol, receiver: unknown): unknown {
      const service = resolveService()
      const value = Reflect.get(service as object, prop, receiver)

      if (typeof value === 'function') {
        return value.bind(service)
      }

      return value
    },

    set(_target: object, prop: string | symbol, value: unknown, receiver: unknown): boolean {
      const service = resolveService()
      return Reflect.set(service as object, prop, value, receiver)
    },

    has(_target: object, prop: string | symbol): boolean {
      try {
        const service = resolveService()
        return Reflect.has(service as object, prop)
      } catch {
        return false
      }
    },

    ownKeys(_target: object): Array<string | symbol> {
      try {
        const service = resolveService()
        return Reflect.ownKeys(service as object)
      } catch {
        return []
      }
    },

    getOwnPropertyDescriptor(
      _target: object,
      prop: string | symbol
    ): PropertyDescriptor | undefined {
      try {
        const service = resolveService()
        return Reflect.getOwnPropertyDescriptor(service as object, prop)
      } catch {
        return undefined
      }
    },
  })

  return proxy as ServiceBindings[K]
}

export const Cache = createFacade('cache')
export const Events = createFacade('events')
export const Queue = createFacade('queue')
export const Mail = createFacade('mail')
export const Log = createFacade('log')
export const I18n = createFacade('i18n')
export const Notifications = createFacade('notifications')
export const Broadcast = createFacade('broadcast')
export const Storage = createFacade('storage')
export const Scheduler = createFacade('scheduler')

export { createFacade }
