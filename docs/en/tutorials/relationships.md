# Part 3: Relationships: Comments

Your blog has posts and authors from [Part 2](./authentication.md). In this final part, readers get a voice: you add a `comments` table that belongs to both a post and a user, wire up the model relationships, and build a comment form on the post page.

**What you'll learn:**

- How to model a table that references two parents (`postId`, `authorId`)
- How to declare `hasMany` and `belongsTo` relationships with typed results
- How to eager-load relations with `findWithOrFail` and query-builder `.with()`
- How to post a nested resource (`POST /posts/:id/comments`) from an Inertia form

## 1. Define the comments table

Add the table to `db/schema.ts`, below `posts`:

```ts
export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

`onDelete: 'cascade'` means deleting a post removes its comments too. Since this is a brand-new table, a plain migration works — no reset needed this time:

```bash
bun run db:make create_comments_table
bun run db:migrate
```

## 2. Create the Comment model

Create `app/Models/Comment.ts`:

```ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { comments } from '../../db/schema.js'
import type { PostRecord } from './Post.js'
import type { UserRecord } from './User.js'

export type CommentRecord = typeof comments.$inferSelect

export class Comment extends defineModel(comments) {
  static fillable = ['postId', 'authorId', 'body']

  static override relationTypes: {
    post: BelongsToRecord<PostRecord>
    author: BelongsToRecord<Pick<UserRecord, 'id' | 'name'>>
  } = {
    post: null,
    author: null,
  }
}

Comment.belongsTo('post', () => import('./Post.js').then((m) => m.Post), 'postId', 'id')
Comment.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

Then declare the inverse side. Update `app/Models/Post.ts` so a post has many comments:

```ts
import { defineModel, type BelongsToRecord, type HasManyRecord } from '@guren/core'
import { posts } from '../../db/schema.js'
import type { CommentRecord } from './Comment.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert
export type PostAuthor = Pick<UserRecord, 'id' | 'name'>

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body', 'authorId']

  static override relationTypes: {
    author: BelongsToRecord<PostAuthor>
    comments: HasManyRecord<CommentRecord>
  } = {
    author: null,
    comments: [],
  }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
```

`hasMany('comments', ..., 'postId', 'id')` reads as: comments whose `postId` matches this post's `id`. With `relationTypes` declared, `post.comments` is typed as `CommentRecord[]` when eager-loaded.

## 3. Load comments in the controller

Update `show` in `app/Http/Controllers/PostController.ts` and add a validator import:

```ts
import { Comment } from '../../Models/Comment.js'

// inside PostController:

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')
    const comments = await Comment.where('postId', id)
      .with('author')
      .orderBy('createdAt', 'desc')
      .get()

    return this.inertia(pages.posts.Show, {
      post: {
        id: post.id,
        title: post.title,
        body: post.body,
        createdAt: post.createdAt,
        author: post.author ? { id: post.author.id, name: post.author.name } : null,
      },
      comments: comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        author: comment.author ? { name: comment.author.name } : null,
      })),
    })
  }
```

