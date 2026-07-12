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

class GuardedModel extends Model<PlainObject> {
  static override table = {} as unknown
  static guarded = ['id', 'createdAt', 'passwordHash']
}

class FillableAndGuardedModel extends Model<PlainObject> {
  static override table = {} as unknown
  static fillable = ['name', 'email']
  static guarded = ['id'] // should be ignored when fillable is set
}

describe('Model.filterFillable', () => {
  describe('default (no fillable or guarded)', () => {
    it('should strip id by default', () => {
      const result = DefaultModel.filterFillable({ id: 1, name: 'Alice' })
      expect(result).toEqual({ name: 'Alice' })
    })

    it('should pass through data without id unchanged', () => {
      const data = { name: 'Alice', email: 'alice@test.com' }
      const result = DefaultModel.filterFillable(data)
      expect(result).toEqual(data)
    })
  })

  describe('with fillable (strict by default)', () => {
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
  })

  describe('with fillable and strictFillable = false', () => {
    class LenientModel extends Model<PlainObject> {
      static override table = {} as unknown
      static fillable = ['title', 'body']
      static strictFillable = false
    }

    it('should silently discard fields outside the allowlist', () => {
      const result = LenientModel.filterFillable({
        title: 'Hello',
        body: 'World',
        isAdmin: true,
      })
      expect(result).toEqual({ title: 'Hello', body: 'World' })
    })

    it('should return empty object when no fillable fields match', () => {
      const result = LenientModel.filterFillable({ isAdmin: true, role: 'superuser' })
      expect(result).toEqual({})
    })
  })

  describe('with guarded', () => {
    it('should strip guarded fields', () => {
      const result = GuardedModel.filterFillable({
        id: 1,
        name: 'Alice',
        createdAt: '2024-01-01',
        passwordHash: '$2b$...',
      })
      expect(result).toEqual({ name: 'Alice' })
    })

    it('should pass through non-guarded fields', () => {
      const result = GuardedModel.filterFillable({ name: 'Alice', email: 'alice@test.com' })
      expect(result).toEqual({ name: 'Alice', email: 'alice@test.com' })
    })
  })

  describe('fillable takes precedence over guarded', () => {
    it('should use the fillable allowlist and ignore guarded', () => {
      expect(() =>
        FillableAndGuardedModel.filterFillable({
          id: 1,
          name: 'Alice',
          email: 'alice@test.com',
          isAdmin: true,
        }),
      ).toThrow(MassAssignmentException)

      const result = FillableAndGuardedModel.filterFillable({
        name: 'Alice',
        email: 'alice@test.com',
      })
      expect(result).toEqual({ name: 'Alice', email: 'alice@test.com' })
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
