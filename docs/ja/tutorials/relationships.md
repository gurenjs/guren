# チュートリアル: リレーションシップを扱う

関連するモデルを接続し、関連データを eager load します。

1. **テーブルを定義** — `db/schema.ts` に投稿を参照する comments テーブルを追加:
   ```ts
   export const comments = pgTable('comments', {
     id: serial('id').primaryKey(),
     postId: integer('post_id').references(() => posts.id, { onDelete: 'cascade' }).notNull(),
     author: varchar('author', { length: 120 }).notNull(),
     body: text('body').notNull(),
     createdAt: timestamp('created_at').defaultNow(),
   })
   ```
2. **モデルを作成** — `Comment` を用意し、`Post` からヘルパーで参照:
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
3. **リレーションを読み込む** — コントローラで eager load:
   ```ts
   const post = await Post.with('comments').findOrFail(id)
   return this.inertia('posts/Show', { post })
   ```
   `with('comments')` で関連コメントを一括取得します（Drizzle なら JOIN、もしくはバッチルックアップ）。
4. **コメントを作成** — `CommentController` に `store` を追加:
   ```ts
   await Comment.create({ postId: Number(params.id), author, body })
   return this.redirect(`/posts/${params.id}`)
   ```
5. **ネストを描画** — `resources/js/pages/posts/Show.tsx` で `post.comments` を map して表示。Inertia はネストをシリアライズするので、必要なフィールドだけを送るようにすると payload が軽く保てます。

発展として、認証ユーザーだけがコメントできるようポリシーを追加したり、Zod でバリデーションを加え、Vitest で動作を固定していきましょう。
