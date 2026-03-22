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
   import { defineModel } from '@guren/orm'
   import { posts } from '@/db/schema'

   export type PostRecord = typeof posts.$inferSelect

   export default class Post extends defineModel(posts) {}
   ```
3. **コントローラーを実装** — `app/Http/Controllers/PostController.ts`:
   ```ts
   import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
   import Post from '@/app/Models/Post'
   import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
   import { appPages } from '@/resources/js/pages/contracts'
   import { PageQuerySchema, PostIdParamSchema } from '@/app/Http/Validators/PostValidator'

   type PostsIndexProps = PaginatedPageProps<PostResourceData>

   export default class PostController extends Controller {
     async index() {
       const { page } = this.validateQuery(PageQuerySchema)
       const result = await Post.paginate({ page, perPage: 10, orderBy: ['publishedAt', 'desc'] })
       const paginator = paginate(result, { path: this.request.path ?? '/posts' })

       return this.inertia(appPages.posts.index, {
         data: result.data.map((post) => new PostResource(post).toJSON()),
         pagination: {
           meta: paginator.meta(),
           links: paginator.links(),
         },
       } satisfies PostsIndexProps)
     }

     async show() {
       const { id } = this.validateParams(PostIdParamSchema)
       const post = await Post.findOrFail(id)
       return this.inertia(appPages.posts.show, { post: new PostResource(post).toJSON() })
     }
   }
   ```
4. **ルートを登録** — `routes/web.ts` を更新:
   ```ts
   import { Router } from '@guren/core'
   import PostController from '@/app/Http/Controllers/PostController'

   export function registerWebRoutes(router: Router): void {
     router.group('/posts', (posts) => {
       posts.get('/', [PostController, 'index'])
       posts.get('/:id', [PostController, 'show'])
     })
   }
   ```
5. **Inertia ページを作成** — `resources/js/pages/contracts.ts` と `resources/js/pages/posts/Index.tsx` / `Show.tsx` を追加し、型付きの `data` / `pagination` / `post` props を読んで React UI を描画します。Vite のホットリロードと Inertia がブラウザ状態を同期してくれます。
