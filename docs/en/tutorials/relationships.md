# Part 3: Relationships: Comments

Your blog has posts and authors from [Part 2](./authentication.md). In this final part, readers get a voice: you add a `comments` table that belongs to both a post and a user, wire up the model relationships, and build a comment form on the post page.

Part 1's `add resource` generated a whole CRUD in one go, but a feature that hangs off posts — like comments — doesn't need standalone pages. For cases like this, the Guren way is to **scaffold the skeleton with the single-purpose `make:*` generators and write the domain shape yourself**. To finish, you derive spec views from the completed code, record the architectural decision, and connect everything in the Docs Graph.

**What you'll learn:**

- How to model a table that references two parents (`postId`, `authorId`)
- How to scaffold with `make:model` / `make:validator` / `make:resource` / `make:controller` and flesh out the results
- How to declare `hasMany` and `belongsTo` relationships with typed results
- How to eager-load relations with `findWithOrFail` and query-builder `.with()`
- How to post a nested resource (`POST /posts/:id/comments`) from an Inertia form
- How to connect generated specs and architecture decisions to the finished code with the Docs Graph

## 1. Define the comments table

The data shape is not a generator's job — you declare it in the schema, and everything else derives from there. Add a table below `posts` in `db/schema.ts`:

```ts
export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

`onDelete: 'cascade'` means deleting a post deletes its comments with it. This is a brand-new table, so a normal migration is enough — no reset needed:

```bash
bun run db:make create_comments_table
bun run db:migrate
```

## 2. Scaffold the skeleton

Generate the four layers the comment feature needs with single-purpose generators:

```bash
bunx guren make:model Comment
bunx guren make:validator Comment --fields "body:text"
bunx guren make:resource Comment
bunx guren make:controller Comment
```

Each lands in the right place with the project's conventions: `app/Models/Comment.ts`, `app/Http/Validators/CommentValidator.ts`, `app/Http/Resources/CommentResource.ts`, and `app/Http/Controllers/CommentController.ts`. Now flesh each file out with the comment-specific domain knowledge.

## 3. Finish the model: relationships

Add the mass-assignment allowlist and two `belongsTo` relations to the generated `app/Models/Comment.ts`:

```ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { comments } from '../../db/schema.js'
import type { PostRecord } from './Post.js'
import type { UserRecord } from './User.js'

export type CommentRecord = typeof comments.$inferSelect
export type CommentAuthor = Pick<UserRecord, 'id' | 'name'>

export class Comment extends defineModel(comments) {
  static fillable = ['postId', 'authorId', 'body']

  static override relationTypes: {
    post: BelongsToRecord<PostRecord>
    author: BelongsToRecord<CommentAuthor>
  } = {
    post: null,
    author: null,
  }
}

Comment.belongsTo('post', () => import('./Post.js').then((m) => m.Post), 'postId', 'id')
Comment.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

Then declare the inverse side. Update `app/Models/Post.ts` so a post has many comments (three spots change: two imports, `comments` in `relationTypes`, and the trailing `hasMany` line):

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

`hasMany('comments', ..., 'postId', 'id')` reads as "the comments whose `postId` matches this post's `id`". With `relationTypes` declared, eager-loaded `post.comments` is typed `CommentRecord[]`. The full relationship API is covered in the [Database guide](../guides/database.md).

## 4. Finish the validator and the resource

`make:validator` generated three schemas (payload, ID param, list query). For now you only need `CommentPayloadSchema` — the others wait for the day comments get pages of their own. Give the message a human touch in `app/Http/Validators/CommentValidator.ts`:

```ts
export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1, 'Comment is required.'),
})
```

The `make:resource` skeleton contains a comment telling you to map the remaining columns. Finish `app/Http/Resources/CommentResource.ts` into the shape of a comment with its author:

