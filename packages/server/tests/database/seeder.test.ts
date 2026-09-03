import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  BaseSeeder,
  resetCalledSeeders,
  BaseFactory,
  defineFactory,
  createSeederRunner,
} from '../../src/database'

describe('Seeder', () => {
  beforeEach(() => {
    resetCalledSeeders()
  })

  describe('BaseSeeder', () => {
    it('runs seeder', async () => {
      const runFn = vi.fn()

      class TestSeeder extends BaseSeeder {
        async run() {
          runFn()
        }
      }

      const seeder = new TestSeeder()
      await seeder.run()

      expect(runFn).toHaveBeenCalledOnce()
    })

    it('calls another seeder', async () => {
      const childRunFn = vi.fn()

      class ChildSeeder extends BaseSeeder {
        async run() {
          childRunFn()
        }
      }

      class ParentSeeder extends BaseSeeder {
        async run() {
          await this.call(ChildSeeder)
        }
      }

      const seeder = new ParentSeeder()
      await seeder.run()

      expect(childRunFn).toHaveBeenCalledOnce()
    })

    it('calls seeder only once with callOnce', async () => {
      const childRunFn = vi.fn()

      class ChildSeeder extends BaseSeeder {
        async run() {
          childRunFn()
        }
      }

      class ParentSeeder extends BaseSeeder {
        async run() {
          await this.callOnce(ChildSeeder)
          await this.callOnce(ChildSeeder)
          await this.callOnce(ChildSeeder)
        }
      }

      const seeder = new ParentSeeder()
      await seeder.run()

      expect(childRunFn).toHaveBeenCalledOnce()
    })

    it('calls multiple seeders with callMany', async () => {
      const results: string[] = []

      class Seeder1 extends BaseSeeder {
        async run() {
          results.push('seeder1')
        }
      }

      class Seeder2 extends BaseSeeder {
        async run() {
          results.push('seeder2')
        }
      }

      class ParentSeeder extends BaseSeeder {
        async run() {
          await this.callMany([Seeder1, Seeder2])
        }
      }

      const seeder = new ParentSeeder()
      await seeder.run()

      expect(results).toEqual(['seeder1', 'seeder2'])
    })

    it('calls seeders in parallel with callParallel', async () => {
      const results: string[] = []

      class Seeder1 extends BaseSeeder {
        async run() {
          await new Promise((r) => setTimeout(r, 10))
          results.push('seeder1')
        }
      }

      class Seeder2 extends BaseSeeder {
        async run() {
          results.push('seeder2')
        }
      }

      class ParentSeeder extends BaseSeeder {
        async run() {
          await this.callParallel([Seeder1, Seeder2])
        }
      }

      const seeder = new ParentSeeder()
      await seeder.run()

      // Seeder2 should complete first since Seeder1 has delay
      expect(results).toContain('seeder1')
      expect(results).toContain('seeder2')
    })
  })

  describe('resetCalledSeeders', () => {
    it('resets called seeders tracking', async () => {
      const runFn = vi.fn()

      class TestSeeder extends BaseSeeder {
        async run() {
          runFn()
        }
      }

      class ParentSeeder extends BaseSeeder {
        async run() {
          await this.callOnce(TestSeeder)
        }
      }

      const seeder = new ParentSeeder()
      await seeder.run()
      expect(runFn).toHaveBeenCalledTimes(1)

      // Reset and run again
      resetCalledSeeders()
      await seeder.run()
      expect(runFn).toHaveBeenCalledTimes(2)
    })
  })
})

