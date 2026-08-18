import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { Model } from '../src/Model'
import { DrizzleAdapter } from '../src/adapters/drizzle-adapter'

// Integration test against the real bun:sqlite driver. The fake-adapter
// tests cannot catch SQL placeholder bugs (e.g. eq(column, array) binding
// one placeholder to N values), which broke eager loading for 2+ parents.

const usersTable = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
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
})

const tagsTable = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

const postTagsTable = sqliteTable('post_tags', {
  postId: integer('post_id').notNull(),
  tagId: integer('tag_id').notNull(),
})

const imagesTable = sqliteTable('images', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  url: text('url').notNull(),
  imageableType: text('imageable_type').notNull(),
  imageableId: integer('imageable_id').notNull(),
})

type UserRecord = typeof usersTable.$inferSelect
type PostRecord = typeof postsTable.$inferSelect
type CommentRecord = typeof commentsTable.$inferSelect
type TagRecord = typeof tagsTable.$inferSelect
type ImageRecord = typeof imagesTable.$inferSelect

type PlainRow = Record<string, unknown> & { title?: string; name?: string }
type UserWithPosts = UserRecord & { posts: PostRecord[] }
type UserWithPostComments = UserRecord & {
  posts: Array<PostRecord & { comments: CommentRecord[] }>
}
type UserWithPostCommentsAndTags = UserRecord & {
  posts: Array<PostRecord & { comments: CommentRecord[]; tags: TagRecord[] }>
}
type PostWithAuthor = PostRecord & { author: UserRecord | null }
type UserWithPostAuthors = UserRecord & { posts: PostWithAuthor[] }

