import { describe, it, expect } from 'bun:test'
import { Model, type PlainObject } from '../src/Model'
import { MassAssignmentException } from '../src/MassAssignmentException'

class DefaultModel extends Model<PlainObject> {
  static override table = {} as unknown
}

class FillableModel extends Model<PlainObject> {
  static override table = {} as unknown
  static fillable = ['title', 'body']
}

abstract class DeniesPasswordHash extends Model<PlainObject> {
  protected static override deniedFields(): string[] {
    return ['passwordHash']
  }
}

class DeniedModel extends DeniesPasswordHash {
  static override table = {} as unknown
}

class DeniedWithFillableModel extends DeniesPasswordHash {
  static override table = {} as unknown
  // Listing a denied field in fillable does not open it — denied wins.
  static fillable = ['name', 'passwordHash']
}

function createRecordingAdapter() {
  const calls: { create: PlainObject[]; update: PlainObject[]; options: unknown[] } = { create: [], update: [], options: [] }
  const adapter = {
    async findMany<T extends PlainObject>(): Promise<T[]> { return [] },
    async findUnique<T extends PlainObject>(): Promise<T | null> { return null },
    async create<T extends PlainObject>(_table: unknown, data: PlainObject, options?: unknown): Promise<T> {
      calls.create.push(data)
      calls.options.push(options)
      return data as unknown as T
    },
    async update<T extends PlainObject>(_table: unknown, _where: unknown, data: PlainObject, options?: unknown): Promise<T> {
      calls.update.push(data)
      calls.options.push(options)
      return data as unknown as T
    },
  }
  return { adapter, calls }
}

function refusal(run: () => unknown): MassAssignmentException {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(MassAssignmentException)
    return error as MassAssignmentException
  }
  throw new Error('expected a MassAssignmentException')
}

