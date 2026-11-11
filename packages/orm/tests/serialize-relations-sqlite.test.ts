import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import type { PlainObject } from '../src/Model'
import { useSqlite } from './sqlite-fixture'

// `serialize()` applies each eager-loaded relation's own model's hidden/visible
// to its rows, at every depth, against the real bun:sqlite driver.

const usersTable = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  passwordHash: text('password_hash').notNull(),
})

const rolesTable = sqliteTable('roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  secret: text('secret').notNull(),
})

const userRolesTable = sqliteTable('user_roles', {
  userId: integer('user_id').notNull(),
  roleId: integer('role_id').notNull(),
})

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  authorId: integer('author_id').notNull(),
})

const commentsTable = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
  postId: integer('post_id').notNull(),
  ip: text('ip').notNull(),
})

const tokensTable = sqliteTable('tokens', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  hashedToken: text('hashed_token').notNull(),
})

const imagesTable = sqliteTable('images', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  imageableType: text('imageable_type').notNull(),
  imageableId: integer('imageable_id').notNull(),
})

type UserRecord = typeof usersTable.$inferSelect
type RoleRecord = typeof rolesTable.$inferSelect
type PostRecord = typeof postsTable.$inferSelect
type CommentRecord = typeof commentsTable.$inferSelect
type TokenRecord = typeof tokensTable.$inferSelect
type ImageRecord = typeof imagesTable.$inferSelect

type Row = Record<string, unknown>
type PostWithAuthor = PostRecord & { author: UserRecord | null }

class User extends Model<UserRecord> {
  static override table = usersTable
  static override hidden = ['passwordHash']
}

class ListedUser extends Model<UserRecord> {
  static override table = usersTable
  static override visible = ['email', 'name', 'id']
  static override hidden = ['tokens']
}

class Role extends Model<RoleRecord> {
  static override table = rolesTable
  static override hidden = ['secret']
}

class Post extends Model<PostRecord> {
  static override table = postsTable
}

class Comment extends Model<CommentRecord> {
  static override table = commentsTable
  static override hidden = ['ip']
}

class Token extends Model<TokenRecord> {
  static override table = tokensTable
  static override hidden = ['hashedToken']
}

class Image extends Model<ImageRecord> {
  static override table = imagesTable
  static override visible = ['id', 'url']
}

class RelabelledImage extends Model<ImageRecord> {
  static override table = imagesTable
  static override hidden = ['imageableType', 'imageableId']
  static override accessors = { imageableType: (r: PlainObject) => String(r.imageableType).toLowerCase() }
}

class OpenUser extends Model<UserRecord> {
  static override table = usersTable
}

class OpenPost extends Model<PostRecord> {
  static override table = postsTable
}

let tokenThunkCalls = 0
let unloadedThunkCalls = 0

User.hasMany('posts', Post, 'authorId', 'id')
User.hasMany('tokens', () => {
  tokenThunkCalls++
  return Token
}, 'userId', 'id')
User.hasMany('unloadedTokens', () => {
  unloadedThunkCalls++
  return Token
}, 'userId', 'id')
User.belongsToMany('roles', Role, userRolesTable, 'userId', 'roleId', 'id', 'id')
User.morphMany('images', Image, 'imageable', 'id')
ListedUser.belongsToMany('roles', Role, userRolesTable, 'userId', 'roleId', 'id', 'id')
ListedUser.hasMany('posts', Post, 'authorId', 'id')
ListedUser.hasMany('tokens', Token, 'userId', 'id')
Post.belongsTo('author', User, 'authorId', 'id')
Post.belongsTo('listedAuthor', ListedUser, 'authorId', 'id')
Post.hasMany('comments', Comment, 'postId', 'id')
Image.morphTo('imageable', 'imageable')
RelabelledImage.morphTo('imageable', 'imageable')
OpenPost.belongsTo('author', OpenUser, 'authorId', 'id')
OpenUser.hasMany('posts', OpenPost, 'authorId', 'id')

