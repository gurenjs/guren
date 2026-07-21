import { drizzle } from 'drizzle-orm/postgres-js'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'
import {
  Model,
  defineModel,
  type BelongsToRequiredRecord,
  type TransactionHandle,
  type TransactionModelScope,
} from '../src/Model'

const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
})

export type UserRecord = typeof users.$inferSelect

class User extends Model<UserRecord> {
  static override table = users
  static override readonly recordType = {} as UserRecord
}

class FactoryUser extends defineModel(users) {}

declare const db: ReturnType<typeof drizzle>

// Should accept a Drizzle database without type errors.
User.query(db).execute()

// Type assertions with a typed builder: Model.query(db) should preserve the builder's result shape.
type FakeSelect = { from(table: typeof users): { execute: () => Promise<UserRecord[]> } }
type FakeDb = { select: () => FakeSelect }

declare const fakeDb: FakeDb

const fakeQuery = User.query(fakeDb)
type FakeRow = Awaited<ReturnType<typeof fakeQuery.execute>>[number]
const _fakeRowIsUser: UserRecord = {} as FakeRow
const _userIsFakeRow: FakeRow = {} as UserRecord

const selectedQuery = FactoryUser.select('id', 'name')
type SelectedRow = Awaited<ReturnType<typeof selectedQuery.get>>[number]
const _selectedId: number = ({} as SelectedRow).id
const _selectedName: string = ({} as SelectedRow).name
// @ts-expect-error selected rows should not expose omitted fields
const _selectedTeam = ({} as SelectedRow).team

FactoryUser.where('name', 'Ada')
FactoryUser.whereIn('id', [1, 2, 3])
FactoryUser.whereNull('name')

declare const trx: TransactionHandle
const txUser = User.inTransaction(trx)
const _txScope: TransactionModelScope<typeof User> = txUser
txUser.create({ name: 'Kaworu' })
txUser.update({ id: 1 }, { name: 'Nagisa' })

// findWith / with() with multiple relations must intersect the relation
// picks, not distribute them into a union.
type PostRecordT = { id: number; title: string; authorId: number }
type CommentRecordT = { id: number; body: string; postId: number }

class RelUser extends Model<UserRecord> {
  static table = users
  static override relationTypes: {
    posts: PostRecordT[]
    comments: CommentRecordT[]
  } = { posts: [], comments: [] }
}

async function _relationIntersection() {
  const found = await RelUser.findWith(1, ['posts', 'comments'])
  if (found) {
    const _posts: PostRecordT[] = found.posts
    const _comments: CommentRecordT[] = found.comments
    void _posts
    void _comments
  }

  const listed = await RelUser.with(['posts', 'comments'])
  const first = listed[0]
  if (first) {
    const _posts: PostRecordT[] = first.posts
    const _comments: CommentRecordT[] = first.comments
    void _posts
    void _comments
  }

  const counted = await RelUser.withCount('posts')
  const _count: number = counted[0].postsCount
  void _count
}
void _relationIntersection

// Nested eager-load paths ('posts.comments') must be accepted by with()/
// findWith()/findWithOrFail()/withPaginate(). The head segment is typed from
// relationTypes; declare the nested shape there to type the loaded children.
class NestedRelUser extends Model<UserRecord> {
  static table = users
  declare static relationTypes: {
    posts: Array<PostRecordT & { comments: CommentRecordT[] }>
  }
}

async function _nestedRelationPaths() {
  const found = await NestedRelUser.findWithOrFail(1, 'posts.comments')
  const _foundComments: CommentRecordT[] = found.posts[0].comments
  void _foundComments

  const maybe = await NestedRelUser.findWith(1, 'posts.comments')
  if (maybe) {
    const _maybePosts: PostRecordT[] = maybe.posts
    void _maybePosts
  }

  const listed = await NestedRelUser.with('posts.comments')
  const _listedComments: CommentRecordT[] = listed[0].posts[0].comments
  void _listedComments

  const paged = await NestedRelUser.withPaginate('posts.comments')
  const _pagedComments: CommentRecordT[] = paged.data[0].posts[0].comments
  void _pagedComments

  // @ts-expect-error nested paths must be rooted at a declared relation key
  await NestedRelUser.with('nope.comments')

  // @ts-expect-error withCount does not support nested relation paths
  await NestedRelUser.withCount('posts.comments')

  // A mixed array of a plain key and a nested path must still intersect
  // (not distribute into a union) on the head segments.
  const mixed = await NestedRelUser.with(['posts', 'posts.comments'] as const)
  const _mixedPosts: PostRecordT[] = mixed[0].posts
  void _mixedPosts

  // Only the head segment is validated — everything after the first dot is
  // an unvalidated string, so these malformed/deeper paths type-check even
  // though the runtime would throw "unknown relation" for a bad tail (and
  // even that only once it recurses into an actually-loaded child; see the
  // RelationPath comment above its definition). This is documented, not a
  // gap to close here — flagging it so a future edit doesn't "fix" it into
  // silently narrowing what compiles.
  await NestedRelUser.with('posts.')
  await NestedRelUser.with('posts..comments')
  await NestedRelUser.with('posts.comments.typo')

  // 3+ level paths still resolve the type from the head segment only.
  const deep = await NestedRelUser.with('posts.comments.author')
  const _deepPosts: PostRecordT[] = deep[0].posts
  void _deepPosts
}
void _nestedRelationPaths

// belongsTo relations backed by a NOT NULL foreign key can opt into a
// non-nullable declaration via BelongsToRequiredRecord. Using `declare`
// avoids the runtime placeholder value entirely.
class RequiredAuthorUser extends Model<UserRecord> {
  static table = users
  declare static relationTypes: {
    author: BelongsToRequiredRecord<UserRecord>
  }
}

async function _requiredBelongsTo() {
  const listed = await RequiredAuthorUser.with('author')
  const first = listed[0]
  if (first) {
    const _authorName: string = first.author.name // no null check required
    void _authorName
  }
}
void _requiredBelongsTo