```ts
import { Resource } from '@guren/core'
import type { CommentAuthor, CommentRecord } from '../../Models/Comment.js'

type CommentWithAuthor = CommentRecord & { author?: CommentAuthor | null }

export interface CommentResourceData extends Record<string, unknown> {
  id: number
  body: string
  createdAt: string
  author: { name: string } | null
}

export class CommentResource extends Resource<CommentWithAuthor> {
  toArray(): CommentResourceData {
    return {
      id: this.resource.id as number,
      body: this.resource.body as string,
      createdAt: this.resource.createdAt as string,
      author: this.resource.author ? { name: this.resource.author.name } : null,
    }
  }

  override toJSON(): CommentResourceData {
    return super.toJSON() as CommentResourceData
  }
}
```

Same pattern as `PostResource` in Part 2: only `name` is copied from the author, so `passwordHash` never reaches the browser.

## 5. Implement the controller and register the route

Replace the placeholder `make:controller` generated with the comment-creation action (`app/Http/Controllers/CommentController.ts`):

```ts
import { Controller } from '@guren/core'
import { Comment } from '../../Models/Comment.js'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'
import { PostIdParamSchema } from '../Validators/PostValidator.js'

export default class CommentController extends Controller {
  async store(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
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

The route's `:id` is the post's ID, so we reuse `PostIdParamSchema` from `PostValidator`. `Post.findOrFail(id)` prevents comments on posts that don't exist, and `userOrFail` guarantees an author.

Register the route inside the auth group in `routes/web.ts` (the `authed` group from Part 2 — routes with a `body` schema live there):

```ts
import CommentController from '../app/Http/Controllers/CommentController.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'

    // inside posts.middleware('auth').group((authed) => { ... }):
      authed.post('/:id/comments', { name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
```

## 6. Load comments in the controller

Update `show` in `app/Http/Controllers/PostController.ts`:

```ts
import { Comment } from '../../Models/Comment.js'
import { CommentResource } from '../Resources/CommentResource.js'

// inside PostController:

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')
    const comments = await Comment.where('postId', id)
      .with('author')
      .orderBy('createdAt', 'desc')
      .get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
      comments: comments.map((comment) => new CommentResource(comment).toJSON()),
    })
  }
```

`Comment.where(...)` returns a query builder, so you can chain `.with('author')` (which eager-loads every comment's author in a single query rather than one query per comment) and the ordering. Each comment passes through `CommentResource` on its way to the page. Note that `Show.tsx`'s `Props` doesn't accept `comments` yet, so your editor flags a type error until the next step — that's expected.

## 7. Add the comment section to the page

Replace `resources/js/pages/posts/Show.tsx` with a version that lists comments and shows a form to signed-in users:

```tsx
import { Link, useForm, usePage } from '@inertiajs/react'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
  comments: CommentResourceData[]
}

