import { describe, it, expect } from 'bun:test'
import { Model, type PlainObject } from '../src/Model'
import { MassAssignmentException } from '../src/MassAssignmentException'

// Minimal concrete subclasses for testing filterFillable

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
        expect((error as MassAssignmentException).message).toContain('forceCreate')
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

  describe('forceCreate / forceUpdate', () => {
    function createRecordingAdapter() {
      const calls: { create: PlainObject[]; update: PlainObject[] } = { create: [], update: [] }
      const adapter = {
        async findMany<T extends PlainObject>(): Promise<T[]> { return [] },
        async findUnique<T extends PlainObject>(): Promise<T | null> { return null },
        async create<T extends PlainObject>(_table: unknown, data: PlainObject): Promise<T> {
          calls.create.push(data)
          return data as unknown as T
        },
        async update<T extends PlainObject>(_table: unknown, _where: unknown, data: PlainObject): Promise<T> {
          calls.update.push(data)
          return data as unknown as T
        },
      }
      return { adapter, calls }
    }

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
