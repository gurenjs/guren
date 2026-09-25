import { describe, expect, it } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { useSqlite } from './sqlite-fixture'

// `where(field, 'is null')` type-checks through the `(field, value)` overload on a
// nullable text column and would compile to `deleted_at = 'is null'`; only the
// real renderer shows the three-argument form reaching `IS NULL`.

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  deletedAt: text('deleted_at'),
})

type PostRecord = typeof postsTable.$inferSelect

describe('valueless where operators on the real bun:sqlite driver', () => {
  useSqlite(`
    CREATE TABLE posts (id integer primary key autoincrement, title text not null, deleted_at text);
    INSERT INTO posts (title, deleted_at) VALUES
      ('live', NULL),
      ('gone', '2026-01-01T00:00:00Z'),
      ('literal', 'is null');
  `)

  class Post extends Model<PostRecord> {
    static override table = postsTable
  }

  const titles = (rows: ReadonlyArray<{ title?: unknown }>) => rows.map((row) => String(row.title)).sort()

  it('should throw on where(field, "is null") and name whereNull()', () => {
    expect(() => Post.where('deletedAt', 'is null')).toThrow("Post: where('deletedAt', 'is null') would compare")
    expect(() => Post.where('deletedAt', 'is null')).toThrow("whereNull('deletedAt')")
    expect(() => Post.newQuery().where('deletedAt', 'is null')).toThrow("whereNull('deletedAt')")
  })

  it('should throw on where(field, "is not null") and name whereNotNull()', () => {
    expect(() => Post.where('deletedAt', 'is not null')).toThrow("whereNotNull('deletedAt')")
  })

  it('should throw on orWhere(field, "is null") and name the three-argument form', () => {
    expect(() => Post.where('title', 'live').orWhere('deletedAt', 'is null')).toThrow(
      "orWhere('deletedAt', 'is null', null)",
    )
    expect(() => Post.where('title', 'live').orWhere('deletedAt', 'is not null')).toThrow("whereNotNull('deletedAt')")
  })

  it('should throw inside a callback group', () => {
    expect(() => Post.where((q) => q.where('deletedAt', 'is null'))).toThrow("whereNull('deletedAt')")
  })

  it('should throw through a transaction scope', async () => {
    await expect(
      Post.transaction(async (_trx, txPost) => {
        txPost.where('deletedAt', 'is null')
      }),
    ).rejects.toThrow("whereNull('deletedAt')")
  })

  it('should match NULL rows with the three-argument operator form', async () => {
    expect(titles(await Post.where('deletedAt', 'is null', null).get())).toEqual(['live'])
    expect(titles(await Post.where('deletedAt', 'is not null', null).get())).toEqual(['gone', 'literal'])
    expect(titles(await Post.where('title', 'gone').orWhere('deletedAt', 'is null', null).get())).toEqual(['gone', 'live'])
  })

  it('should read the three-argument form with an undefined value in a transaction scope', async () => {
    const rows = await Post.transaction(async (_trx, txPost) => txPost.where('deletedAt', 'is null', undefined).get())
    expect(titles(rows)).toEqual(['live'])
  })

  it('should match the string itself through the "=" operator', async () => {
    expect(titles(await Post.where('deletedAt', '=', 'is null').get())).toEqual(['literal'])
  })

  it('should leave a value-taking operator token alone as a value', async () => {
    expect(await Post.where('deletedAt', 'like').get()).toEqual([])
  })
})
