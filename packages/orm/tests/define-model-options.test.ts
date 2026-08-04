import { describe, it, expect } from 'bun:test'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { Model, defineModel } from '../src/Model'
import { MassAssignmentException } from '../src/MassAssignmentException'

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
})

type UserRecord = typeof users.$inferSelect

const record: UserRecord = {
  id: 1,
  name: 'Alice',
  email: 'alice@test.com',
  passwordHash: 'secret',
}

describe('defineModel allowlist options', () => {
  it('fillable option drives filterFillable exactly like a static declaration', () => {
    class User extends defineModel(users, { fillable: ['name', 'email'] }) {}

    expect(User.filterFillable({ name: 'Alice' })).toEqual({ name: 'Alice' })
    expect(() => User.filterFillable({ name: 'Alice', isAdmin: true })).toThrow(
      MassAssignmentException,
    )
  })

  it('a static fillable declaration on the subclass shadows the option', () => {
    class User extends defineModel(users, { fillable: ['name'] }) {
      static override fillable = ['email']
    }

    expect(User.filterFillable({ email: 'a@b.c' })).toEqual({ email: 'a@b.c' })
    expect(() => User.filterFillable({ name: 'Alice' })).toThrow(MassAssignmentException)
  })

  it('hidden option is applied by serialize', () => {
    class User extends defineModel(users, { hidden: ['passwordHash'] }) {}

    expect(User.serialize(record)).toEqual({ id: 1, name: 'Alice', email: 'alice@test.com' })
  })

  it('visible option is applied by serialize and wins over hidden', () => {
    class User extends defineModel(users, {
      visible: ['id', 'name'],
      hidden: ['passwordHash'],
    }) {}

    expect(User.serialize(record)).toEqual({ id: 1, name: 'Alice' })
  })

  it('accessors and appends options serialize virtual attributes', () => {
    class User extends defineModel(users, {
      accessors: {
        displayName: (r) => `${r.name} <${r.email}>`,
      },
      appends: ['displayName'],
      hidden: ['passwordHash'],
    }) {}

    expect(User.serialize(record)).toEqual({
      id: 1,
      name: 'Alice',
      email: 'alice@test.com',
      displayName: 'Alice <alice@test.com>',
    })
  })

  it('options stay on the defined class and do not leak to Model or siblings', () => {
    class Configured extends defineModel(users, { fillable: ['name'], hidden: ['passwordHash'] }) {}
    class Plain extends defineModel(users) {}

    expect(Configured.fillable).toEqual(['name'])
    expect(Model.fillable).toBeUndefined()
    expect(Plain.fillable).toBeUndefined()
    expect(Plain.hidden).toBeUndefined()
    expect(Plain.serialize(record)).toEqual(record)
  })
})
