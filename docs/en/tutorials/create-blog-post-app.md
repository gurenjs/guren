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
   import { Model } from '@guren/core'
   import { posts } from '@/db/schema'

   export type PostRecord = typeof posts.$inferSelect

   export default class Post extends Model<PostRecord> {
     static override table = posts
     static override readonly recordType = {} as PostRecord
   }
   ```
3. **Build the controller** — `app/Http/Controllers/PostController.ts`:
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
4. **Register routes** — update `routes/web.ts`:
   ```ts
   import PostController from '@/app/Http/Controllers/PostController'

   Route.group('/posts', () => {
     Route.get('/', [PostController, 'index'])
     Route.get('/:id', [PostController, 'show'])
   })
   ```
5. **Create Inertia pages** — add `resources/js/pages/posts/Index.tsx` and `Show.tsx` that read the `posts` / `post` props and render React UI. Vite hot reload plus Inertia keep browser state synced as you edit.