describe('Factory', () => {
  interface User {
    id: number
    name: string
    email: string
    role: string
    active: boolean
  }

  class UserFactory extends BaseFactory<User> {
    definition(): Partial<User> {
      return {
        id: this.sequence,
        name: `User ${this.sequence}`,
        email: `user${this.sequence}@example.com`,
        role: 'user',
        active: true,
      }
    }
  }

  describe('make', () => {
    it('creates instance with default values', () => {
      const factory = new UserFactory()
      const user = factory.make()

      expect(user.id).toBe(1)
      expect(user.name).toBe('User 1')
      expect(user.email).toBe('user1@example.com')
      expect(user.role).toBe('user')
    })

    it('increments sequence', () => {
      const factory = new UserFactory()

      const user1 = factory.make()
      const user2 = factory.make()

      expect(user1.id).toBe(1)
      expect(user2.id).toBe(2)
    })

    it('applies overrides', () => {
      const factory = new UserFactory()
      const user = factory.make({ name: 'John Doe', role: 'admin' })

      expect(user.name).toBe('John Doe')
      expect(user.role).toBe('admin')
      expect(user.email).toBe('user1@example.com') // Default
    })
  })

  describe('makeMany', () => {
    it('creates multiple instances', () => {
      const factory = new UserFactory()
      const users = factory.makeMany(3)

      expect(users).toHaveLength(3)
      expect(users[0].id).toBe(1)
      expect(users[1].id).toBe(2)
      expect(users[2].id).toBe(3)
    })

    it('applies overrides to all instances', () => {
      const factory = new UserFactory()
      const users = factory.makeMany(2, { role: 'admin' })

      expect(users[0].role).toBe('admin')
      expect(users[1].role).toBe('admin')
    })
  })

  describe('states', () => {
    it('defines and applies state', () => {
      const factory = new UserFactory()
      factory.state('admin', { role: 'admin' })

      const user = factory.withState('admin').make()

      expect(user.role).toBe('admin')
    })

    it('applies multiple states', () => {
      const factory = new UserFactory()
      factory.state('admin', { role: 'admin' })
      factory.state('inactive', { active: false })

      const user = factory.withStates('admin', 'inactive').make()

      expect(user.role).toBe('admin')
      expect(user.active).toBe(false)
    })

    it('supports function states', () => {
      const factory = new UserFactory()
      factory.state('superuser', (attrs) => ({
        name: `Super ${attrs.name}`,
        role: 'superuser',
      }))

      const user = factory.withState('superuser').make()

      expect(user.name).toBe('Super User 1')
      expect(user.role).toBe('superuser')
    })

    it('throws for undefined state', () => {
      const factory = new UserFactory()

      expect(() => factory.withState('unknown')).toThrow('State "unknown" is not defined')
    })
  })

  describe('create', () => {
    it('calls persist method', async () => {
      const persistFn = vi.fn().mockImplementation((attrs: Partial<User>) => ({
        ...attrs,
        savedAt: new Date(),
      }))

      class PersistingFactory extends BaseFactory<User> {
        definition(): Partial<User> {
          return { id: this.sequence, name: `User ${this.sequence}` }
        }

        protected async persist(attributes: Partial<User>): Promise<User> {
          return persistFn(attributes)
        }
      }

      const factory = new PersistingFactory()
      const user = await factory.create()

      expect(persistFn).toHaveBeenCalledOnce()
      expect(user.id).toBe(1)
    })

    it('createMany creates multiple instances', async () => {
      const persistFn = vi.fn().mockImplementation((attrs: Partial<User>) => attrs)

      class PersistingFactory extends BaseFactory<User> {
        definition(): Partial<User> {
          return { id: this.sequence, name: `User ${this.sequence}` }
        }

        protected async persist(attributes: Partial<User>): Promise<User> {
          return persistFn(attributes) as User
        }
      }

      const factory = new PersistingFactory()
      const users = await factory.createMany(3)

      expect(persistFn).toHaveBeenCalledTimes(3)
      expect(users).toHaveLength(3)
    })
  })

  describe('callbacks', () => {
    it('runs afterMaking callback', () => {
      const callback = vi.fn()
      const factory = new UserFactory()

      factory.afterMaking(callback)
      factory.make()

      expect(callback).toHaveBeenCalledOnce()
    })

    it('runs afterCreating callback', async () => {
      const callback = vi.fn()

      class TestFactory extends BaseFactory<User> {
        definition(): Partial<User> {
          return { id: this.sequence }
        }
      }

      const factory = new TestFactory()
      factory.afterCreating(callback)
      await factory.create()

      expect(callback).toHaveBeenCalledOnce()
    })
  })

  describe('utility methods', () => {
    it('resetSequence resets counter', () => {
      const factory = new UserFactory()

      factory.make()
      factory.make()
      expect(factory.make().id).toBe(3)

      factory.resetSequence()
      expect(factory.make().id).toBe(1)
    })

    it('clearStates removes active states', () => {
      const factory = new UserFactory()
      factory.state('admin', { role: 'admin' })

      factory.withState('admin')
      factory.clearStates()

      const user = factory.make()
      expect(user.role).toBe('user') // Default
    })

    it('fresh creates new instance', () => {
      const factory = new UserFactory()
      factory.make()
      factory.make()

      const fresh = factory.fresh()
      expect(fresh.make().id).toBe(1) // Reset sequence
    })
  })

  describe('defineFactory helper', () => {
    it('creates inline factory', () => {
      const factory = defineFactory<User>((seq) => ({
        id: seq,
        name: `User ${seq}`,
        email: `user${seq}@example.com`,
      }))

      const user = factory.make()

      expect(user.id).toBe(1)
      expect(user.name).toBe('User 1')
    })

    it('supports custom persist function', async () => {
      const persist = vi.fn().mockImplementation((attrs: Partial<User>) => ({ ...attrs, saved: true }))

      const factory = defineFactory<User>(
        (seq) => ({ id: seq, name: `User ${seq}` }),
        persist
      )

      const user = await factory.create()

      expect(persist).toHaveBeenCalledOnce()
      expect((user as User & { saved: boolean }).saved).toBe(true)
    })
  })
})

