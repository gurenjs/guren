# Create a Blog Post App

Hands-on steps for building a basic blog using Guren’s MVC stack.

1. **Scaffold database tables** — edit `db/schema.ts` and add Drizzle helpers:
   ```ts
   export const posts = pgTable('posts', {
     id: serial('id').primaryKey(),
     title: varchar('title', { length: 255 }).notNull(),
     slug: varchar('slug', { length: 255 }).unique().notNull(),
     body: text('body').notNull(),
     publishedAt: timestamp('published_at').defaultNow(),
   })
   ```
   Run `bun run db:migrate` to sync the schema.
2. **Create the model** — inside `app/Models/Post.ts`:
   ```ts
   import { defineModel } from '@guren/orm'
   import { posts } from '@/db/schema'

   export type PostRecord = typeof posts.$inferSelect

   export default class Post extends defineModel(posts) {}
   ```
3. **Build the controller** — `app/Http/Controllers/PostController.ts`:
   ```ts
   import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
   import Post from '@/app/Models/Post'
   import { PostResource, type PostResourceData } from '@/app/Http/Resources/PostResource'
   import { pages } from '@/.guren/pages.gen'
   import { PageQuerySchema, PostIdParamSchema } from '@/app/Http/Validators/PostValidator'

   type PostsIndexProps = PaginatedPageProps<PostResourceData>

   export default class PostController extends Controller {
     async index() {
       const { page } = this.validateQuery(PageQuerySchema)
       const result = await Post.paginate({ page, perPage: 10, orderBy: ['publishedAt', 'desc'] })
       const paginator = paginate(result, { path: this.request.path ?? '/posts' })

       return this.inertia(pages.posts.Index, {
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
       return this.inertia(pages.posts.Show, { post: new PostResource(post).toJSON() })
     }
   }
   ```
4. **Register routes** — update `routes/web.ts`:
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
5. **Create Inertia pages** — add `resources/js/pages/posts/Index.tsx` and `Show.tsx` that define `interface Props` and render React UI with the typed `data` / `pagination` / `post` props. Run `bun run codegen` to generate `.guren/pages.gen.ts`. Vite hot reload plus Inertia keep browser state synced as you edit.
