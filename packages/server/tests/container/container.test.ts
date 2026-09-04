import { describe, expect, it, beforeEach } from 'bun:test'
import {
  Container,
  createContainer,
  ServiceProvider,
  ProviderManager,
} from '../../src/container'

describe('Container', () => {
  let container: Container

  beforeEach(() => {
    container = new Container()
  })

  describe('bind', () => {
    it('should bind a factory', () => {
      container.bind('service', () => ({ name: 'test' }))

      expect(container.has('service')).toBe(true)
    })

    it('should create new instance each time', () => {
      container.bind('service', () => ({ value: Math.random() }))

      const instance1 = container.make('service')
      const instance2 = container.make('service')

      expect(instance1).not.toBe(instance2)
    })
  })

  describe('singleton', () => {
    it('should bind a singleton factory', () => {
      container.singleton('service', () => ({ name: 'test' }))

      expect(container.has('service')).toBe(true)
    })

    it('should return same instance each time', () => {
      container.singleton('service', () => ({ value: Math.random() }))

      const instance1 = container.make('service')
      const instance2 = container.make('service')

      expect(instance1).toBe(instance2)
    })
  })

  describe('instance', () => {
    it('should bind an existing instance', () => {
      const obj = { name: 'test' }
      container.instance('service', obj)

      expect(container.make<typeof obj>('service')).toBe(obj)
    })

    it('should return same instance each time', () => {
      const obj = { name: 'test' }
      container.instance('service', obj)

      const instance1 = container.make('service')
      const instance2 = container.make('service')

      expect(instance1).toBe(instance2)
      expect(instance1).toBe(obj)
    })
  })

  describe('make', () => {
    it('should resolve a bound service', () => {
      container.bind('greeting', () => 'Hello')

      expect(container.make<string>('greeting')).toBe('Hello')
    })

    it('should throw for unbound service', () => {
      expect(() => container.make('unknown')).toThrow(
        'Service "unknown" not found in container'
      )
    })

    it('should pass container to factory', () => {
      container.instance('config', { db: 'postgres' })
      container.bind('db', (c) => {
        const config = c.make<{ db: string }>('config')
        return { connection: config.db }
      })

      const db = container.make<{ connection: string }>('db')
      expect(db.connection).toBe('postgres')
    })
  })

  describe('makeWith', () => {
    it('should resolve with additional params', () => {
      container.bind('greeter', (c) => {
        const name = c.make<string>('name')
        return { greeting: `Hello, ${name}!` }
      })

      const result = container.makeWith<{ greeting: string }>('greeter', {
        name: 'World',
      })

      expect(result.greeting).toBe('Hello, World!')
    })
  })

  describe('has', () => {
    it('should return true for bound service', () => {
      container.bind('service', () => 'test')

      expect(container.has('service')).toBe(true)
    })

    it('should return false for unbound service', () => {
      expect(container.has('unknown')).toBe(false)
    })

    it('should resolve alias', () => {
      container.bind('service', () => 'test')
      container.alias('svc', 'service')

      expect(container.has('svc')).toBe(true)
    })
  })

  describe('alias', () => {
    it('should create an alias for a service', () => {
      container.bind('database', () => 'MySQL')
      container.alias('db', 'database')

      expect(container.make<string>('db')).toBe('MySQL')
    })

    it('should throw for self-referencing alias', () => {
      expect(() => container.alias('service', 'service')).toThrow(
        'Alias cannot be the same as the key'
      )
    })

    it('should resolve chained aliases', () => {
      container.bind('original', () => 'value')
      container.alias('alias1', 'original')
      container.alias('alias2', 'alias1')

      expect(container.make<string>('alias2')).toBe('value')
    })

    it('should detect circular aliases', () => {
      container.bind('service', () => 'test')
      container.alias('a', 'b')
      container.alias('b', 'a')

      expect(() => container.make('a')).toThrow('Circular alias detected')
    })
  })

  describe('tag', () => {
    it('should tag multiple services', () => {
      container.bind('cache.memory', () => ({ type: 'memory' }))
      container.bind('cache.redis', () => ({ type: 'redis' }))
      container.tag(['cache.memory', 'cache.redis'], 'cache')

      const tags = container.getTags()
      expect(tags.cache).toContain('cache.memory')
      expect(tags.cache).toContain('cache.redis')
    })
  })

  describe('tagged', () => {
    it('should resolve all services with tag', () => {
      container.bind('cache.memory', () => ({ type: 'memory' }))
      container.bind('cache.redis', () => ({ type: 'redis' }))
      container.tag(['cache.memory', 'cache.redis'], 'cache')

      const caches = container.tagged<{ type: string }>('cache')

      expect(caches).toHaveLength(2)
      expect(caches.map((c) => c.type).sort()).toEqual(['memory', 'redis'])
    })

    it('should return empty array for unknown tag', () => {
      expect(container.tagged('unknown')).toEqual([])
    })
  })

  describe('when (contextual binding)', () => {
    it('should provide contextual binding', () => {
      container.bind('logger', () => ({ type: 'default' }))

      container.bind('userService', (c) => ({
        logger: c.make<{ type: string }>('logger'),
      }))

      container.when('userService').needs('logger').give(() => ({ type: 'user' }))

      const userService = container.make<{ logger: { type: string } }>('userService')
      expect(userService.logger.type).toBe('user')
    })

    it('should accept value instead of factory', () => {
      container.bind('logger', () => ({ type: 'default' }))
      container.bind('service', (c) => ({
        logger: c.make<{ type: string }>('logger'),
      }))

      container.when('service').needs('logger').give({ type: 'custom' })

      const service = container.make<{ logger: { type: string } }>('service')
      expect(service.logger.type).toBe('custom')
    })
  })

  describe('scoped', () => {
    it('should cache services within scope', () => {
      let callCount = 0
      container.bind('service', () => {
        callCount++
        return { id: callCount }
      })

      container.scoped(() => {
        const s1 = container.make('service')
        const s2 = container.make('service')
        expect(s1).toBe(s2)
      })

      expect(callCount).toBe(1)
    })

    it('should not share instances across scopes', () => {
      container.bind('service', () => ({ id: Math.random() }))

      let instance1: unknown
      let instance2: unknown

      container.scoped(() => {
        instance1 = container.make('service')
      })

      container.scoped(() => {
        instance2 = container.make('service')
      })

      expect(instance1).not.toBe(instance2)
    })

    it('should not affect singletons', () => {
      container.singleton('service', () => ({ id: Math.random() }))

      let instance1: unknown
      let instance2: unknown

      container.scoped(() => {
        instance1 = container.make('service')
      })

      container.scoped(() => {
        instance2 = container.make('service')
      })

      expect(instance1).toBe(instance2)
    })
  })

  describe('scopedAsync', () => {
    it('should work with async operations', async () => {
      container.bind('service', () => ({ id: Math.random() }))

      let instance1: unknown
      let instance2: unknown

      await container.scopedAsync(async () => {
        instance1 = container.make('service')
        await new Promise((r) => setTimeout(r, 10))
        instance2 = container.make('service')
      })

      expect(instance1).toBe(instance2)
    })
  })

  describe('flush', () => {
    it('should clear singleton instances', () => {
      let callCount = 0
      container.singleton('service', () => {
        callCount++
        return { count: callCount }
      })

      container.make('service')
      container.flush()
      container.make('service')

      expect(callCount).toBe(2)
    })
  })

  describe('forget', () => {
    it('should remove a binding', () => {
      container.bind('service', () => 'test')
      container.forget('service')

      expect(container.has('service')).toBe(false)
    })
  })

  describe('getBindings', () => {
    it('should return all binding keys', () => {
      container.bind('service1', () => 'a')
      container.bind('service2', () => 'b')

      const bindings = container.getBindings()
      expect(bindings).toContain('service1')
      expect(bindings).toContain('service2')
    })
  })

  describe('getAliases', () => {
    it('should return all aliases', () => {
      container.alias('db', 'database')
      container.alias('log', 'logger')

      const aliases = container.getAliases()
      expect(aliases.db).toBe('database')
      expect(aliases.log).toBe('logger')
    })
  })
})