describe('SeederRunner', () => {
  beforeEach(() => {
    resetCalledSeeders()
    // Reset NODE_ENV
    delete process.env.NODE_ENV
  })

  describe('register', () => {
    it('registers seeder classes', async () => {
      const runner = createSeederRunner({ silent: true })

      class TestSeeder extends BaseSeeder {
        async run() {}
      }

      runner.register('TestSeeder', TestSeeder)

      // Verify by running
      await expect(runner.run('TestSeeder')).resolves.toBeUndefined()
    })

    it('registers multiple seeders', async () => {
      const runner = createSeederRunner({ silent: true })

      class Seeder1 extends BaseSeeder {
        async run() {}
      }

      class Seeder2 extends BaseSeeder {
        async run() {}
      }

      runner.registerMany({
        Seeder1,
        Seeder2,
      })

      await expect(runner.run('Seeder1')).resolves.toBeUndefined()
      await expect(runner.run('Seeder2')).resolves.toBeUndefined()
    })
  })

  describe('run', () => {
    it('runs registered seeder by name', async () => {
      const runFn = vi.fn()

      class TestSeeder extends BaseSeeder {
        async run() {
          runFn()
        }
      }

      const runner = createSeederRunner({ silent: true })
      runner.register('TestSeeder', TestSeeder)

      await runner.run('TestSeeder')

      expect(runFn).toHaveBeenCalledOnce()
    })

    it('runs seeder class directly', async () => {
      const runFn = vi.fn()

      class TestSeeder extends BaseSeeder {
        async run() {
          runFn()
        }
      }

      const runner = createSeederRunner({ silent: true })
      await runner.run(TestSeeder)

      expect(runFn).toHaveBeenCalledOnce()
    })

    it('refuses to run in production without force', async () => {
      process.env.NODE_ENV = 'production'

      class TestSeeder extends BaseSeeder {
        async run() {}
      }

      const runner = createSeederRunner({ silent: true })

      await expect(runner.run(TestSeeder)).rejects.toThrow(
        'Refusing to run seeders in production'
      )
    })

    it('runs in production with force', async () => {
      process.env.NODE_ENV = 'production'
      const runFn = vi.fn()

      class TestSeeder extends BaseSeeder {
        async run() {
          runFn()
        }
      }

      const runner = createSeederRunner({ force: true, silent: true })
      await runner.run(TestSeeder)

      expect(runFn).toHaveBeenCalledOnce()
    })
  })

  describe('runMany', () => {
    it('runs multiple seeders in sequence', async () => {
      const results: string[] = []

      class Seeder1 extends BaseSeeder {
        async run() {
          results.push('seeder1')
        }
      }

      class Seeder2 extends BaseSeeder {
        async run() {
          results.push('seeder2')
        }
      }

      const runner = createSeederRunner({ silent: true })
      runner.registerMany({ Seeder1, Seeder2 })

      await runner.runMany(['Seeder1', 'Seeder2'])

      expect(results).toEqual(['seeder1', 'seeder2'])
    })
  })
})
