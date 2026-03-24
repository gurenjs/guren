import { describe, it, expect } from 'bun:test'
import { Model, type PlainObject } from '../src/Model'

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

  describe('with fillable', () => {
    it('should only keep fillable fields', () => {
      const result = FillableModel.filterFillable({
        title: 'Hello',
        body: 'World',
        isAdmin: true,
        authorId: 99,
      })
      expect(result).toEqual({ title: 'Hello', body: 'World' })
    })

    it('should handle missing fillable fields gracefully', () => {
      const result = FillableModel.filterFillable({ title: 'Hello' })
      expect(result).toEqual({ title: 'Hello' })
    })

    it('should return empty object when no fillable fields match', () => {
      const result = FillableModel.filterFillable({ isAdmin: true, role: 'superuser' })
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
    it('should use fillable whitelist and ignore guarded', () => {
      const result = FillableAndGuardedModel.filterFillable({
        id: 1,
        name: 'Alice',
        email: 'alice@test.com',
        isAdmin: true,
      })
      expect(result).toEqual({ name: 'Alice', email: 'alice@test.com' })
    })
  })
})
