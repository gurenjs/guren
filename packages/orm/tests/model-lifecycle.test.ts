import { describe, expect, it } from 'bun:test'
import { Model, type ORMAdapter, type PlainObject } from '../src/Model'
import type { HookName, ModelHooks } from '../src/hooks'
import type { ModelObserver, ModelObserverConstructor } from '../src/ModelObserver'
import { SoftDeletes } from '../src/SoftDeletes'

const cases: { operation: 'create' | 'update' | 'delete'; before: HookName[]; after: HookName[] }[] = [
  { operation: 'create', before: ['creating', 'saving'], after: ['created', 'saved'] },
  { operation: 'update', before: ['updating', 'saving'], after: ['updated', 'saved'] },
  { operation: 'delete', before: ['deleting'], after: ['deleted'] },
]

function fixture() {
  const events: string[] = []
  const result = { id: 1, name: 'stored' }
  let failure: Error | undefined
  const write = () => {
    events.push('write')
    if (failure) throw failure
  }
  const adapter: ORMAdapter = {
    async findMany() { return [] },
    async findUnique() { return null },
    async create<T extends PlainObject>() { write(); return result as unknown as T },
    async update<T extends PlainObject>() { write(); return result as unknown as T },
    async delete() { write(); return 1 },
  }
  class User extends Model<{ id: number; name: string }> {
    static table = 'users'
    static hooks: ModelHooks = {}
    static observers: ModelObserver[] = []
    static accessors = {
      name: () => { events.push('read'); return 'visible' },
    }
  }
  User.useAdapter(adapter)
  const where = { id: 1 }
  const run = (operation: 'create' | 'update' | 'delete') => {
    if (operation === 'delete') return User.delete(where)
    if (operation === 'update') return User.update(where, { name: 'input' })
    return User.create({ name: 'input' })
  }
  return { User, events, result, where, run, fail: (error: Error) => { failure = error } }
}

for (const { operation, before, after } of cases) {
  describe(`Model ${operation} lifecycle`, () => {
    it('awaits hooks, then each observer per event, around persistence and read transforms', async () => {
      const { User, events, result, where, run } = fixture()
      let payload: PlainObject | undefined
      const expectData = (name: HookName, data: PlainObject) => {
        if (operation === 'delete') return expect(data).toBe(where)
        if (after.includes(name)) return expect(data).toBe(result)
        payload ??= data
        expect(data).toBe(payload)
        expect(data.name).toBe('input')
      }
      for (const name of [...before, ...after]) {
        User.hooks[name] = async (data) => {
          await Promise.resolve()
          events.push(`hook:${name}`)
          expectData(name, data)
        }
      }
      for (const label of ['first', 'second']) {
        const observer: ModelObserver = {}
        for (const name of [...before, ...after]) {
          observer[name] = async function (data) {
            await Promise.resolve()
            expect(this).toBe(observer)
            events.push(`${label}:${name}`)
            expectData(name, data)
          }
        }
        User.observers.push(observer)
      }
      await run(operation)
      expect(events).toEqual([
        ...before.map(name => `hook:${name}`),
        ...before.flatMap(name => [`first:${name}`, `second:${name}`]),
        'write',
        ...after.map(name => `hook:${name}`),
        ...after.flatMap(name => [`first:${name}`, `second:${name}`]),
        ...(operation === 'delete' ? [] : ['read']),
      ])
    })

    for (const source of ['hook', 'observer']) {
      for (const event of before) {
        it(`stops immediately when ${source} ${event} returns false`, async () => {
          const { User, events, run } = fixture()
          const register = (target: ModelHooks | ModelObserver, prefix: string) => {
            for (const name of [...before, ...after]) {
              target[name] = () => { events.push(`${prefix}:${name}`) }
            }
          }
          register(User.hooks, 'hook')
          const observer: ModelObserver = {}
          register(observer, 'observer')
          User.observers.push(observer)
          const target = source === 'hook' ? User.hooks : observer
          target[event] = async () => { events.push('abort'); return false as const }
          const message = source === 'hook'
            ? `User.${operation}() aborted by '${event}' hook.`
            : `User.${operation}() aborted by observer '${event}'.`
          await expect(run(operation)).rejects.toThrow(message)
          expect(events).toEqual([
            ...(source === 'observer' ? before.map(name => `hook:${name}`) : []),
            ...before.slice(0, before.indexOf(event)).map(name => `${source}:${name}`),
            'abort',
          ])
        })
      }
    }

    it('does not run after events when persistence fails', async () => {
      const { User, events, run, fail } = fixture()
      const observer: ModelObserver = {}
      for (const name of after) {
        User.hooks[name] = () => { events.push(`hook:${name}`) }
        observer[name] = () => { events.push(`observer:${name}`) }
      }
      User.observers.push(observer)
      const error = new Error('storage failed')
      fail(error)
      await expect(run(operation)).rejects.toBe(error)
      expect(events).toEqual(['write'])
    })

    it('propagates after-hook failures after writing and skips subsequent callbacks', async () => {
      const { User, events, run } = fixture()
      const error = new Error('after hook failed')
      const observer: ModelObserver = {}
      for (const name of after) {
        User.hooks[name] = () => { events.push(`hook:${name}`) }
        observer[name] = () => { events.push(`observer:${name}`) }
      }
      User.observers.push(observer)
      User.hooks[after[0]] = () => { throw error }
      await expect(run(operation)).rejects.toBe(error)
      expect(events).toEqual(['write'])
    })

    it('ignores false from an after hook and continues with observers', async () => {
      const { User, events, run } = fixture()
      User.hooks[after[0]] = () => false
      User.observers.push({ [after[0]]: () => { events.push('observer') } })
      await run(operation)
      expect(events).toEqual(['write', 'observer', ...(operation === 'delete' ? [] : ['read'])])
    })

    it('retains the hook and observer references captured before callbacks run', async () => {
      const { User, events, run } = fixture()
      User.hooks[before[0]] = () => {
        User.hooks = { [after[0]]: () => { events.push('replacement hook') } }
        User.clearObservers()
      }
      User.hooks[after[0]] = () => { events.push('original hook') }
      User.observers.push({ [after[0]]: () => { events.push('original observer') } })
      await run(operation)
      expect(events).toEqual(['write', 'original hook', 'original observer', ...(operation === 'delete' ? [] : ['read'])])
    })

    for (const prior of [0, 1]) {
      it(`applies observe() made inside a callback from the next write (${prior} prior observers)`, async () => {
        const { User, events, run } = fixture()
        for (let i = 0; i < prior; i++) User.observers.push({})
        class Late {}
        for (const name of [...before, ...after]) {
          Object.defineProperty(Late.prototype, name, { value: () => { events.push(`late:${name}`) } })
        }
        User.hooks[before[0]] = () => { User.observe(Late as ModelObserverConstructor) }
        const late = () => events.filter(event => event.startsWith('late:'))
        await run(operation)
        expect(late()).toEqual([])
        await run(operation)
        expect(late()).toEqual([...before, ...after].map(name => `late:${name}`))
      })
    }
  })
}