export default function PostShow({ post, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const isAuthenticated = Boolean(props.auth?.user)
  const form = useForm({ body: '' })

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')}>Back</Link>
      <h1 className="text-3xl font-semibold">{post.title}</h1>
      <p className="text-sm text-zinc-500">by {post.author?.name ?? 'Unknown author'}</p>
      <p>{post.body}</p>
      <div className="flex gap-4">
        <Link href={route('posts.edit', { id: post.id })}>Edit</Link>
        <Link
          href={route('posts.destroy', { id: post.id })}
          method="delete"
          as="button"
          onBefore={() => window.confirm('Delete this post?')}
          className="text-red-600"
        >
          Delete
        </Link>
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

Highlights:

- `usePage().props.auth?.user` reads the shared auth props that Part 2's scaffolding exposes to every page — that's how the page decides between the form and the sign-in hint.
- On success, the redirect re-renders the page with fresh comments, and `form.reset()` clears the textarea.

Close the loop as usual: `bun run codegen` (automatic under `bun run dev`) picks up the `comments.store` route and the new `Props`, and `bunx guren check` verifies the wiring (you'll see one more missing-test warning — for `CommentController` — proof that `check` is paying attention).

## 8. Checkpoint: leave a comment

1. Signed out, open a post — you see the comment list and a "Sign in to leave a comment" hint.
2. Sign in (**demo@example.com** / **secret**), open a post, submit an empty comment — "Comment is required." appears.
3. Write a real comment — the page reloads and your comment shows at the top, attributed to "Demo User".

Your mini blog is complete: public reading, authenticated writing, and related data across three tables.

## 9. Connect what you built in the Docs Graph

The running app proves what the comment flow *does*. Now generate the views that summarize its structure, and record *why* comment authorship works this way.

First, bring the spec views up to date. The `comments` table and its relationships are new, so — just like in Part 2 — `bunx guren check --spec` will flag the views as stale. Regenerate to catch up:

```bash
bunx guren spec:generate
```

The refreshed `docs/spec/er.md` shows your three tables and their foreign keys, and `domain.md` shows the model relationships you declared here.

Next, create an architecture decision tied to the `Comment` entity:

```bash
bunx guren make:adr "Comments require authenticated authors" --entity Comment
```

Open the path the command printed (it starts with `docs/adr/0002-` in a fresh app) and replace the three placeholders:

```md
## Context

Comments are publicly readable, but allowing anonymous writes would leave no trusted identity for moderation and attribution.

## Decision

Creating a comment requires an authenticated session. The controller stores the authenticated user's ID as `authorId`; the browser never chooses the author.

## Consequences

Every comment has an accountable author. Signed-out readers can still read comments but must sign in to post one.
```

Validate both the declarations and the derived views before trusting the project knowledge:

```bash
bunx guren check --docs
bunx guren check --spec
```

`check --docs` verifies the ADR points at a real `Comment` model and code paths. `check --spec` verifies the committed views still match the code.

Query the neighborhood of `Comment` from the terminal — there are two lenses:

```bash
bunx guren docs:graph --entity Comment
bunx guren context Comment
```

`docs:graph` shows the documentation-side neighborhood (this ADR *governs* `Comment`), while `context Comment` assembles the code-side picture of the entity — its model columns and relations, routes, controller, resource, and the linked ADR — on one screen. It's the first command you (or an AI agent) will run when returning to this feature six months from now.

Finally, revisit [http://localhost:3333/_guren/docs](http://localhost:3333/_guren/docs), the viewer you've been checking since Part 1. Until now it held only the spec views derived from your code; this time the knowledge you **declared** joins the graph — the new ADR and the `Comment` entity it governs. Follow the edges to the related controller, and open the refreshed ER and domain views. You're reading the same verified relationships the CLI reported, now as a visual surface.

For the document format, trust metadata, drift verification, and agent workflows, see [Spec-Anchored Development](../guides/spec-anchored.md).

## Common trip-ups

**Comment authors show as "Unknown".**
The `.with('author')` call is missing in `PostController.show`, or `Comment.belongsTo('author', ...)` isn't registered (it must run at module load, after the class definition).

**Submitting a comment redirects to `/login` even though you're signed in.**
Your session reset (in-memory session driver plus a dev-server restart, or a hot reload triggered by backend edits) — sign in again. If it persists, confirm the route sits inside the `authed` group and the alias name has no typo.

**`no such table: comments`.**
The migration didn't run. `bun run db:make create_comments_table`, then `bun run db:migrate`.

**`FOREIGN KEY constraint failed` when creating a comment.**
The `postId` or `authorId` doesn't exist — usually stale dev data after a partial reset. Run `bun run db:reset --seed` and recreate a post.

**Type error on `route('comments.store', ...)`.**
The route manifest predates the new route. Run `bun run codegen`.

## Where to go next

You've now touched every layer of a Guren app. Go deeper on each:

- [Routing](../guides/routing.md) — route groups, model binding, named routes, middleware
- [Controllers](../guides/controllers.md) — responses, validation helpers, dependency resolution
- [Database & ORM](../guides/database.md) — scopes, relation counts, transactions, polymorphic relations
- [Authorization](../guides/authorization.md) — policies and gates for "only the author can edit"
- [Testing](../guides/testing.md) — close the test gaps `guren check` keeps pointing out, with controller and HTTP tests
- [CLI reference](../guides/cli.md) — the full picture of the `add` / `make:*` / `check` / `audit` commands you used in this series
