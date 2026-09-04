/**
 * Type-level tests for defineModel's typed allowlist options.
 * Compiled by `tsc -p tsconfig.typecheck.json`; never executed.
 */
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import { Model, defineModel, type PlainObject } from '../src/Model'

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
})

/** Stand-in for AuthenticatableModel, which lives in @guren/server and must not be imported here. */
abstract class CredentialedModel<TRecord extends PlainObject = PlainObject> extends Model<TRecord> {
  static override readonly createType: { password?: string } = undefined as unknown as {
    password?: string
  }
}

export class FillableOk extends defineModel(posts, {
  fillable: ['title', 'body'],
}) {}

export class FillableTypo extends defineModel(posts, {
  // @ts-expect-error 'bod' is not a column of posts
  fillable: ['title', 'bod'],
}) {}

export class FillableWithBase extends defineModel(users, {
  base: CredentialedModel,
  optionalOnCreate: ['passwordHash'],
  requireOnCreate: ['password'],
  fillable: ['name', 'email', 'password'],
}) {}

export class FillableNoBaseVirtual extends defineModel(posts, {
  // @ts-expect-error without a base, only columns are fillable — a plain
  // Model base must not collapse the key type to `string`
  fillable: ['password'],
}) {}

export class HiddenOk extends defineModel(users, {
  hidden: ['passwordHash', 'rememberToken'],
}) {}

export class HiddenTypo extends defineModel(users, {
  // @ts-expect-error 'passwordhash' is not a column of users
  hidden: ['passwordhash'],
}) {}

export class VisibleOk extends defineModel(users, {
  visible: ['id', 'name', 'email'],
}) {}

export class VisibleTypo extends defineModel(users, {
  // @ts-expect-error 'emial' is not a column of users
  visible: ['emial'],
}) {}

export class AccessorsOk extends defineModel(users, {
  accessors: {
    displayName: (record) => `${record.name} <${record.email}>`,
  },
  appends: ['displayName'],
}) {}

export class AccessorsBadField extends defineModel(users, {
  accessors: {
    // @ts-expect-error 'nope' is not a field of the users record
    broken: (record) => record.nope,
  },
}) {}

export class AppendsTypo extends defineModel(users, {
  accessors: {
    displayName: (record) => record.name,
  },
  // @ts-expect-error 'displayNam' is not a declared accessor
  appends: ['displayNam'],
}) {}

export class AccessorsNotObject extends defineModel(users, {
  // @ts-expect-error accessors must be a map of functions — with no keys to
  // infer, the mapped type alone would collapse to `{}` and admit anything
  accessors: () => 1,
}) {}

export class AppendsWithoutAccessors extends defineModel(users, {
  // @ts-expect-error appends may only reference declared accessors
  appends: ['displayName'],
}) {}

// hidden/visible may also name a declared accessor: serialize applies them to appended virtual fields.
export class HiddenAccessorKey extends defineModel(users, {
  accessors: {
    displayName: (record) => record.name,
  },
  appends: ['displayName'],
  hidden: ['passwordHash', 'displayName'],
}) {}

// legacy static declarations keep compiling (loosely typed)
export class LegacyStatic extends defineModel(posts) {
  static override fillable = ['title', 'not-checked-here']
  static override hidden = ['whatever']
  static override appends = ['anything']
}
