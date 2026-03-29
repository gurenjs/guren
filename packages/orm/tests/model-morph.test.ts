import { describe, expect, it } from 'bun:test'
import { Model, type FindManyOptions, type ORMAdapter, type PlainObject, type WhereClause } from '../src/Model'

type PostRecord = { id: number; title: string }
type VideoRecord = { id: number; title: string }
type CommentRecord = { id: number; body: string; commentableType: string; commentableId: number }

function createMultiAdapter(stores: Record<string, PlainObject[]>): ORMAdapter {
  return {
    async findMany<T extends PlainObject>(table: unknown, options?: FindManyOptions<T>): Promise<T[]> {
      const store = stores[table as string] ?? []
      const { where } = options ?? {}
      if (!where) return store.map((r) => ({ ...r })) as unknown as T[]
      return store.filter((r) =>
        Object.entries(where as PlainObject).every(([k, v]) => {
          if (Array.isArray(v)) return v.includes(r[k])
          return r[k] === v
        }),
      ).map((r) => ({ ...r })) as unknown as T[]
    },
    async findUnique<T extends PlainObject>(table: unknown, where: WhereClause<T>): Promise<T | null> {
      const store = stores[table as string] ?? []
      const record = store.find((r) =>
        Object.entries(where as PlainObject).every(([k, v]) => {
          if (Array.isArray(v)) return v.includes(r[k])
          return r[k] === v
        }),
      )
      return (record ? { ...record } : null) as unknown as T | null
    },
    async create<T extends PlainObject>(table: unknown, data: PlainObject): Promise<T> {
      return data as unknown as T
    },
  }
}

describe('Polymorphic Relationships', () => {
  it('morphMany loads related records filtered by type and id', async () => {
    class Post extends Model<PostRecord> { static table = 'posts' }
    class Comment extends Model<CommentRecord> { static table = 'comments' }

    Post.morphMany('comments', Comment, 'commentable', 'id')

    const adapter = createMultiAdapter({
      posts: [{ id: 1, title: 'Post A' }, { id: 2, title: 'Post B' }],
      comments: [
        { id: 10, body: 'Nice post', commentableType: 'Post', commentableId: 1 },
        { id: 11, body: 'Great', commentableType: 'Post', commentableId: 1 },
        { id: 12, body: 'On video', commentableType: 'Video', commentableId: 1 },
        { id: 13, body: 'Post B comment', commentableType: 'Post', commentableId: 2 },
      ],
    })

    Post.useAdapter(adapter)
    Comment.useAdapter(adapter)

    const posts = await Post.with('comments') as any[]
    expect(posts[0].comments).toHaveLength(2)
    expect(posts[0].comments[0].body).toBe('Nice post')
    expect(posts[1].comments).toHaveLength(1)
    expect(posts[1].comments[0].body).toBe('Post B comment')
  })

  it('morphMany returns empty array when no matches', async () => {
    class Post extends Model<PostRecord> { static table = 'posts' }
    class Comment extends Model<CommentRecord> { static table = 'comments' }

    Post.morphMany('comments', Comment, 'commentable', 'id')

    const adapter = createMultiAdapter({
      posts: [{ id: 1, title: 'Post A' }],
      comments: [],
    })

    Post.useAdapter(adapter)
    Comment.useAdapter(adapter)

    const posts = await Post.with('comments') as any[]
    expect(posts[0].comments).toEqual([])
  })

  it('morphTo resolves parent using morphMap', async () => {
    class Post extends Model<PostRecord> { static table = 'posts' }
    class Video extends Model<VideoRecord> { static table = 'videos' }
    class Comment extends Model<CommentRecord> { static table = 'comments' }

    Comment.morphTo('commentable', 'commentable')
    Model.morphMap = { Post, Video }

    const adapter = createMultiAdapter({
      posts: [{ id: 1, title: 'My Post' }],
      videos: [{ id: 1, title: 'My Video' }],
      comments: [
        { id: 10, body: 'On post', commentableType: 'Post', commentableId: 1 },
        { id: 11, body: 'On video', commentableType: 'Video', commentableId: 1 },
      ],
    })

    Post.useAdapter(adapter)
    Video.useAdapter(adapter)
    Comment.useAdapter(adapter)

    const comments = await Comment.with('commentable') as any[]
    expect(comments[0].commentable.title).toBe('My Post')
    expect(comments[1].commentable.title).toBe('My Video')

    Model.morphMap = undefined
  })

  it('morphTo returns null when type not in morphMap', async () => {
    class Comment extends Model<CommentRecord> { static table = 'comments' }

    Comment.morphTo('commentable', 'commentable')
    Model.morphMap = {}

    const adapter = createMultiAdapter({
      comments: [
        { id: 10, body: 'Orphan', commentableType: 'Unknown', commentableId: 1 },
      ],
    })

    Comment.useAdapter(adapter)

    const comments = await Comment.with('commentable') as any[]
    expect(comments[0].commentable).toBeNull()

    Model.morphMap = undefined
  })
})