describe('serialize() filters eager-loaded relation rows (bun:sqlite)', () => {
  useSqlite(`
    CREATE TABLE users (id integer primary key autoincrement, name text not null, email text not null, password_hash text not null);
    CREATE TABLE roles (id integer primary key autoincrement, name text not null, secret text not null);
    CREATE TABLE user_roles (user_id integer not null, role_id integer not null);
    CREATE TABLE posts (id integer primary key autoincrement, title text not null, author_id integer not null);
    CREATE TABLE comments (id integer primary key autoincrement, body text not null, post_id integer not null, ip text not null);
    CREATE TABLE tokens (id integer primary key autoincrement, user_id integer not null, hashed_token text not null);
    CREATE TABLE images (id integer primary key autoincrement, url text not null, imageable_type text not null, imageable_id integer not null);
    INSERT INTO users (name, email, password_hash) VALUES ('Alice', 'alice@example.com', 'hash-a'), ('Bob', 'bob@example.com', 'hash-b');
    INSERT INTO roles (name, secret) VALUES ('admin', 'role-secret');
    INSERT INTO user_roles (user_id, role_id) VALUES (1, 1);
    INSERT INTO posts (title, author_id) VALUES ('A1', 1), ('A2', 1), ('B1', 2);
    INSERT INTO comments (body, post_id, ip) VALUES ('hi', 1, '10.0.0.1');
    INSERT INTO tokens (user_id, hashed_token) VALUES (1, 'token-hash');
    INSERT INTO images (url, imageable_type, imageable_id) VALUES ('avatar.png', 'User', 1);
  `)

  let previousMorphMap: typeof Model.morphMap
  beforeAll(() => {
    previousMorphMap = Model.morphMap
    Model.morphMap = { User, Post }
  })
  afterAll(() => {
    Model.morphMap = previousMorphMap
  })

  it('drops the related model\'s hidden columns from a belongsTo row', async () => {
    const posts = (await Post.newQuery().with('author').orderBy('id', 'asc').get()) as PostWithAuthor[]
    const before = structuredClone(posts)

    const many = Post.serializeMany(posts) as Array<Row & { author: Row }>
    expect(many.map((p) => p.author)).toEqual([
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 1, name: 'Alice', email: 'alice@example.com' },
      { id: 2, name: 'Bob', email: 'bob@example.com' },
    ])
    expect((Post.serialize(posts[2]) as Row & { author: Row }).author).not.toHaveProperty('passwordHash')
    expect(posts).toEqual(before)
  })

  it('filters a row several parents share once, into one output row', async () => {
    const posts = (await Post.newQuery().with('author').orderBy('id', 'asc').get()) as PostWithAuthor[]
    expect(posts[0].author).toBe(posts[1].author)

    const many = Post.serializeMany(posts) as Array<Row & { author: Row }>
    expect(many[0].author).toBe(many[1].author)
  })

  it('filters rows two levels down', async () => {
    const users = (await User.newQuery().with('posts.comments').orderBy('id', 'asc').get()) as Array<
      UserRecord & { posts: Array<PostRecord & { comments: CommentRecord[] }> }
    >

    const [alice] = User.serializeMany(users) as Array<Row & { posts: Array<Row & { comments: Row[] }> }>
    expect(alice).not.toHaveProperty('passwordHash')
    expect(alice.posts[0].comments).toEqual([{ id: 1, body: 'hi', postId: 1 }])
    expect(users[0].posts[0].comments[0].ip).toBe('10.0.0.1')
  })

  it('keeps the loaded relations of a row its model\'s visible narrows, each filtered by its own model', async () => {
    const posts = (await Post.newQuery()
      .with('listedAuthor.roles', 'listedAuthor.posts', 'listedAuthor.tokens')
      .orderBy('id', 'asc')
      .get()) as Array<PostRecord & { listedAuthor: Row & { posts: PostRecord[] } }>

    const [first] = Post.serializeMany(posts) as Array<Row & { listedAuthor: Row & { roles: Row[] } }>
    expect(Object.keys(first.listedAuthor)).toEqual(['id', 'name', 'email', 'roles', 'posts'])
    expect(first.listedAuthor.roles).toEqual([{ id: 1, name: 'admin' }])
    expect(first.listedAuthor.posts).toBe(posts[0].listedAuthor.posts)
  })

  it('resolves a morphTo row through morphMap from the type column its holder\'s visible drops', async () => {
    const users = (await User.newQuery().with('images.imageable').orderBy('id', 'asc').get()) as Array<
      UserRecord & { images: Array<ImageRecord & { imageable: UserRecord | null }> }
    >
    expect(users[0].images[0].imageable?.passwordHash).toBe('hash-a')

    const [alice] = User.serializeMany(users) as Array<Row & { images: Row[] }>
    expect(alice.images).toEqual([
      { id: 1, url: 'avatar.png', imageable: { id: 1, name: 'Alice', email: 'alice@example.com' } },
    ])
  })

  it('filters a morphTo row by the model its load resolved when an accessor rewrites the type column', async () => {
    const images = (await RelabelledImage.newQuery().with('imageable').orderBy('id', 'asc').get()) as Array<
      ImageRecord & { imageable: UserRecord | null }
    >
    expect(images[0].imageableType).toBe('user')
    expect(images[0].imageable?.passwordHash).toBe('hash-a')

    const [image] = RelabelledImage.serializeMany(images) as Row[]
    expect(image).toEqual({ id: 1, url: 'avatar.png', imageable: { id: 1, name: 'Alice', email: 'alice@example.com' } })
  })

  it('filters a lazily referenced relation once a load has resolved it, without calling the reference', async () => {
    const users = (await User.newQuery().with('tokens').orderBy('id', 'asc').get()) as Array<
      UserRecord & { tokens: TokenRecord[] }
    >
    const calls = tokenThunkCalls

    const [alice] = User.serializeMany(users) as Array<Row & { tokens: Row[] }>
    expect(alice.tokens).toEqual([{ id: 1, userId: 1 }])
    expect(tokenThunkCalls).toBe(calls)
  })

  it('passes a lazily referenced relation no load has resolved through as it is', () => {
    const tokens = [{ id: 1, userId: 1, hashedToken: 'token-hash' }]
    const json = User.serialize({
      id: 1, name: 'Alice', email: 'alice@example.com', passwordHash: 'hash-a', unloadedTokens: tokens,
    }) as Row & { unloadedTokens: Row[] }

    expect(json).not.toHaveProperty('passwordHash')
    expect(json.unloadedTokens).toBe(tokens)
    expect(unloadedThunkCalls).toBe(0)
  })

  it('keeps every reference in a graph no reachable model filters', async () => {
    const posts = (await OpenPost.newQuery().with('author.posts').orderBy('id', 'asc').get()) as Array<
      PostRecord & { author: Row }
    >

    const many = OpenPost.serializeMany(posts) as Array<Row & { author: Row }>
    expect(many).toEqual(posts)
    for (const [index, post] of many.entries()) {
      expect(post.author).toBe(posts[index].author)
    }
  })

  it('terminates on a cyclic graph and filters every row on the cycle', () => {
    const user: PlainObject = { id: 1, name: 'Alice', email: 'alice@example.com', passwordHash: 'hash-a', posts: [] }
    const post: PlainObject = { id: 1, title: 'A1', authorId: 1, author: user }
    ;(user.posts as PlainObject[]).push(post)

    const json = Post.serialize(post) as Row & { author: Row & { posts: Array<Row & { author: Row }> } }
    expect(json.author).not.toHaveProperty('passwordHash')
    expect(json.author.posts[0].author).toBe(json.author)
    expect(user.passwordHash).toBe('hash-a')
    expect((user.posts as PlainObject[])[0]).toBe(post)
  })
})