describe('Model.filterFillable', () => {
  describe('default (no fillable)', () => {
    it('should strip id', () => {
      const result = DefaultModel.filterFillable({ id: 1, name: 'Alice' })
      expect(result).toEqual({ name: 'Alice' })
    })

    it('should pass through data without id unchanged', () => {
      const data = { name: 'Alice', email: 'alice@test.com' }
      const result = DefaultModel.filterFillable(data)
      expect(result).toEqual(data)
    })

    it('should not mutate the input when stripping id', () => {
      const data = { id: 1, name: 'Alice' }
      DefaultModel.filterFillable(data)
      expect(data).toEqual({ id: 1, name: 'Alice' })
    })
  })

  describe('with fillable (always strict)', () => {
    it('should throw MassAssignmentException for fields outside the allowlist', () => {
      expect(() =>
        FillableModel.filterFillable({
          title: 'Hello',
          body: 'World',
          isAdmin: true,
          authorId: 99,
        }),
      ).toThrow(MassAssignmentException)

      try {
        FillableModel.filterFillable({ title: 'Hello', isAdmin: true })
      } catch (error) {
        expect(error).toBeInstanceOf(MassAssignmentException)
        expect((error as MassAssignmentException).fields).toEqual(['isAdmin'])
        expect((error as MassAssignmentException).reason).toBe('not-fillable')
        expect((error as MassAssignmentException).message).toContain('FillableModel.create(data, { set: { isAdmin } })')
      }
    })

    it('should pass through data made only of fillable fields', () => {
      const result = FillableModel.filterFillable({ title: 'Hello', body: 'World' })
      expect(result).toEqual({ title: 'Hello', body: 'World' })
    })

    it('should handle missing fillable fields gracefully', () => {
      const result = FillableModel.filterFillable({ title: 'Hello' })
      expect(result).toEqual({ title: 'Hello' })
    })

    it('should strip id silently instead of counting it as blocked', () => {
      const result = FillableModel.filterFillable({ id: 7, title: 'Hello' })
      expect(result).toEqual({ title: 'Hello' })
    })
  })

  describe('with deniedFields()', () => {
    it('should throw with reason "denied" when a denied field is present', () => {
      expect(() => DeniedModel.filterFillable({ name: 'A', passwordHash: 'evil' })).toThrow(
        MassAssignmentException,
      )

      try {
        DeniedModel.filterFillable({ passwordHash: 'evil' })
      } catch (error) {
        expect(error).toBeInstanceOf(MassAssignmentException)
        expect((error as MassAssignmentException).fields).toEqual(['passwordHash'])
        expect((error as MassAssignmentException).reason).toBe('denied')
        expect((error as MassAssignmentException).message).toContain('never be mass-assigned')
      }
    })

    it('should pass through input without denied fields', () => {
      const result = DeniedModel.filterFillable({ name: 'A' })
      expect(result).toEqual({ name: 'A' })
    })

    it('should throw even when the denied field is listed in fillable', () => {
      expect(() =>
        DeniedWithFillableModel.filterFillable({ name: 'A', passwordHash: 'evil' }),
      ).toThrow(MassAssignmentException)

      try {
        DeniedWithFillableModel.filterFillable({ name: 'A', passwordHash: 'evil' })
      } catch (error) {
        expect((error as MassAssignmentException).reason).toBe('denied')
      }
    })

    it('should check the raw input before the allowlist so the denied reason wins', () => {
      // passwordHash is both denied and outside fillable on this model —
      // the caller must see the credential-specific error, not the generic one.
      class BothModel extends DeniesPasswordHash {
        static override table = {} as unknown
        static fillable = ['name']
      }
      try {
        BothModel.filterFillable({ passwordHash: 'evil' })
        expect.unreachable()
      } catch (error) {
        expect((error as MassAssignmentException).reason).toBe('denied')
      }
    })
  })

  describe('with set (RFC 0031)', () => {
    it('should merge set after filtering the data', () => {
      expect(FillableModel.filterFillable({ id: 3, title: 'Hello' }, { authorId: 1 })).toEqual({ title: 'Hello', authorId: 1 })
    })

    it('should refuse set on a model without fillable', () => {
      const error = refusal(() => DefaultModel.filterFillable({ title: 'Hello' }, { authorId: 1 }))
      expect(error.fields).toEqual(['authorId'])
      expect(error.reason).toBe('not-fillable')
      expect(error.message).toContain('declares no fillable')
    })

    it('should treat an empty set as no set', () => {
      expect(DefaultModel.filterFillable({ title: 'Hello' }, {})).toEqual({ title: 'Hello' })
    })

    it('should refuse id in set', () => {
      const error = refusal(() => FillableModel.filterFillable({ title: 'Hello' }, { id: 9, authorId: 1 }))
      expect(error.fields).toEqual(['id'])
      expect(error.reason).toBe('not-fillable')
      expect(error.message).toContain('forceCreate()')
    })

    it('should refuse a denied field in set, even one listed in fillable', () => {
      const error = refusal(() => DeniedWithFillableModel.filterFillable({ name: 'A' }, { passwordHash: 'oauth:x' }))
      expect(error.fields).toEqual(['passwordHash'])
      expect(error.reason).toBe('denied')
      expect(error.message).toContain('not even through DeniedWithFillableModel.fillable or set')
    })

    it('should refuse a fillable field in set, which request data spread into set carries', () => {
      const data = { title: 'Hello', body: 'World' }
      const error = refusal(() => FillableModel.filterFillable({}, { ...data, authorId: 1 }))
      expect(error.fields).toEqual(['title', 'body'])
      expect(error.reason).toBe('not-fillable')
      expect(error.message).toContain('They are in FillableModel.fillable')
    })

    it('should check set before the data', () => {
      const error = refusal(() => FillableModel.filterFillable({ isAdmin: true }, { title: 'Hello' }))
      expect(error.fields).toEqual(['title'])
    })

    it('should refuse a key in both data and set, naming only that key', () => {
      const error = refusal(() =>
        FillableModel.filterFillable({ title: 'Hello', authorId: 2, isAdmin: true }, { authorId: 1 }),
      )
      expect(error.fields).toEqual(['authorId'])
      expect(error.reason).toBe('not-fillable')
      expect(error.message).toContain('set by the server in this call')
    })
  })

  describe('forceCreate / forceUpdate', () => {
    it('create() throws for unfillable fields, forceCreate() writes them', async () => {
      class StrictUser extends Model<PlainObject> {
        static override table = 'users'
        static fillable = ['name', 'email']
      }
      const { adapter, calls } = createRecordingAdapter()
      StrictUser.useAdapter(adapter)

      await expect(
        StrictUser.create({ name: 'A', email: 'a@x.com', passwordHash: 'oauth:x' }),
      ).rejects.toThrow(MassAssignmentException)

      const record = await StrictUser.forceCreate({ name: 'A', email: 'a@x.com', passwordHash: 'oauth:x' })
      expect(record).toEqual({ name: 'A', email: 'a@x.com', passwordHash: 'oauth:x' })
      expect(calls.create).toHaveLength(1)
    })

    it('forceCreate() bypasses deniedFields()', async () => {
      class DeniedUser extends DeniesPasswordHash {
        static override table = 'users'
      }
      const { adapter, calls } = createRecordingAdapter()
      DeniedUser.useAdapter(adapter)

      await expect(DeniedUser.create({ passwordHash: 'evil' })).rejects.toThrow(MassAssignmentException)

      await DeniedUser.forceCreate({ passwordHash: 'oauth:x' })
      expect(calls.create).toEqual([{ passwordHash: 'oauth:x' }])
    })

    it('forceUpdate() bypasses the allowlist', async () => {
      class StrictUser extends Model<PlainObject> {
        static override table = 'users'
        static fillable = ['name']
      }
      const { adapter, calls } = createRecordingAdapter()
      StrictUser.useAdapter(adapter)

      await expect(StrictUser.update({ id: 1 }, { role: 'admin' })).rejects.toThrow(MassAssignmentException)

      await StrictUser.forceUpdate({ id: 1 }, { role: 'admin' })
      expect(calls.update).toEqual([{ role: 'admin' }])
    })
  })
})

  describe('QueryBuilder.update mass assignment (#security-review C1)', () => {
    function createBuilderAdapter() {
      const calls: PlainObject[] = []
      const adapter = {
        async findMany<T extends PlainObject>(): Promise<T[]> { return [] },
        async findUnique<T extends PlainObject>(): Promise<T | null> { return null },
        async create<T extends PlainObject>(_t: unknown, data: PlainObject): Promise<T> { return data as unknown as T },
        async update<T extends PlainObject>(_t: unknown, _w: unknown, data: PlainObject): Promise<T> {
          calls.push(data)
          return data as unknown as T
        },
      }
      return { adapter, calls }
    }

    it('applies the fillable allowlist on the fluent builder', async () => {
      class StrictPost extends Model<PlainObject> {
        static override table = 'posts'
        static fillable = ['title', 'body']
      }
      const { adapter } = createBuilderAdapter()
      StrictPost.useAdapter(adapter)

      await expect(
        StrictPost.where({ id: 1 }).update({ title: 'x', authorId: 99 }),
      ).rejects.toThrow(MassAssignmentException)
    })

    it('applies deniedFields() on the fluent builder', async () => {
      class DeniedPost extends DeniesPasswordHash {
        static override table = 'posts'
      }
      const { adapter, calls } = createBuilderAdapter()
      DeniedPost.useAdapter(adapter)

      await expect(
        DeniedPost.where({ id: 1 }).update({ passwordHash: 'evil' }),
      ).rejects.toThrow(MassAssignmentException)
      expect(calls).toEqual([])
    })

    it('forceUpdate on the builder bypasses the allowlist', async () => {
      class StrictPost extends Model<PlainObject> {
        static override table = 'posts'
        static fillable = ['title', 'body']
      }
      const { adapter, calls } = createBuilderAdapter()
      StrictPost.useAdapter(adapter)

      await StrictPost.where({ id: 1 }).forceUpdate({ authorId: 99 })
      expect(calls).toEqual([{ authorId: 99 }])
    })

    it('models without fillable keep id stripping on the builder', async () => {
      class LoosePost extends Model<PlainObject> {
        static override table = 'posts'
      }
      const { adapter, calls } = createBuilderAdapter()
      LoosePost.useAdapter(adapter)

      await LoosePost.where({ slug: 'a' }).update({ id: 5, title: 'x' })
      expect(calls).toEqual([{ title: 'x' }])
    })
  })

