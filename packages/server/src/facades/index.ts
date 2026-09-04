import type { Container } from '../container/Container'
import type { ServiceBindings } from '../container/bindings'

/**
 * A proxy that re-resolves `key` from the container on every access, so
 * container fakes and flushes are respected.
 */
export function createFacade<K extends keyof ServiceBindings>(
  container: Pick<Container, 'make'>,
  key: K,
): ServiceBindings[K] {
  function resolveService(): ServiceBindings[K] {
    try {
      return container.make(key)
    } catch (error) {
      throw new Error(
        `Facade "${key}" could not be resolved: ${error instanceof Error ? error.message : String(error)}. ` +
          `Ensure the "${key}" service is registered in the active application container.`
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

export function createFacades(container: Pick<Container, 'make'>) {
  return {
    Cache: createFacade(container, 'cache'),
    Events: createFacade(container, 'events'),
    Queue: createFacade(container, 'queue'),
    Mail: createFacade(container, 'mail'),
    Log: createFacade(container, 'log'),
    I18n: createFacade(container, 'i18n'),
    Notifications: createFacade(container, 'notifications'),
    Broadcast: createFacade(container, 'broadcast'),
    Storage: createFacade(container, 'storage'),
    Scheduler: createFacade(container, 'scheduler'),
  } as const
}
