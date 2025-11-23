# チュートリアル: ブログ投稿アプリを作る

Guren の MVC スタックで基本的なブログを作る手順です。

1. **テーブルを用意** — `db/schema.ts` に Drizzle ヘルパーを追加します:
   ```ts
   export const posts = pgTable('posts', {
     id: serial('id').primaryKey(),
     title: varchar('title', { length: 255 }).notNull(),
     slug: varchar('slug', { length: 255 }).unique().notNull(),
     body: text('body').notNull(),
     publishedAt: timestamp('published_at').defaultNow(),
   })
   ```
   `bun run db:migrate` でスキーマを反映します。
2. **モデルを作成** — `app/Models/Post.ts` に記述:
   ```ts
   import { Model } from '@guren/core'
   import { posts } from '@/db/schema'

   export type PostRecord = typeof posts.$inferSelect

   export default class Post extends Model<PostRecord> {
     static override table = posts
     static override readonly recordType = {} as PostRecord
   }
   ```
3. **コントローラを実装** — `app/Http/Controllers/PostController.ts`:
   ```ts
   import { Controller } from '@guren/core'
   import Post from '@/app/Models/Post'

   export default class PostController extends Controller {
     async index() {
       const posts = await Post.orderBy('publishedAt', 'desc').get()
       return this.inertia('posts/Index', { posts })
     }

     async show(_, params: { id: string }) {
       const post = await Post.findOrFail(Number(params.id))
       return this.inertia('posts/Show', { post })
     }
   }
   ```
4. **ルートを登録** — `routes/web.ts` を更新:
   ```ts
   import PostController from '@/app/Http/Controllers/PostController'

   Route.group('/posts', () => {
     Route.get('/', [PostController, 'index'])
     Route.get('/:id', [PostController, 'show'])
   })
   ```
5. **Inertia ページを作成** — `resources/js/pages/posts/Index.tsx` と `Show.tsx` を追加し、`posts` / `post` props を読んで React UI を描画します。Vite のホットリロードと Inertia がブラウザ状態を同期してくれます。