describe('ServiceProvider', () => {
  let container: Container

  beforeEach(() => {
    container = new Container()
  })

  it('should register services', async () => {
    class TestProvider extends ServiceProvider {
      register(): void {
        this.container.instance('test', 'value')
      }
    }

    const provider = new TestProvider(container)
    await provider.register()

    expect(container.make<string>('test')).toBe('value')
  })

  it('should boot after registration', async () => {
    const bootOrder: string[] = []

    class TestProvider extends ServiceProvider {
      register(): void {
        bootOrder.push('register')
      }

      boot(): void {
        bootOrder.push('boot')
      }
    }

    const provider = new TestProvider(container)
    await provider.register()
    await provider.boot?.()

    expect(bootOrder).toEqual(['register', 'boot'])
  })

  it('should support deferred providers', () => {
    class DeferredProvider extends ServiceProvider {
      static deferred = true
      static provides = ['deferred.service']

      register(): void {
        this.container.instance('deferred.service', 'deferred value')
      }
    }

    const provider = new DeferredProvider(container)
    expect(provider.isDeferred()).toBe(true)
    expect(provider.provides()).toEqual(['deferred.service'])
  })
})

describe('ProviderManager', () => {
  let container: Container
  let manager: ProviderManager

  beforeEach(() => {
    container = new Container()
    manager = new ProviderManager(container)
  })

  it('should register providers', () => {
    class TestProvider extends ServiceProvider {
      register(): void {
        this.container.instance('test', 'value')
      }
    }

    manager.register(TestProvider)

    expect(manager.getProviders()).toHaveLength(1)
  })

  it('should throw when a deferred provider declares no provided services', () => {
    class BrokenDeferredProvider extends ServiceProvider {
      static deferred = true

      register(): void {}
    }

    expect(() => manager.register(BrokenDeferredProvider)).toThrow(
      'must declare at least one service in "provides"',
    )
  })

  it('should register all providers', async () => {
    class Provider1 extends ServiceProvider {
      register(): void {
        this.container.instance('service1', 'value1')
      }
    }

    class Provider2 extends ServiceProvider {
      register(): void {
        this.container.instance('service2', 'value2')
      }
    }

    manager.registerMany([Provider1, Provider2])
    await manager.registerAll()

    expect(container.make<string>('service1')).toBe('value1')
    expect(container.make<string>('service2')).toBe('value2')
  })

  it('should boot all providers', async () => {
    const booted: string[] = []

    class Provider1 extends ServiceProvider {
      register(): void {}
      boot(): void {
        booted.push('provider1')
      }
    }

    class Provider2 extends ServiceProvider {
      register(): void {}
      boot(): void {
        booted.push('provider2')
      }
    }

    manager.registerMany([Provider1, Provider2])
    await manager.registerAll()
    await manager.bootAll()

    expect(booted).toEqual(['provider1', 'provider2'])
  })

  it('should handle deferred providers', async () => {
    class DeferredProvider extends ServiceProvider {
      static deferred = true
      static provides = ['deferred.service']

      register(): void {
        this.container.instance('deferred.service', 'deferred')
      }
    }

    manager.register(DeferredProvider)

    expect(manager.isDeferredService('deferred.service')).toBe(true)
    expect(manager.getDeferredServices()).toContain('deferred.service')

    await manager.loadDeferredProvider('deferred.service')

    expect(container.make<string>('deferred.service')).toBe('deferred')
    expect(manager.isDeferredService('deferred.service')).toBe(false)
  })

  describe('deferred providers through Container.make()', () => {
    it('should resolve a deferred service on first make() after boot', async () => {
      let registered = 0
      class LazyProvider extends ServiceProvider {
        static deferred = true
        static provides = ['lazy.service']

        register(): void {
          registered++
          this.container.singleton('lazy.service', () => ({ ready: true }))
        }
      }

      manager.register(LazyProvider)
      await manager.registerAll()
      await manager.bootAll()

      expect(registered).toBe(0)
      expect(container.make<{ ready: boolean }>('lazy.service')).toEqual({ ready: true })
      expect(registered).toBe(1)
      expect(manager.isDeferredService('lazy.service')).toBe(false)
    })

    it('should register the provider once when make() is called repeatedly', async () => {
      let registered = 0
      class LazyProvider extends ServiceProvider {
        static deferred = true
        static provides = ['lazy.a', 'lazy.b']

        register(): void {
          registered++
          this.container.instance('lazy.a', 'a')
          this.container.instance('lazy.b', 'b')
        }
      }

      manager.register(LazyProvider)
      await manager.bootAll()

      expect(container.make<string>('lazy.a')).toBe('a')
      expect(container.make<string>('lazy.b')).toBe('b')
      expect(container.make<string>('lazy.a')).toBe('a')
      expect(registered).toBe(1)
      expect(manager.getProviders()).toHaveLength(1)
    })

    it('should boot the provider after make() and settle loadDeferredProvider() on that boot', async () => {
      const order: string[] = []
      class LazyProvider extends ServiceProvider {
        static deferred = true
        static provides = ['lazy.service']

        register(): void {
          order.push('register')
          this.container.instance('lazy.service', 'value')
        }

        async boot(): Promise<void> {
          await Promise.resolve()
          order.push('boot')
        }
      }

      manager.register(LazyProvider)
      await manager.bootAll()

      expect(container.make<string>('lazy.service')).toBe('value')
      expect(order).toEqual(['register'])

      await manager.loadDeferredProvider('lazy.service')
      expect(order).toEqual(['register', 'boot'])
    })

    it('should surface a synchronous register() failure from make()', async () => {
      class BrokenProvider extends ServiceProvider {
        static deferred = true
        static provides = ['broken.service']

        register(): void {
          throw new Error('register exploded')
        }
      }

      manager.register(BrokenProvider)
      await manager.bootAll()

      expect(() => container.make('broken.service')).toThrow('register exploded')
    })

    it('should explain when a deferred register() binds asynchronously', async () => {
      class AsyncProvider extends ServiceProvider {
        static deferred = true
        static provides = ['async.service']

        async register(): Promise<void> {
          await Promise.resolve()
          this.container.instance('async.service', 'late')
        }
      }

      manager.register(AsyncProvider)
      await manager.bootAll()

      expect(() => container.make('async.service')).toThrow(
        /did not bind "async.service" synchronously/,
      )
    })

    it('should still throw not-found for a service no deferred provider claims', async () => {
      class LazyProvider extends ServiceProvider {
        static deferred = true
        static provides = ['lazy.service']

        register(): void {
          this.container.instance('lazy.service', 'value')
        }
      }

      manager.register(LazyProvider)
      await manager.bootAll()

      expect(() => container.make('other.service')).toThrow(
        'Service "other.service" not found in container',
      )
    })
  })

  it('should only register providers once', async () => {
    let registerCount = 0

    class TestProvider extends ServiceProvider {
      register(): void {
        registerCount++
      }
    }

    manager.register(TestProvider)
    await manager.registerAll()
    await manager.registerAll()

    expect(registerCount).toBe(1)
  })

  it('should only boot providers once', async () => {
    let bootCount = 0

    class TestProvider extends ServiceProvider {
      register(): void {}
      boot(): void {
        bootCount++
      }
    }

    manager.register(TestProvider)
    await manager.registerAll()
    await manager.bootAll()
    await manager.bootAll()

    expect(bootCount).toBe(1)
  })
})
