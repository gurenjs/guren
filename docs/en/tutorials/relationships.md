# Relationships: Posts & Comments

Connect related models and eager-load their data.

1. **Define tables** — extend `db/schema.ts` with a comments table referencing posts:
   ```ts
   export const comments = pgTable('comments', {
     id: serial('id').primaryKey(),
     postId: integer('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
     author: varchar('author', { length: 120 }).notNull(),
     body: text('body').notNull(),
     createdAt: timestamp('created_at').defaultNow(),
   })
   ```
2. **Create models** — `Comment` references `Post` through helper methods:
   ```ts
   export type CommentRecord = typeof comments.$inferSelect

   export class Comment extends Model<CommentRecord> {
     static override table = comments
     static override readonly recordType = {} as CommentRecord
   }

   export class Post extends Model<PostRecord> {
     static override table = posts

     comments() {
       return this.hasMany(Comment, 'postId')
     }
   }
   ```
3. **Load relationships** — use eager-loading helpers in controllers:
   ```ts
   const post = await Post.with('comments').findOrFail(id)
   return this.inertia('posts/Show', { post })
   ```
   `with('comments')` tells the ORM adapter to retrieve all matching comments in one query when supported (Drizzle joins) or via batched lookups.
4. **Create comments** — add a `store` method on `CommentController`:
   ```ts
   await Comment.create({ postId: Number(params.id), author, body })
   return this.redirect(`/posts/${params.id}`)
   ```
5. **Render nested data** — in `resources/js/pages/posts/Show.tsx`, map over `post.comments` to show each comment. Because Inertia serializes nested objects, keep payloads lean by selecting only the fields you need.

Keep iterating: add policies so only authenticated users can comment, sprinkle validation with Zod, and write Vitest suites to lock in behavior as the app grows.
