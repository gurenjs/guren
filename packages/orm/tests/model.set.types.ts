/**
 * Type-level tests for `create(data, { set })` and `update(where, data, { set })`
 * (RFC 0031). Compiled by `tsc -p tsconfig.typecheck.json`; never executed.
 */
import { integer, pgTable, serial, text } from 'drizzle-orm/pg-core'
import {
  Model,
  defineModel,
  type ModelSetOptions,
  type ModelWriteOptions,
  type PlainObject,
  type TransactionHandle,
} from '../src/Model'

const posts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull(),
  categoryId: integer('category_id'),
})

class Post extends defineModel(posts, { fillable: ['title', 'body', 'categoryId'] }) {}

declare const payload: { title: string; body: string }
declare const trx: TransactionHandle

async function _setRemovesTheKeyFromData() {
  await Post.create(payload, { set: { authorId: 1 } })
  await Post.create({ ...payload, categoryId: null }, { set: { authorId: 1 }, trx })

  // @ts-expect-error without set, authorId is still required
  await Post.create(payload)

  // @ts-expect-error the other required columns stay required in data
  await Post.create({ title: 'Hello' }, { set: { authorId: 1 } })
}
void _setRemovesTheKeyFromData

async function _setIsCheckedAgainstTheCreatePayload() {
  // @ts-expect-error a key in both data and set
  await Post.create({ ...payload, authorId: 1 }, { set: { authorId: 2 } })

  // @ts-expect-error id is never server-set through set
  await Post.create(payload, { set: { authorId: 1, id: 7 } })

  // @ts-expect-error a key that is not a column
  await Post.create(payload, { set: { authorId: 1, autorId: 1 } })

  // @ts-expect-error the column's type still applies
  await Post.create(payload, { set: { authorId: 'ada' } })
}
void _setIsCheckedAgainstTheCreatePayload

async function _updateTakesSet() {
  await Post.update({ id: 1 }, { title: 'Renamed' }, { set: { authorId: 2 } })
  await Post.update({ id: 1 }, {}, { set: { authorId: 2, categoryId: null } })

  // @ts-expect-error a key in both data and set
  await Post.update({ id: 1 }, { authorId: 3 }, { set: { authorId: 2 } })
}
void _updateTakesSet

async function _optionsByVariable() {
  const options = { set: { authorId: 1 } }
  await Post.create(payload, options)

  const typed: ModelSetOptions<typeof Post, { authorId: number }> = { set: { authorId: 1 }, trx }
  await Post.create(payload, typed)
}
void _optionsByVariable

async function _transactionScopeTakesSet() {
  const scope = Post.inTransaction(trx)
  await scope.create(payload, { set: { authorId: 1 } })
  await scope.update({ id: 1 }, { body: 'Edited' }, { set: { authorId: 2 } })

  // @ts-expect-error a key in both data and set
  await scope.create({ ...payload, authorId: 1 }, { set: { authorId: 2 } })
}
void _transactionScopeTakesSet

// A model without createType accepts any keys; the runtime rules still apply.
class Loose extends Model<PlainObject> {
  static override table = {} as unknown
}
async function _untypedModel() {
  await Loose.create({ title: 'Hello' }, { set: { authorId: 1 } })
}
void _untypedModel

// `.bind`, `.call` and `Parameters<>` read the last overload, which is the
// signature create and update had before `set`.
async function _lastOverloadIsUnchanged() {
  const create = Post.create.bind(Post)
  await create({ ...payload, authorId: 1 })
  const _args: Parameters<typeof Post.create> = [{ ...payload, authorId: 1 }]
  const update = Post.update.bind(Post)
  await update({ id: 1 }, { title: 'Renamed' })
  void _args
}
void _lastOverloadIsUnchanged

// An app model overriding create with the signature it had before the overload
// must still extend the base's static side.
class Audited extends defineModel(posts, { fillable: ['title', 'body'] }) {
  static override async create<T extends typeof Model>(
    this: T,
    data: PlainObject,
    writeOptions?: ModelWriteOptions,
  ): Promise<never> {
    return super.create.call(this, data, writeOptions) as Promise<never>
  }
}
void Audited