describe('relations on real bun:sqlite driver', () => {
  let sqlite: Database

  class User extends Model<UserRecord> {
    static override table = usersTable
  }

  class Post extends Model<PostRecord> {
    static override table = postsTable
  }

  class Comment extends Model<CommentRecord> {
    static override table = commentsTable
  }

  class Tag extends Model<TagRecord> {
    static override table = tagsTable
  }

  class Image extends Model<ImageRecord> {
    static override table = imagesTable
  }

  User.hasMany('posts', Post, 'authorId', 'id')
  Post.belongsTo('author', User, 'authorId', 'id')
  Post.hasMany('comments', Comment, 'postId', 'id')
  Post.belongsToMany('tags', Tag, postTagsTable, 'postId', 'tagId', 'id', 'id')
  Post.morphMany('images', Image, 'imageable', 'id')
  Image.morphTo('imageable', 'imageable')
  // users -> posts (through) -> comments
  User.hasManyThrough('postComments', Comment, Post, 'authorId', 'postId', 'id', 'id')

  beforeEach(() => {
    sqlite = new Database(':memory:')
    sqlite.exec(`
      CREATE TABLE users (id integer primary key autoincrement, name text not null);
      CREATE TABLE posts (id integer primary key autoincrement, title text not null, author_id integer not null);
      CREATE TABLE comments (id integer primary key autoincrement, body text not null, post_id integer not null);
      CREATE TABLE tags (id integer primary key autoincrement, name text not null);
      CREATE TABLE images (id integer primary key autoincrement, url text not null, imageable_type text not null, imageable_id integer not null);
      CREATE TABLE post_tags (post_id integer not null, tag_id integer not null);
      INSERT INTO users (name) VALUES ('Alice'), ('Bob'), ('Carol');
      INSERT INTO posts (title, author_id) VALUES
        ('A1', 1), ('A2', 1), ('B1', 2);
      INSERT INTO comments (body, post_id) VALUES
        ('keep', 1), ('drop', 1), ('keep', 2), ('drop', 3);
      INSERT INTO tags (name) VALUES ('news'), ('draft');
      INSERT INTO post_tags (post_id, tag_id) VALUES (1, 1), (1, 2), (2, 2);
      INSERT INTO images (url, imageable_type, imageable_id) VALUES
        ('cover.png', 'Post', 1), ('inline.png', 'Post', 1), ('cover.png', 'User', 1),
        ('p2.png', 'Post', 2), ('u2.png', 'User', 2);
    `)
    DrizzleAdapter.configure(drizzle({ client: sqlite }) as never)
  })

  afterEach(() => {
    sqlite.close()
  })

  it('should filter with array where (IN) across multiple values', async () => {
    const posts = await Post.where({ authorId: [1, 2] })
    expect(posts).toHaveLength(3)

    const single = await Post.where({ authorId: [2] })
    expect(single).toHaveLength(1)
    expect(single[0].title).toBe('B1')
  })

  it('should eager load hasMany for more than one parent record', async () => {
    const users = (await User.with('posts')) as UserWithPosts[]

    expect(users).toHaveLength(3)
    expect(users.find((u) => u.name === 'Alice')?.posts.map((p) => p.title).sort()).toEqual(['A1', 'A2'])
    expect(users.find((u) => u.name === 'Bob')?.posts).toHaveLength(1)
    expect(users.find((u) => u.name === 'Carol')?.posts).toEqual([])
  })

  it('should eager load belongsTo across multiple children', async () => {
    const posts = (await Post.with('author')) as PostWithAuthor[]

    expect(posts).toHaveLength(3)
    expect(posts.find((p) => p.title === 'A1')?.author?.name).toBe('Alice')
    expect(posts.find((p) => p.title === 'B1')?.author?.name).toBe('Bob')
  })

  it('should attach counts via withCount', async () => {
    const users = (await User.withCount('posts')) as Array<UserRecord & { postsCount: number }>

    expect(users.find((u) => u.name === 'Alice')?.postsCount).toBe(2)
    expect(users.find((u) => u.name === 'Bob')?.postsCount).toBe(1)
    expect(users.find((u) => u.name === 'Carol')?.postsCount).toBe(0)
  })

  it('should support orWhere with array values', async () => {
    const posts = await Post.where({ authorId: 1 }).orWhere({ authorId: [2] }).get()
    expect(posts).toHaveLength(3)
  })

  // paginate() once handed back the raw rows from executeQuery(), so
  // `.with('author').paginate(...)` returned pages whose relation was missing
  // while the same chain ending in `.get()` attached it — the blog starter's
  // /posts index rendered without author names because of it. It delegates to
  // get() now; these assert that on the real driver, which the in-memory
  // adapter used elsewhere cannot speak for.
  it('should eager load through paginate() like get() does', async () => {
    const query = () => Post.newQuery().with('author').orderBy('id', 'desc')

    const viaGet = (await query().limit(2).get()) as PostWithAuthor[]
    const page = await query().paginate({ page: 1, perPage: 2 })
    const viaPaginate = page.data as PostWithAuthor[]

    expect(viaPaginate.map((p) => p.title)).toEqual(['B1', 'A2'])
    expect(viaPaginate.map((p) => p.author?.name)).toEqual(['Bob', 'Alice'])
    expect(viaPaginate).toEqual(viaGet)
    expect(page.meta).toMatchObject({ total: 3, perPage: 2, currentPage: 1, totalPages: 2, hasMore: true })

    // The remaining page loads its relation as well.
    const last = await query().paginate({ page: 2, perPage: 2 })
    expect((last.data as PostWithAuthor[]).map((p) => [p.title, p.author?.name])).toEqual([['A1', 'Alice']])
  })

  it('should eager load nested paths through paginate()', async () => {
    const page = await User.newQuery().with('posts.author').orderBy('id', 'asc').paginate(1, 2)
    const users = page.data as UserWithPostAuthors[]

    expect(users.map((u) => u.name)).toEqual(['Alice', 'Bob'])
    expect(users[0].posts.map((p) => p.title).sort()).toEqual(['A1', 'A2'])
    expect(users[0].posts.every((p) => p.author?.name === 'Alice')).toBe(true)
    expect(users[1].posts.map((p) => p.author?.name)).toEqual(['Bob'])
  })

  it('should restore the builder\'s own limit/offset after paginate()', async () => {
    // The builder carries its own slice (rows 2..3); paginate() must not
    // leave its page-2 slice (row 3 only) behind, nor clear the slice.
    const builder = Post.newQuery().with('author').orderBy('id', 'asc').limit(2).offset(1)
    const page = await builder.paginate({ page: 2, perPage: 1 })
    expect((page.data as PostWithAuthor[]).map((p) => [p.title, p.author?.name])).toEqual([['A2', 'Alice']])

    const after = (await builder.get()) as PostWithAuthor[]
    expect(after.map((p) => [p.title, p.author?.name])).toEqual([['A2', 'Alice'], ['B1', 'Bob']])
  })

  it('should apply a with() constraint callback to an eager-loaded relation', async () => {
    const users = (await User.newQuery()
      .with({ posts: (q) => q.where('title', 'A1') })
      .get()) as UserWithPosts[]

    expect(users).toHaveLength(3)
    expect(users.find((u) => u.name === 'Alice')?.posts.map((p) => p.title)).toEqual(['A1'])
    expect(users.find((u) => u.name === 'Bob')?.posts).toEqual([])
    expect(users.find((u) => u.name === 'Carol')?.posts).toEqual([])
  })

  it('should apply a constraint to a belongsTo relation', async () => {
    const posts = (await Post.newQuery()
      .with({ author: (q) => q.where('name', 'Alice') })
      .get()) as PostWithAuthor[]

    expect(posts.find((p) => p.title === 'A1')?.author?.name).toBe('Alice')
    expect(posts.find((p) => p.title === 'B1')?.author).toBeNull()
  })

  it('should constrain the level a dotted key names, not the head', async () => {
    const users = (await User.newQuery()
      .with({ 'posts.comments': (q) => q.where('body', 'keep') })
      .get()) as UserWithPostComments[]

    const alice = users.find((u) => u.name === 'Alice')
    // head is unconstrained: both of Alice's posts load
    expect(alice?.posts.map((p) => p.title).sort()).toEqual(['A1', 'A2'])
    // leaf is constrained: only 'keep' comments attach
    expect(alice?.posts.find((p) => p.title === 'A1')?.comments.map((c) => c.body)).toEqual(['keep'])
    expect(alice?.posts.find((p) => p.title === 'A2')?.comments.map((c) => c.body)).toEqual(['keep'])
  })

  it('should keep a head constraint when a nested path re-walks the same relation', async () => {
    const users = (await User.newQuery()
      .with({ posts: (q) => q.where('title', 'A1') })
      .with('posts.comments')
      .get()) as UserWithPostComments[]

    const alice = users.find((u) => u.name === 'Alice')
    // the nested path must not re-load `posts` unconstrained
    expect(alice?.posts.map((p) => p.title)).toEqual(['A1'])
    expect(alice?.posts[0]?.comments.map((c) => c.body).sort()).toEqual(['drop', 'keep'])
  })

  it('should constrain both levels when both keys carry a callback', async () => {
    const users = (await User.newQuery()
      .with({ posts: (q) => q.where('title', 'A1'), 'posts.comments': (q) => q.where('body', 'keep') })
      .get()) as UserWithPostComments[]

    const alice = users.find((u) => u.name === 'Alice')
    expect(alice?.posts.map((p) => p.title)).toEqual(['A1'])
    expect(alice?.posts[0]?.comments.map((c) => c.body)).toEqual(['keep'])
  })

  it('should carry constraints through paginate()', async () => {
    const page = await User.newQuery()
      .with({ posts: (q) => q.where('title', 'A1') })
      .orderBy('id')
      .paginate(1, 2)
    const data = page.data as UserWithPosts[]

    expect(data.find((u) => u.name === 'Alice')?.posts.map((p) => p.title)).toEqual(['A1'])
  })

  it('should apply a constraint through first()', async () => {
    const alice = (await User.newQuery()
      .with({ posts: (q) => q.where('title', 'A1') })
      .orderBy('id')
      .first()) as UserWithPosts | null

    expect(alice?.name).toBe('Alice')
    expect(alice?.posts.map((p) => p.title)).toEqual(['A1'])
  })

  it('should constrain the related rows of a belongsToMany, not the pivot lookup', async () => {
    const posts = (await Post.newQuery()
      .with({ tags: (q) => q.where('name', 'news') })
      .get()) as Array<PostRecord & { tags: TagRecord[] }>

    // post A1 is tagged both 'news' and 'draft' via the pivot; only 'news' survives
    expect(posts.find((p) => p.title === 'A1')?.tags.map((t) => t.name)).toEqual(['news'])
    // post A2's only tag is 'draft', so it ends up with none
    expect(posts.find((p) => p.title === 'A2')?.tags).toEqual([])
    // unconstrained, A1 keeps both
    const all = (await Post.newQuery().with('tags').get()) as Array<PostRecord & { tags: TagRecord[] }>
    expect(all.find((p) => p.title === 'A1')?.tags.map((t) => t.name).sort()).toEqual(['draft', 'news'])
  })

  it('should constrain a morphMany without dropping the morph type filter', async () => {
    const posts = (await Post.newQuery()
      .with({ images: (q) => q.where('url', 'cover.png') })
      .get()) as Array<PostRecord & { images: ImageRecord[] }>

    const a1 = posts.find((p) => p.title === 'A1')
    // the User-owned 'cover.png' row must not leak in alongside the constraint
    expect(a1?.images).toHaveLength(1)
    expect(a1?.images[0]?.imageableType).toBe('Post')
    expect(a1?.images[0]?.url).toBe('cover.png')
  })

  it('should not let a widened constraint attach another type\'s morphMany rows', async () => {
    // `orWhere` escapes the type filter the loader puts on the query, so the
    // User-owned 'cover.png' comes back in the result set. It must not land on
    // a Post.
    const posts = (await Post.newQuery()
      .with({ images: (q) => q.orWhere('url', 'cover.png') })
      .get()) as Array<PostRecord & { images: ImageRecord[] }>

    const a1 = posts.find((p) => p.title === 'A1')
    expect(a1?.images.map((i) => i.imageableType)).toEqual(['Post', 'Post'])
    expect(a1?.images.map((i) => i.url).sort()).toEqual(['cover.png', 'inline.png'])
  })

  it('should apply a morphTo constraint to every morph target', async () => {
    Model.morphMap = { Post, User }
    try {
      const images = (await Image.newQuery()
        .with({ imageable: (q) => q.where('id', 1) })
        .get()) as Array<ImageRecord & { imageable: PlainRow | null }>

      const byUrl = (url: string, type: string) =>
        images.find((i) => i.url === url && i.imageableType === type)

      // both target queries saw the constraint: id 1 resolves for each class...
      expect(byUrl('cover.png', 'Post')?.imageable?.title).toBe('A1')
      expect(byUrl('cover.png', 'User')?.imageable?.name).toBe('Alice')
      // ...and id 2 is excluded for each class
      expect(byUrl('p2.png', 'Post')?.imageable).toBeNull()
      expect(byUrl('u2.png', 'User')?.imageable).toBeNull()
    } finally {
      Model.morphMap = undefined
    }
  })

  it('should constrain both levels regardless of key order', async () => {
    // the dotted key is listed first here; the bare `posts` key must not
    // re-load `posts` afterwards and drop the comments already attached
    const users = (await User.newQuery()
      .with({ 'posts.comments': (q) => q.where('body', 'keep'), posts: (q) => q.where('title', 'A1') })
      .get()) as UserWithPostComments[]

    const alice = users.find((u) => u.name === 'Alice')
    expect(alice?.posts.map((p) => p.title)).toEqual(['A1'])
    expect(alice?.posts[0]?.comments.map((c) => c.body)).toEqual(['keep'])
  })

  it('should constrain the related rows of a hasManyThrough, not the through lookup', async () => {
    const users = (await User.newQuery()
      .with({ postComments: (q) => q.where('body', 'keep') })
      .get()) as Array<UserRecord & { postComments: CommentRecord[] }>

    // Alice's posts A1/A2 carry comments keep/drop/keep; only the keeps survive,
    // and the through read still finds both posts
    const alice = users.find((u) => u.name === 'Alice')
    expect(alice?.postComments.map((c) => c.body)).toEqual(['keep', 'keep'])
    expect(alice?.postComments.map((c) => c.postId).sort()).toEqual([1, 2])

    const unconstrained = (await User.newQuery().with('postComments').get()) as Array<
      UserRecord & { postComments: CommentRecord[] }
    >
    expect(unconstrained.find((u) => u.name === 'Alice')?.postComments.map((c) => c.body).sort()).toEqual([
      'drop',
      'keep',
      'keep',
    ])
  })

  it('should load both sibling nested paths under a shared head', async () => {
    const users = (await User.newQuery()
      .with('posts.comments', 'posts.tags')
      .get()) as UserWithPostCommentsAndTags[]

    const a1 = users.find((u) => u.name === 'Alice')?.posts.find((p) => p.title === 'A1')
    // the shared head `posts` is loaded once, so neither sibling replaces the
    // row objects the other already attached children to
    expect(a1?.comments.map((c) => c.body).sort()).toEqual(['drop', 'keep'])
    expect(a1?.tags.map((t) => t.name).sort()).toEqual(['draft', 'news'])
  })

  it('should load both sibling nested paths regardless of their order', async () => {
    const users = (await User.newQuery()
      .with('posts.tags', 'posts.comments')
      .get()) as UserWithPostCommentsAndTags[]

    const a1 = users.find((u) => u.name === 'Alice')?.posts.find((p) => p.title === 'A1')
    expect(a1?.comments.map((c) => c.body).sort()).toEqual(['drop', 'keep'])
    expect(a1?.tags.map((t) => t.name).sort()).toEqual(['draft', 'news'])
  })

  it('should keep sibling nested paths when each carries its own constraint', async () => {
    const users = (await User.newQuery()
      .with({
        'posts.tags': (q) => q.where('name', 'news'),
        'posts.comments': (q) => q.where('body', 'keep'),
      })
      .get()) as UserWithPostCommentsAndTags[]

    const a1 = users.find((u) => u.name === 'Alice')?.posts.find((p) => p.title === 'A1')
    expect(a1?.comments.map((c) => c.body)).toEqual(['keep'])
    expect(a1?.tags.map((t) => t.name)).toEqual(['news'])
  })

  it('should load a bare path and a nested path that share a head', async () => {
    const users = (await User.newQuery()
      .with('posts', 'posts.comments')
      .get()) as UserWithPostComments[]

    const alice = users.find((u) => u.name === 'Alice')
    expect(alice?.posts.map((p) => p.title).sort()).toEqual(['A1', 'A2'])
    expect(alice?.posts.find((p) => p.title === 'A1')?.comments.map((c) => c.body).sort()).toEqual([
      'drop',
      'keep',
    ])
  })

  it('should load sibling nested paths through Model.with()', async () => {
    const users = (await User.with(['posts.comments', 'posts.tags'])) as UserWithPostCommentsAndTags[]

    const a1 = users.find((u) => u.name === 'Alice')?.posts.find((p) => p.title === 'A1')
    expect(a1?.comments.map((c) => c.body).sort()).toEqual(['drop', 'keep'])
    expect(a1?.tags.map((t) => t.name).sort()).toEqual(['draft', 'news'])
  })

  it('should reject a nested path that walks through a morphTo relation', async () => {
    Model.morphMap = { Post, User }
    try {
      await expect(Image.newQuery().with('imageable.author').get()).rejects.toThrow(
        /nested eager loading through morphTo relation "imageable"/,
      )
    } finally {
      Model.morphMap = undefined
    }
  })

  it('should reject a nested morphTo path even when there are no records to load', async () => {
    // the throw has to stay ahead of any children inspection, so an empty
    // result set still reports the unsupported path instead of resolving
    Model.morphMap = { Post, User }
    try {
      await expect(Image.loadRelationInto([], 'imageable.author')).rejects.toThrow(
        /nested eager loading through morphTo relation "imageable"/,
      )
    } finally {
      Model.morphMap = undefined
    }
  })

  it('should reject a path with a trailing dot instead of reading it as bare', async () => {
    // `posts.` names an empty tail segment; silently treating it as `posts`
    // would swallow a typo that used to be reported
    await expect(User.newQuery().with('posts.' as never).get()).rejects.toThrow(
      /unknown relation ""/,
    )
  })
})