describe('create / update with set (RFC 0031)', () => {
  it('create() writes the merged payload and keeps set out of the adapter options', async () => {
    class OwnedPost extends FillableModel {}
    const { adapter, calls } = createRecordingAdapter()
    OwnedPost.useAdapter(adapter)

    await OwnedPost.create({ title: 'Hello', body: 'World' }, { set: { authorId: 1 }, trx: 'T' })

    expect(calls.create).toEqual([{ title: 'Hello', body: 'World', authorId: 1 }])
    expect(calls.options).toEqual([{ trx: 'T' }])
  })

  it('create() without set hands the adapter the options object it was given', async () => {
    class OwnedPost extends FillableModel {}
    const { adapter, calls } = createRecordingAdapter()
    OwnedPost.useAdapter(adapter)
    const options = { trx: 'T' }

    await OwnedPost.create({ title: 'Hello' }, options)

    expect(calls.options[0]).toBe(options)
  })

  it('update() writes set beside the filtered data', async () => {
    class OwnedPost extends FillableModel {}
    const { adapter, calls } = createRecordingAdapter()
    OwnedPost.useAdapter(adapter)

    await OwnedPost.update({ id: 1 }, { title: 'Renamed' }, { set: { authorId: 2 } })

    expect(calls.update).toEqual([{ title: 'Renamed', authorId: 2 }])
  })

  it('refuses before anything reaches the adapter', async () => {
    class OwnedPost extends FillableModel {}
    const { adapter, calls } = createRecordingAdapter()
    OwnedPost.useAdapter(adapter)

    await expect(OwnedPost.create({}, { set: { title: 'Hello', authorId: 1 } })).rejects.toThrow(MassAssignmentException)
    await expect(
      // @ts-expect-error the types refuse a key in both as well; this checks the runtime
      OwnedPost.update({ id: 1 }, { authorId: 3 }, { set: { authorId: 2 } }),
    ).rejects.toThrow(MassAssignmentException)
    expect(calls).toEqual({ create: [], update: [], options: [] })
  })

  it('runs mutators over the set columns', async () => {
    class SluggedPost extends FillableModel {
      static override mutators = { slug: (value: unknown) => String(value).toLowerCase() }
    }
    const { adapter, calls } = createRecordingAdapter()
    SluggedPost.useAdapter(adapter)

    await SluggedPost.create({ title: 'Hello' }, { set: { slug: 'HELLO' } })

    expect(calls.create).toEqual([{ title: 'Hello', slug: 'hello' }])
  })

  it('the transaction scope passes set and its own trx through', async () => {
    class OwnedPost extends FillableModel {}
    const { adapter, calls } = createRecordingAdapter()
    OwnedPost.useAdapter(adapter)
    const scope = OwnedPost.inTransaction('T')

    await scope.create({ title: 'Hello' }, { set: { authorId: 1 } })
    await scope.update({ id: 1 }, { body: 'Edited' }, { set: { authorId: 2 } })

    expect(calls.create).toEqual([{ title: 'Hello', authorId: 1 }])
    expect(calls.update).toEqual([{ body: 'Edited', authorId: 2 }])
    expect(calls.options).toEqual([{ trx: 'T' }, { trx: 'T' }])
  })
})