function softDeleteFixture(adapterOverrides: Partial<ORMAdapter> = {}) {
  const events: string[] = []
  const where = { id: 1 }
  const adapter: ORMAdapter = {
    async findMany() { return [] },
    async findUnique() { return null },
    async create<T extends PlainObject>() { return {} as T },
    async update<T extends PlainObject>() { events.push('write:update'); return {} as T },
    async delete() { events.push('write:delete'); return 1 },
    ...adapterOverrides,
  }
  class Watcher implements ModelObserver {
    deleting(data: PlainObject) { expect(data).toBe(where); events.push('observer:deleting') }
    deleted(data: PlainObject) { expect(data).toBe(where); events.push('observer:deleted') }
  }
  class Post extends SoftDeletes(Model<{ id: number; deletedAt: Date | null }>) {
    static table = 'posts'
    static hooks: ModelHooks = {
      deleting: (data) => { expect(data).toBe(where); events.push('hook:deleting') },
      deleted: (data) => { expect(data).toBe(where); events.push('hook:deleted') },
    }
  }
  Post.useAdapter(adapter)
  Post.observe(Watcher as ModelObserverConstructor)
  return { Post, Watcher, events, where }
}

describe('SoftDeletes delete lifecycle', () => {
  const around = (write: string) => ['hook:deleting', 'observer:deleting', write, 'hook:deleted', 'observer:deleted']

  it('runs deleting and deleted around a soft delete', async () => {
    const { Post, events, where } = softDeleteFixture()
    await Post.delete(where)
    expect(events).toEqual(around('write:update'))
  })

  it('runs deleting and deleted around forceDelete', async () => {
    const { Post, events, where } = softDeleteFixture()
    await Post.forceDelete(where)
    expect(events).toEqual(around('write:delete'))
  })

  it('stops a soft delete when deleting returns false', async () => {
    const { Post, events, where } = softDeleteFixture()
    Post.hooks.deleting = () => false
    await expect(Post.delete(where)).rejects.toThrow("Post.delete() aborted by 'deleting' hook.")
    expect(events).toEqual([])
  })

  it('names forceDelete when a hook or observer aborts it', async () => {
    const { Post, Watcher, events, where } = softDeleteFixture()
    Post.hooks.deleting = () => false
    await expect(Post.forceDelete(where)).rejects.toThrow("Post.forceDelete() aborted by 'deleting' hook.")
    delete Post.hooks.deleting
    Watcher.prototype.deleting = () => false
    await expect(Post.forceDelete(where)).rejects.toThrow("Post.forceDelete() aborted by observer 'deleting'.")
    expect(events).toEqual([])
  })

  it('fires no delete events on restore', async () => {
    const { Post, events, where } = softDeleteFixture()
    await Post.restore(where)
    expect(events).toEqual(['write:update'])
  })

  it('refuses a missing adapter capability before any event', async () => {
    const { Post, events, where } = softDeleteFixture({ update: undefined, delete: undefined })
    await expect(Post.delete(where)).rejects.toThrow('needed for soft delete')
    await expect(Post.forceDelete(where)).rejects.toThrow('does not support delete operations')
    expect(events).toEqual([])
  })

  it('refuses an unfiltered where before any event', async () => {
    const { Post, events } = softDeleteFixture()
    await expect(Post.delete({ id: undefined })).rejects.toThrow(/refusing to delete unfiltered/)
    await expect(Post.forceDelete({ id: undefined })).rejects.toThrow(/refusing to delete unfiltered/)
    expect(events).toEqual([])
  })
})