`Comment.where(...)` returns a query builder, so you can chain `.with('author')` (eager-load each comment's author in a batched lookup, not one query per comment) with ordering. As in Part 2, map the records to an explicit payload so no `passwordHash` ever reaches the browser.

## 4. Accept new comments

Create `app/Http/Validators/CommentValidator.ts`:

```ts
import { z } from 'zod'

export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1, 'Comment is required.'),
})

export const CommentPostParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})
```

Create `app/Http/Controllers/CommentController.ts`:

```ts
import { Controller } from '@guren/core'
import { Comment } from '../../Models/Comment.js'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPayloadSchema, CommentPostParamSchema } from '../Validators/CommentValidator.js'

export default class CommentController extends Controller {
  async store(): Promise<Response> {
    const { id } = this.validateParams(CommentPostParamSchema)
    const post = await Post.findOrFail(id)
    const data = await this.validateBody(CommentPayloadSchema)
    const user = await this.auth.userOrFail<UserRecord>()

    await Comment.create({
      postId: post.id,
      authorId: user.id,
      body: data.body,
    })

    return this.redirect(`/posts/${post.id}`)
  }
}
```

`Post.findOrFail(id)` guards against commenting on a post that doesn't exist, and `userOrFail` guarantees an author.

Register the route inside the existing `/posts` group in `routes/web.ts`:

```ts
import CommentController from '../app/Http/Controllers/CommentController.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'

  // inside router.group('/posts', (posts) => { ... }):
    posts.middleware('auth').post('/:id/comments', { name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
```

## 5. Add the comment section to the page

Replace `resources/js/pages/posts/Show.tsx` with a version that lists comments and shows a form to signed-in users:

```tsx
import { Link, useForm, usePage } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

interface CommentData {
  id: number
  body: string
  createdAt: string
  author: { name: string } | null
}

interface Props {
  post: {
    id: number
    title: string
    body: string
    createdAt: string
    author: { id: number; name: string } | null
  }
  comments: CommentData[]
}

export default function PostsShow({ post, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const isAuthenticated = Boolean(props.auth?.user)
  const form = useForm({ body: '' })

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')} className="text-sm text-zinc-500 hover:underline">
        &larr; Back to posts
      </Link>
      <h1 className="text-3xl font-semibold">{post.title}</h1>
      <p className="text-sm text-zinc-500">
        {new Date(post.createdAt).toLocaleDateString()} · {post.author?.name ?? 'Unknown author'}
      </p>
      <div className="space-y-4 leading-relaxed">
        {post.body.split('\n').map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>

      <section className="border-t pt-6">
        <h2 className="text-xl font-semibold">
          Comments{comments.length > 0 && ` (${comments.length})`}
        </h2>

        {comments.length === 0 ? (
          <p className="mt-4 text-zinc-500">No comments yet.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded border p-4">
                <p>{comment.body}</p>
                <p className="mt-2 text-sm text-zinc-500">
                  {comment.author?.name ?? 'Unknown'} ·{' '}
                  {new Date(comment.createdAt).toLocaleDateString()}
                </p>
              </li>
            ))}
          </ul>
        )}

        {isAuthenticated ? (
          <form
            className="mt-6 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              form.post(route('comments.store', { id: post.id }), {
                onSuccess: () => form.reset(),
              })
            }}
          >
            <label htmlFor="comment" className="block text-sm font-medium">
              Add a comment
            </label>
            <textarea
              id="comment"
              rows={3}
              value={form.data.body}
              onChange={(event) => form.setData('body', event.target.value)}
              className="w-full rounded border px-3 py-2"
            />
            {form.errors.body && <p className="text-sm text-red-600">{form.errors.body}</p>}
            <button
              type="submit"
              disabled={form.processing}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              Post comment
            </button>
          </form>
        ) : (
          <p className="mt-6 text-sm text-zinc-500">
            <Link href={route('login')} className="underline">
              Sign in
            </Link>{' '}
            to leave a comment.
          </p>
        )}
      </section>
    </main>
  )
}
```

Notes:

- `usePage().props.auth?.user` reads the shared auth props that the auth scaffold from Part 2 exposes to every page — that's how the page decides between the form and the sign-in prompt.
- On success the redirect re-renders the page with fresh comments, and `form.reset()` clears the textarea.

`Props` changed and a route was added, so refresh the manifests: `bun run codegen` (automatic under `bun run dev`).

## 6. Checkpoint: leave a comment

1. Open a post while signed out — you see the comment list and a "Sign in to leave a comment" prompt.
2. Sign in (**demo@example.com** / **secret**), open the post, submit an empty comment — "Comment is required." appears.
3. Write a real comment — the page reloads with your comment on top, attributed to "Demo User".

That's the full mini blog: public reading, authenticated writing, related data across three tables.

## Common problems

**Comments render with "Unknown" authors.**
The `.with('author')` call is missing in `PostController.show`, or `Comment.belongsTo('author', ...)` was never registered (it must run at module load, after the class definition).

**Submitting a comment redirects to `/login` even though you're signed in.**
Sessions were reset (dev server restart with the in-memory session driver) — sign in again. If it persists, confirm the route has `.middleware('auth')` and not a typo'd alias name.

**`no such table: comments`.**
The migration wasn't applied. Run `bun run db:make create_comments_table` then `bun run db:migrate`.

**`FOREIGN KEY constraint failed` when creating a comment.**
The `postId` or `authorId` doesn't exist — usually stale dev data after a partial reset. Run `bun run db:reset --seed` and recreate a post.

**`route('comments.store', ...)` is a type error.**
The route manifest predates the new route. Run `bun run codegen`.

## Where to go next

You've touched every layer of a Guren app. Deepen each one:

- [Routing](../guides/routing.md) — route groups, model binding, named routes, middleware
- [Controllers](../guides/controllers.md) — responses, validation helpers, dependency resolution
- [Database & ORM](../guides/database.md) — scopes, relation counts, transactions, polymorphic relations
- [Authorization](../guides/authorization.md) — policies and gates for "only the author can edit"
- [Testing](../guides/testing.md) — lock in everything you built with controller and HTTP tests
