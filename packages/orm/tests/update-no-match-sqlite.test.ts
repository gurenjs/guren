import { beforeEach, describe, expect, it } from 'bun:test'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import type { PlainObject } from '../src/Model'
import type { ModelHooks } from '../src/hooks'
import type { ModelObserver, ModelObserverConstructor } from '../src/ModelObserver'
import { useSqlite } from './sqlite-fixture'

// Against the real bun:sqlite driver: what an update resolves to when its
// condition matches nothing is the driver's RETURNING answer, which a mocked
// adapter would decide for itself.

const postsTable = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  meta: text('meta'),
})

type PostRecord = typeof postsTable.$inferSelect

describe('Model.update() matching no row (bun:sqlite)', () => {
  const sqlite = useSqlite(`
    CREATE TABLE posts (id integer primary key autoincrement, title text not null, meta text);
    INSERT INTO posts (title, meta) VALUES ('first', '{"tags":["x"]}');
  `)

  const events: string[] = []
  beforeEach(() => {
    events.length = 0
  })

  const record = (name: string) => (data: PlainObject) => {
    events.push(`${name}:${data === undefined ? 'undefined' : String(data.title)}`)
  }

  class CastPost extends Model<PostRecord> {
    static override table = postsTable
    static override casts = { meta: 'json' } as const
  }

  class AccessorPost extends Model<PostRecord> {
    static override table = postsTable
    static override accessors = { shout: (r: PlainObject) => `${String(r.title)}!` }
  }

  class WatchedPost extends Model<PostRecord> {
    static override table = postsTable
    static override casts = { meta: 'json' } as const
    static override accessors = { shout: (r: PlainObject) => `${String(r.title)}!` }
    static override hooks: ModelHooks = {
      updating: record('hook:updating'),
      updated: record('hook:updated'),
      saved: record('hook:saved'),
    }
  }
  class Watcher implements ModelObserver {
    updated = record('observer:updated')
    saved = record('observer:saved')
  }
  WatchedPost.observe(Watcher as ModelObserverConstructor)

  const titles = () => sqlite().query<{ title: string }, []>('SELECT title FROM posts').all().map((row) => row.title)

  it('resolves to undefined on a model with casts', async () => {
    expect(await CastPost.update({ id: 99 }, { title: 'changed' })).toBeUndefined()
    expect(titles()).toEqual(['first'])
  })

  it('resolves to undefined on a model with accessors, not to a record of them', async () => {
    expect(await AccessorPost.update({ id: 99 }, { title: 'changed' })).toBeUndefined()
  })

  it('resolves to undefined from forceUpdate()', async () => {
    expect(await CastPost.forceUpdate({ id: 99 }, { title: 'changed' })).toBeUndefined()
    expect(await AccessorPost.forceUpdate({ id: 99 }, { title: 'changed' })).toBeUndefined()
  })

  it('runs no updated or saved callback, since nothing was updated', async () => {
    await WatchedPost.update({ id: 99 }, { title: 'changed' })
    expect(events).toEqual(['hook:updating:changed'])
  })

  it('still hands the updated row to the callbacks and the caller when one matches', async () => {
    const post = await WatchedPost.update({ id: 1 }, { title: 'changed' })
    expect(post).toEqual({ id: 1, title: 'changed', meta: { tags: ['x'] }, shout: 'changed!' } as never)
    expect(events).toEqual([
      'hook:updating:changed',
      'hook:updated:changed',
      'hook:saved:changed',
      'observer:updated:changed',
      'observer:saved:changed',
    ])
  })
})
