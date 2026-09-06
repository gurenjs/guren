# Chapter 10: Files

A blog wants pictures. This chapter installs Guren's attachments layer, gives every post a cover image that is stored outside the public directory and served through a signed URL, and then hands the agent a gallery. Along the way `guren check` gets a new set of things to be right about, and you see it catch the one mistake that turns "private" into "public".

**What you'll learn:**

- What an upload is on the server: a `File` in a multipart body, a row in the `attachments` table, an object on a disk
- Why uploads never live under `public/`, and what a signed delivery route does instead
- How a model declares its attachments, and the four calls that manage them: `attach`, `withAttachments`, `detach`, `purgeAttachments`
- How a form sends a file and how a test does
- The attachment rules `guren check` enforces, and why one of them is a hard failure

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. The attachments layer

One command installs it:

```bash run
bunx guren add attachments
```

Read what it did, because you will be maintaining it. It installed the storage layer first (`app/Providers/StorageProvider.ts`, two disks: `local` rooted at `./storage/app` and `public` rooted at `./public/storage`). Then it added an `attachments` table to `db/schema.ts`, wrote `config/attachments.ts` and `app/Providers/AttachmentsProvider.ts`, registered the provider in `src/app.ts`, mounted the delivery route by calling `registerAttachmentRoutes` at the top of your route registrar, and registered an `attachments:prune` console command. The table needs its migration:

```bash run
bun run db:make create_attachments
```

```bash run
bun run db:migrate
```

Two hand edits. The disks hold files nothing should commit:

```bash run
printf 'storage/app/\npublic/storage/\n' >> .gitignore
```

And the config gets one line the generator cannot write for you, because it does not know which of your models will carry attachments. The prune command needs the map to check that an attachment's owner still exists:

```ts file=config/attachments.ts
import { Model, configureAttachments, getContainer } from '@guren/core'
import { attachments } from '../db/schema'
import { Post } from '../app/Models/Post.js'

/**
 * Wires the attachments layer once at boot (AttachmentsProvider imports this
 * module). `Attachment` is the app-local model over the attachments table.
 */
export const { Attachment } = configureAttachments({
  table: attachments,
  storage: () => getContainer().make('storage'),
  // Uploads are bytes a stranger chose, so they live on a disk rooted outside
  // public/ and are handed out only through the signed delivery route that
  // registerAttachmentRoutes(router) mounts. Rooting this disk inside public/
  // bypasses all of it; `guren check` fails that shape.
  disk: 'local',
  // 'public' disks build URLs with disk.url(); 'private' ones go through the
  // delivery route below. Undeclared disks count as public.
  disks: { local: 'private', public: 'public' },
  // Presence is the switch: private-disk URLs become signed delivery-route URLs.
  delivery: {},
})

// attachments:prune resolves attachableType through this map to check the owning
// record still exists, so every model declaring attachments belongs here.
Model.morphMap = { Post }
```

Three decisions are in this file, and they are the chapter's security content:

- **`disk: 'local'`**, rooted at `./storage/app`. Nothing serves that directory. A file under `public/` is reachable by anyone who guesses the path; a file here is reachable only through code that decides to hand it out.
- **`disks: { local: 'private' }`**. A private disk's URLs are not paths to the file; they are signed, expiring links to a route.
- **`delivery: {}`**. That route. It streams the object with headers that keep a browser from treating an upload as anything but a picture or a download: an allow-list of inline types, `nosniff`, a sandboxed CSP. Chapter 14 sees the same route become a redirect to object storage; the URL your pages use does not change.

The routes file now starts with the delivery route. Replace it so you can see where the call landed and keep it there:

```ts file=routes/web.ts
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostIdParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth.post('/posts/:id/publish', { bind: { id: Post }, name: 'posts.publish' }, [PostController, 'publish'])
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`config/attachments.ts` imports `Post`, which does not declare any attachment yet. That is the next step.

## 2. Specify the cover

The tests need an image. A one-pixel PNG is enough, and it is small enough to keep in the file:

```ts file=tests/PostAttachments.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
)

function image(name: string): File {
  return new File([PNG], name, { type: 'image/png' })
}

describe('post attachments', () => {
  let http: TestApp
  let ada: UserRecord
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('stores a cover with a post and serves it through a signed URL', async () => {
    const form = new FormData()
    form.append('title', 'With a cover')
    form.append('body', 'Look at this')
    form.append('tags', '')
    form.append('cover', image('cover.png'))

    await asAda.post('/posts', form).assertRedirect()

    const post = await Post.where('title', 'With a cover').first()
    const [loaded] = await Post.withAttachments([post!], ['cover'])
    expect(loaded!.cover?.contentType).toBe('image/png')
    expect(loaded!.cover?.url).toContain('/attachments/')
    expect(loaded!.cover?.url).toContain('signature=')

    const response = await http.get(`/posts/${post!.id}`).assertOk()
    await response.assertBodyContains('/attachments/')
  })

  it('replaces the cover, and lets only the author do it', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    const asGrace = await http.actingAs(grace).withCsrf()
    const post = await Post.forceCreate({ title: 'Recover', body: 'Body', authorId: ada.id })
    await Post.attach(post.id, 'cover', image('first.png'))

    const attempt = new FormData()
    attempt.append('cover', image('second.png'))
    await asGrace.post(`/posts/${post.id}/cover`, attempt).assertForbidden()

    const replacement = new FormData()
    replacement.append('cover', image('second.png'))
    await asAda.post(`/posts/${post.id}/cover`, replacement).assertRedirect(`/posts/${post.id}`)

    const [loaded] = await Post.withAttachments([post], ['cover'])
    expect(loaded!.cover?.name).toBe('second.png')
  })

  it('removes the files when the post is deleted', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Body', authorId: ada.id })
    const attachment = await Post.attach(post.id, 'cover', image('cover.png'))
    expect(existsSync(`storage/app/${attachment.path}`)).toBe(true)

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(existsSync(`storage/app/${attachment.path}`)).toBe(false)
  })
})
```

Three things worth reading in this file. The upload is a `FormData` with a `File` in it, and `TestApp` sends it as multipart when it sees one; a JSON body could not carry a file. The URL is asserted to be signed, not merely present, because an unsigned URL would mean the disk is public. And the last test checks the disk itself, through the object key the attachment row records: deleting a post must not leave its files behind, and no database assertion can tell you that.

```bash run expect-fail
bun test
```

Red, and before any of the three tests run: `Post.withAttachments` is not a function, because `Post` is not attachable yet.

## 3. The cover, by hand

The model declares its collections by wrapping the class. `image: 'require'` means a file that is not an image is refused with a validation message, at attach time, whatever its name or type header claim:

```ts file=app/Models/Post.ts
import { Attachable, defineModel, hasOneAttached, type BelongsToRecord, type BelongsToManyRecord, type HasManyRecord } from '@guren/core'
import { posts, postTags } from '../../db/schema.js'
import type { UserRecord } from './User.js'
import type { CommentRecord } from './Comment.js'
import type { TagRecord } from './Tag.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends Attachable(defineModel(posts, { fillable: ['title', 'body'] }), {
  cover: hasOneAttached({ image: 'require' }),
}) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
    tags: BelongsToManyRecord<TagRecord>
  } = { author: null, comments: [], tags: [] }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
Post.belongsToMany('tags', () => import('./Tag.js').then((m) => m.Tag), postTags, 'postId', 'tagId')
```

`Attachable` adds four statics to `Post`: `attach(id, collection, file)`, `detach(id, collection, attachmentId?)`, `withAttachments(records, names)` and `purgeAttachments(id)`. Nothing about the table or the disk appears here; the config decided those once.

The resource carries the cover as an `AttachmentData`: id, name, content type, size, dimensions, and the URL the page should use. Whether that URL is a signed route or a CDN path is the config's business, not the resource's:

```ts file=app/Http/Resources/PostResource.ts
import { Resource, type AttachmentData } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import type { TagRecord } from '../../Models/Tag.js'

export type PostWithRelations = PostRecord & {
  author?: UserRecord | null
  tags?: TagRecord[]
  cover?: AttachmentData | null
}

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
  publishedAt: string | null
  author: { id: number; name: string } | null
  tags: string[]
  cover: AttachmentData | null
}

export class PostResource extends Resource<PostWithRelations, PostResourceData> {
  toArray(): PostResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      publishedAt: this.resource.publishedAt,
      author: author ? { id: author.id, name: author.name } : null,
      tags: (this.resource.tags ?? []).map((tag) => tag.name),
      cover: this.resource.cover ?? null,
    }
  }
}
```

The controller: `store` attaches the cover if one was sent, `show` loads it, `destroy` purges the files before the row, and a new `cover` action replaces it. `this.file('cover')` reads the multipart field and returns `null` when it is absent or empty:

```ts file=app/Http/Controllers/PostController.ts
import { Controller, ValidationException, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function syncTags(postId: number, names: string[]): Promise<void> {
  await PostTag.delete({ postId })
  for (const name of names) {
    const tag = (await Tag.first({ name })) ?? (await Tag.create({ name }))
    await PostTag.forceCreate({ postId, tagId: tag.id })
  }
}

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.withPaginate('author', { page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, ['author', 'tags'])
    const [withCover] = await Post.withAttachments([post], ['cover'])
    const comments = await Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(withCover!).toJSON(),
      canManage: await this.can('update', [Post, post]),
      comments: await Promise.all(
        comments.map(async (comment) => ({
          ...new CommentResource(comment).toJSON(),
          canDelete: await this.can('delete', [Comment, comment]),
        })),
      ),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const author = await this.auth.userOrFail<UserRecord>()
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    await syncTags(post.id, tags)
    const cover = await this.file('cover')
    if (cover) {
      await Post.attach(post.id, 'cover', cover)
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const withTags = await Post.findWithOrFail(post.id, 'tags')

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(withTags).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    await syncTags(post.id, tags)
    return this.redirect(`/posts/${post.id}`)
  }

  async cover(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const cover = await this.file('cover')
    if (!cover) {
      throw new ValidationException({ cover: ['Choose an image.'] })
    }
    await Post.attach(post.id, 'cover', cover)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.purgeAttachments(post.id)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
    return this.redirect(`/posts/${post.id}`)
  }

  async unpublish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: null })
    return this.redirect(`/posts/${post.id}`)
  }
}
```

Two details carry the chapter. `Post.attach(post.id, 'cover', cover)` on a `hasOneAttached` collection **replaces**: the old file is removed, the new one stored, one row. And `purgeAttachments` comes before `delete`: the attachments table has no foreign key to `posts` (it is polymorphic, one table for every model), so nothing cascades, and a post deleted without the purge would leave orphaned files on the disk and orphaned rows in the table. That is what `attachments:prune` exists to find later, and what the third test refuses to allow.

The route for replacing a cover is a `POST`, not part of `update`. A file cannot travel in a `PUT` from an Inertia form without method spoofing, which Guren does not do; a separate route is simpler and reads better:

```ts file=routes/web.ts
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostIdParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth.post('/posts/:id/publish', { bind: { id: Post }, name: 'posts.publish' }, [PostController, 'publish'])
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

The form. Inertia's `useForm` switches to a multipart request on its own the moment the data holds a `File`; the only thing to add is the input and one more field in the form's type, which the route contract does not know about because the validator does not either:

```tsx file=resources/js/pages/posts/New.tsx
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

// Inertia switches the request to FormData as soon as the data holds a File.
type PostForm = RouteBody<ApiRoutes, 'posts.store'> & { cover: File | null }

const inputClass =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '', tags: '', cover: null })

  return (
    <>
      <Head title="New post" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="text-3xl font-bold text-g-heading">New post</h1>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              form.post(route('posts.store'))
            }}
          >
            <div>
              <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="Title" className={inputClass} />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="Body" rows={8} className={inputClass} />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <div>
              <input value={form.data.tags} onChange={(event) => form.setData('tags', event.target.value)} placeholder="Tags, comma-separated" className={inputClass} />
              {form.errors.tags && <p className="mt-1 text-sm text-g-danger">{form.errors.tags}</p>}
            </div>
            <div>
              <label className="block text-sm text-g-text-2">
                Cover image
                <input type="file" accept="image/*" onChange={(event) => form.setData('cover', event.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
              </label>
              {form.errors.cover && <p className="mt-1 text-sm text-g-danger">{form.errors.cover}</p>}
            </div>
            <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Publish
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

And the page shows the cover, with a small form to replace it for the author:

```tsx file=resources/js/pages/posts/Show.tsx
import { Head, Link, useForm, usePage } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import { route } from '@/.guren/routes.gen'

type CommentForm = RouteBody<ApiRoutes, 'comments.store'>

interface Props {
  post: PostResourceData
  canManage: boolean
  comments: (CommentResourceData & { canDelete: boolean })[]
}

export default function PostShow({ post, canManage, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const signedIn = Boolean(props.auth?.user)
  const form = useForm<CommentForm>({ body: '' })
  const coverForm = useForm<{ cover: File | null }>({ cover: null })

  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          {post.cover && (
            <img src={post.cover.url} alt="" width={post.cover.width ?? undefined} height={post.cover.height ?? undefined} className="w-full rounded-g-card border border-g-line object-cover" />
          )}
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.publishedAt ? `Published ${post.publishedAt}` : 'Draft'}
          </p>
          {post.tags.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span key={tag} className="rounded-g-ctl border border-g-line px-2 py-0.5 font-mono text-xs text-g-text-2">
                  #{tag}
                </span>
              ))}
            </p>
          )}
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          {canManage && (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                  Edit
                </Link>
                {post.publishedAt ? (
                  <Link href={route('posts.unpublish', { id: post.id })} method="post" as="button" className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted">
                    Unpublish
                  </Link>
                ) : (
                  <Link href={route('posts.publish', { id: post.id })} method="post" as="button" className="rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                    Publish
                  </Link>
                )}
                <Link
                  href={route('posts.destroy', { id: post.id })}
                  method="delete"
                  as="button"
                  onBefore={() => window.confirm('Delete this post?')}
                  className="rounded-g-ctl border border-g-danger-chip px-3 py-1 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint"
                >
                  Delete
                </Link>
              </div>
              <form
                className="flex items-center gap-3 text-sm"
                onSubmit={(event) => {
                  event.preventDefault()
                  coverForm.post(route('posts.cover', { id: post.id }), { onSuccess: () => coverForm.reset() })
                }}
              >
                <input type="file" accept="image/*" onChange={(event) => coverForm.setData('cover', event.target.files?.[0] ?? null)} className="text-sm" />
                <button type="submit" disabled={coverForm.processing || !coverForm.data.cover} className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted">
                  {post.cover ? 'Replace cover' : 'Add cover'}
                </button>
                {coverForm.errors.cover && <span className="text-g-danger">{coverForm.errors.cover}</span>}
              </form>
            </div>
          )}

          <section className="space-y-4 border-t border-g-line pt-6">
            <h2 className="text-xl font-bold text-g-heading">Comments</h2>
            {comments.length === 0 && <p className="text-g-text-2">No comments yet.</p>}
            {comments.map((comment) => (
              <article key={comment.id} className="rounded-g-card border border-g-line bg-g-panel p-4">
                <p className="whitespace-pre-wrap">{comment.body}</p>
                <p className="mt-2 flex items-center gap-3 font-mono text-xs text-g-text-2">
                  <span>{comment.author?.name ?? 'unknown'} · {comment.createdAt}</span>
                  {comment.canDelete && (
                    <Link href={route('comments.destroy', { id: comment.id })} method="delete" as="button" className="text-g-danger hover:underline">
                      Delete
                    </Link>
                  )}
                </p>
              </article>
            ))}
            {signedIn ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  form.post(route('comments.store', { id: post.id }), { onSuccess: () => form.reset() })
                }}
              >
                <textarea
                  value={form.data.body}
                  onChange={(event) => form.setData('body', event.target.value)}
                  placeholder="Add a comment"
                  rows={3}
                  className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
                />
                {form.errors.body && <p className="text-sm text-g-danger">{form.errors.body}</p>}
                <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Comment
                </button>
              </form>
            ) : (
              <p className="text-sm text-g-text-2">
                <Link href={route('login')} className="text-g-accent-text hover:underline">Sign in</Link> to comment.
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

Green. **Checkpoint:** write a post with a picture. Open the image in a new tab and look at its URL: `/attachments/<id>/<name>?expires=…&signature=…`. Wait six minutes and reload that tab: 404. The link expired; the page will mint a fresh one on its next render. That is what "private" means here.

## 4. What `guren check` knows about files

```bash run
bunx guren check
```

Among the lines, four are new and all pass: the model declares attachments and `configureAttachments()` is present; the config binds a table the schema exports; delivery is enabled and `registerAttachmentRoutes()` is mounted; and the disk `local` is rooted outside `public/`. Each of these is a mistake `check` was built to catch because it fails late and quietly at runtime. The last one is a hard failure with a long message: a disk rooted inside `public/` makes every upload fetchable by URL with no signature and no expiry, whatever the delivery route is configured to do, because nothing has to go through the route to reach the file. That is the difference between the file being on the server and the file being on the web.

This chapter's harness lever is that check. The `PostToolUse` hook runs it after every edit to a model or a config file, so an agent that "simplified" the disk to `public` would hear about it before its next step, in the same words.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: give posts a cover image on a private disk"
```

## 5. Specify the gallery

More than one image, and the author can remove any of them. Add to the attachments tests:

```ts file=tests/PostAttachments.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (char) => char.charCodeAt(0),
)

function image(name: string): File {
  return new File([PNG], name, { type: 'image/png' })
}

describe('post attachments', () => {
  let http: TestApp
  let ada: UserRecord
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('stores a cover with a post and serves it through a signed URL', async () => {
    const form = new FormData()
    form.append('title', 'With a cover')
    form.append('body', 'Look at this')
    form.append('tags', '')
    form.append('cover', image('cover.png'))

    await asAda.post('/posts', form).assertRedirect()

    const post = await Post.where('title', 'With a cover').first()
    const [loaded] = await Post.withAttachments([post!], ['cover'])
    expect(loaded!.cover?.contentType).toBe('image/png')
    expect(loaded!.cover?.url).toContain('/attachments/')
    expect(loaded!.cover?.url).toContain('signature=')

    const response = await http.get(`/posts/${post!.id}`).assertOk()
    await response.assertBodyContains('/attachments/')
  })

  it('replaces the cover, and lets only the author do it', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    const asGrace = await http.actingAs(grace).withCsrf()
    const post = await Post.forceCreate({ title: 'Recover', body: 'Body', authorId: ada.id })
    await Post.attach(post.id, 'cover', image('first.png'))

    const attempt = new FormData()
    attempt.append('cover', image('second.png'))
    await asGrace.post(`/posts/${post.id}/cover`, attempt).assertForbidden()

    const replacement = new FormData()
    replacement.append('cover', image('second.png'))
    await asAda.post(`/posts/${post.id}/cover`, replacement).assertRedirect(`/posts/${post.id}`)

    const [loaded] = await Post.withAttachments([post], ['cover'])
    expect(loaded!.cover?.name).toBe('second.png')
  })

  it('removes the files when the post is deleted', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Body', authorId: ada.id })
    const attachment = await Post.attach(post.id, 'cover', image('cover.png'))
    expect(existsSync(`storage/app/${attachment.path}`)).toBe(true)

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(existsSync(`storage/app/${attachment.path}`)).toBe(false)
  })

  it('stores gallery images with a post', async () => {
    const form = new FormData()
    form.append('title', 'Gallery')
    form.append('body', 'Pictures')
    form.append('tags', '')
    form.append('images', image('one.png'))
    form.append('images', image('two.png'))

    await asAda.post('/posts', form).assertRedirect()

    const post = await Post.where('title', 'Gallery').first()
    const [loaded] = await Post.withAttachments([post!], ['images'])
    expect(loaded!.images.map((img) => img.name).sort()).toEqual(['one.png', 'two.png'])
  })

  it('lets the author remove one gallery image, and nobody else', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    const asGrace = await http.actingAs(grace).withCsrf()
    const post = await Post.forceCreate({ title: 'Gallery', body: 'Pictures', authorId: ada.id })
    const first = await Post.attach(post.id, 'images', image('one.png'))
    await Post.attach(post.id, 'images', image('two.png'))

    await asGrace.delete(`/posts/${post.id}/images/${first.id}`).assertForbidden()

    await asAda.delete(`/posts/${post.id}/images/${first.id}`).assertRedirect(`/posts/${post.id}`)

    const [loaded] = await Post.withAttachments([post], ['images'])
    expect(loaded!.images.map((img) => img.name)).toEqual(['two.png'])
    expect(existsSync(`storage/app/${first.path}`)).toBe(false)
  })
})
```

```bash run expect-fail
bun test
```

Two red: `images` is not a collection `Post` declares.

## 6. Delegate it

Ask your agent:

> Add a gallery to posts: a `hasManyAttached` collection named `images` (images only) on `Post`. The new-post form accepts several files under `images`, `store` attaches each one, the post page shows them, and `DELETE /posts/:id/images/:attachment`, named `posts.images.destroy`, removes one image for the post's author. Load the gallery with `withAttachments` and expose it through `PostResource`. `tests/PostAttachments.test.ts` describes it; make it pass.

This is the same shape as the cover, one level up: `this.files('images')` instead of `this.file('cover')`, an array instead of a nullable, and `detach` with an attachment id instead of a replacing `attach`. The interesting part of the rubric is the delete route: it must find the attachment by the id in the URL *and* only within this post's collection, so a valid attachment id from someone else's post is refused. `detach(post.id, 'images', attachmentId)` does exactly that; a hand-rolled delete by attachment id alone would not.

**No agent handy?** The model gains a collection:

```ts file=app/Models/Post.ts fallback
import { Attachable, defineModel, hasManyAttached, hasOneAttached, type BelongsToRecord, type BelongsToManyRecord, type HasManyRecord } from '@guren/core'
import { posts, postTags } from '../../db/schema.js'
import type { UserRecord } from './User.js'
import type { CommentRecord } from './Comment.js'
import type { TagRecord } from './Tag.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends Attachable(defineModel(posts, { fillable: ['title', 'body'] }), {
  cover: hasOneAttached({ image: 'require' }),
  images: hasManyAttached({ image: 'require' }),
}) {
  static override relationTypes: {
    author: BelongsToRecord<UserRecord>
    comments: HasManyRecord<CommentRecord>
    tags: BelongsToManyRecord<TagRecord>
  } = { author: null, comments: [], tags: [] }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
Post.belongsToMany('tags', () => import('./Tag.js').then((m) => m.Tag), postTags, 'postId', 'tagId')
```

```ts file=app/Http/Validators/PostValidator.ts fallback
import { z } from 'zod'

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const PostImageParamSchema = z.object({
  id: z.coerce.number().int().positive(),
  attachment: z.string().min(1),
})

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(120, 'Title must be 120 characters or fewer'),
  body: z.string().trim().min(1, 'Body is required'),
  tags: z
    .string()
    .default('')
    .transform((value) => [...new Set(value.split(',').map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0))]),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})
```

```ts file=app/Http/Resources/PostResource.ts fallback
import { Resource, type AttachmentData } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import type { TagRecord } from '../../Models/Tag.js'

export type PostWithRelations = PostRecord & {
  author?: UserRecord | null
  tags?: TagRecord[]
  cover?: AttachmentData | null
  images?: AttachmentData[]
}

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
  publishedAt: string | null
  author: { id: number; name: string } | null
  tags: string[]
  cover: AttachmentData | null
  images: AttachmentData[]
}

export class PostResource extends Resource<PostWithRelations, PostResourceData> {
  toArray(): PostResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      publishedAt: this.resource.publishedAt,
      author: author ? { id: author.id, name: author.name } : null,
      tags: (this.resource.tags ?? []).map((tag) => tag.name),
      cover: this.resource.cover ?? null,
      images: this.resource.images ?? [],
    }
  }
}
```

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, ValidationException, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { CommentResource } from '../Resources/CommentResource.js'
import { ListPostsQuerySchema, PostIdParamSchema, PostImageParamSchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function syncTags(postId: number, names: string[]): Promise<void> {
  await PostTag.delete({ postId })
  for (const name of names) {
    const tag = (await Tag.first({ name })) ?? (await Tag.create({ name }))
    await PostTag.forceCreate({ postId, tagId: tag.id })
  }
}

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.withPaginate('author', { page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource(post).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, ['author', 'tags'])
    const [withFiles] = await Post.withAttachments([post], ['cover', 'images'])
    const comments = await Comment.where('postId', post.id).with('author').orderBy('id', 'asc').get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(withFiles!).toJSON(),
      canManage: await this.can('update', [Post, post]),
      comments: await Promise.all(
        comments.map(async (comment) => ({
          ...new CommentResource(comment).toJSON(),
          canDelete: await this.can('delete', [Comment, comment]),
        })),
      ),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const author = await this.auth.userOrFail<UserRecord>()
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    await syncTags(post.id, tags)
    const cover = await this.file('cover')
    if (cover) {
      await Post.attach(post.id, 'cover', cover)
    }
    for (const file of await this.files('images')) {
      await Post.attach(post.id, 'images', file)
    }
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const withTags = await Post.findWithOrFail(post.id, 'tags')

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(withTags).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const { tags, ...data } = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    await syncTags(post.id, tags)
    return this.redirect(`/posts/${post.id}`)
  }

  async cover(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const cover = await this.file('cover')
    if (!cover) {
      throw new ValidationException({ cover: ['Choose an image.'] })
    }
    await Post.attach(post.id, 'cover', cover)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroyImage(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const { attachment } = this.validateParams(PostImageParamSchema)
    await Post.detach(post.id, 'images', attachment)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.purgeAttachments(post.id)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
    return this.redirect(`/posts/${post.id}`)
  }

  async unpublish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: null })
    return this.redirect(`/posts/${post.id}`)
  }
}
```

```ts file=routes/web.ts fallback
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostIdParamSchema, PostImageParamSchema, PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

  // aliasMiddleware() returns a Router carrying the alias name in its type;
  // capture it, or `.middleware('auth')` below will not compile.
  const router = baseRouter
    .aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
    .aliasMiddleware('guest', requireGuest({ redirectTo: '/' }))

  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.middleware('guest').group((guest) => {
    guest.get('/register', [RegisterController, 'show']).name('register')
    guest.post('/register', { name: 'register.store', body: RegisterSchema }, [RegisterController, 'store'])
    guest.get('/login', [LoginController, 'show']).name('login')
    guest.post('/login', { name: 'login.store', body: LoginSchema }, [LoginController, 'store'])
  })

  router.middleware('auth').group((auth) => {
    auth.post('/logout', [LoginController, 'destroy']).name('logout')
    auth.get('/profile', [ProfileController, 'show']).name('profile')
    auth.get('/posts/create', [PostController, 'create']).name('posts.create')
    auth.get('/posts/:id/edit', { bind: { id: Post }, name: 'posts.edit' }, [PostController, 'edit'])
    auth.post('/posts', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
    auth.put('/posts/:id', { bind: { id: Post }, name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
    auth.delete('/posts/:id', { bind: { id: Post }, name: 'posts.destroy' }, [PostController, 'destroy'])
    auth.post('/posts/:id/publish', { bind: { id: Post }, name: 'posts.publish' }, [PostController, 'publish'])
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth.post('/posts/:id/comments', { bind: { id: Post }, name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
    auth.delete('/comments/:id', { bind: { id: Comment }, name: 'comments.destroy' }, [CommentController, 'destroy'])
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { name: 'posts.show', params: PostIdParamSchema }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

The form takes several files under one name:

```tsx file=resources/js/pages/posts/New.tsx fallback
import { Head, useForm } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import { route } from '@/.guren/routes.gen'

// Inertia switches the request to FormData as soon as the data holds a File.
type PostForm = RouteBody<ApiRoutes, 'posts.store'> & { cover: File | null; images: File[] }

const inputClass =
  'w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent'

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '', tags: '', cover: null, images: [] })

  return (
    <>
      <Head title="New post" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="text-3xl font-bold text-g-heading">New post</h1>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault()
              form.post(route('posts.store'))
            }}
          >
            <div>
              <input value={form.data.title} onChange={(event) => form.setData('title', event.target.value)} placeholder="Title" className={inputClass} />
              {form.errors.title && <p className="mt-1 text-sm text-g-danger">{form.errors.title}</p>}
            </div>
            <div>
              <textarea value={form.data.body} onChange={(event) => form.setData('body', event.target.value)} placeholder="Body" rows={8} className={inputClass} />
              {form.errors.body && <p className="mt-1 text-sm text-g-danger">{form.errors.body}</p>}
            </div>
            <div>
              <input value={form.data.tags} onChange={(event) => form.setData('tags', event.target.value)} placeholder="Tags, comma-separated" className={inputClass} />
              {form.errors.tags && <p className="mt-1 text-sm text-g-danger">{form.errors.tags}</p>}
            </div>
            <div>
              <label className="block text-sm text-g-text-2">
                Cover image
                <input type="file" accept="image/*" onChange={(event) => form.setData('cover', event.target.files?.[0] ?? null)} className="mt-1 block w-full text-sm" />
              </label>
              {form.errors.cover && <p className="mt-1 text-sm text-g-danger">{form.errors.cover}</p>}
            </div>
            <div>
              <label className="block text-sm text-g-text-2">
                Gallery
                <input type="file" accept="image/*" multiple onChange={(event) => form.setData('images', Array.from(event.target.files ?? []))} className="mt-1 block w-full text-sm" />
              </label>
              {form.errors.images && <p className="mt-1 text-sm text-g-danger">{form.errors.images}</p>}
            </div>
            <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Publish
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

And the page shows the gallery, with a remove button per image for the author:

```tsx file=resources/js/pages/posts/Show.tsx fallback
import { Head, Link, useForm, usePage } from '@inertiajs/react'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import type { RouteBody } from '@guren/inertia-client/typed-forms'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import { route } from '@/.guren/routes.gen'

type CommentForm = RouteBody<ApiRoutes, 'comments.store'>

interface Props {
  post: PostResourceData
  canManage: boolean
  comments: (CommentResourceData & { canDelete: boolean })[]
}

export default function PostShow({ post, canManage, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const signedIn = Boolean(props.auth?.user)
  const form = useForm<CommentForm>({ body: '' })
  const coverForm = useForm<{ cover: File | null }>({ cover: null })

  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          {post.cover && (
            <img src={post.cover.url} alt="" width={post.cover.width ?? undefined} height={post.cover.height ?? undefined} className="w-full rounded-g-card border border-g-line object-cover" />
          )}
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.publishedAt ? `Published ${post.publishedAt}` : 'Draft'}
          </p>
          {post.tags.length > 0 && (
            <p className="flex flex-wrap gap-2">
              {post.tags.map((tag) => (
                <span key={tag} className="rounded-g-ctl border border-g-line px-2 py-0.5 font-mono text-xs text-g-text-2">
                  #{tag}
                </span>
              ))}
            </p>
          )}
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          {post.images.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {post.images.map((imageItem) => (
                <figure key={imageItem.id} className="space-y-1">
                  <img src={imageItem.url} alt="" className="aspect-square w-full rounded-g-card border border-g-line object-cover" />
                  {canManage && (
                    <Link href={route('posts.images.destroy', { id: post.id, attachment: imageItem.id })} method="delete" as="button" className="font-mono text-xs text-g-danger hover:underline">
                      Remove
                    </Link>
                  )}
                </figure>
              ))}
            </div>
          )}
          {canManage && (
            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                  Edit
                </Link>
                {post.publishedAt ? (
                  <Link href={route('posts.unpublish', { id: post.id })} method="post" as="button" className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted">
                    Unpublish
                  </Link>
                ) : (
                  <Link href={route('posts.publish', { id: post.id })} method="post" as="button" className="rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                    Publish
                  </Link>
                )}
                <Link
                  href={route('posts.destroy', { id: post.id })}
                  method="delete"
                  as="button"
                  onBefore={() => window.confirm('Delete this post?')}
                  className="rounded-g-ctl border border-g-danger-chip px-3 py-1 text-sm font-bold text-g-danger transition hover:bg-g-danger-tint"
                >
                  Delete
                </Link>
              </div>
              <form
                className="flex items-center gap-3 text-sm"
                onSubmit={(event) => {
                  event.preventDefault()
                  coverForm.post(route('posts.cover', { id: post.id }), { onSuccess: () => coverForm.reset() })
                }}
              >
                <input type="file" accept="image/*" onChange={(event) => coverForm.setData('cover', event.target.files?.[0] ?? null)} className="text-sm" />
                <button type="submit" disabled={coverForm.processing || !coverForm.data.cover} className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-g-text transition hover:border-g-muted">
                  {post.cover ? 'Replace cover' : 'Add cover'}
                </button>
                {coverForm.errors.cover && <span className="text-g-danger">{coverForm.errors.cover}</span>}
              </form>
            </div>
          )}

          <section className="space-y-4 border-t border-g-line pt-6">
            <h2 className="text-xl font-bold text-g-heading">Comments</h2>
            {comments.length === 0 && <p className="text-g-text-2">No comments yet.</p>}
            {comments.map((comment) => (
              <article key={comment.id} className="rounded-g-card border border-g-line bg-g-panel p-4">
                <p className="whitespace-pre-wrap">{comment.body}</p>
                <p className="mt-2 flex items-center gap-3 font-mono text-xs text-g-text-2">
                  <span>{comment.author?.name ?? 'unknown'} · {comment.createdAt}</span>
                  {comment.canDelete && (
                    <Link href={route('comments.destroy', { id: comment.id })} method="delete" as="button" className="text-g-danger hover:underline">
                      Delete
                    </Link>
                  )}
                </p>
              </article>
            ))}
            {signedIn ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  form.post(route('comments.store', { id: post.id }), { onSuccess: () => form.reset() })
                }}
              >
                <textarea
                  value={form.data.body}
                  onChange={(event) => form.setData('body', event.target.value)}
                  placeholder="Add a comment"
                  rows={3}
                  className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
                />
                {form.errors.body && <p className="text-sm text-g-danger">{form.errors.body}</p>}
                <button type="submit" disabled={form.processing} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Comment
                </button>
              </form>
            ) : (
              <p className="text-sm text-g-text-2">
                <Link href={route('login')} className="text-g-accent-text hover:underline">Sign in</Link> to comment.
              </p>
            )}
          </section>
        </div>
      </main>
    </>
  )
}
```

```bash run
bun run codegen
```

```bash run
bun test
```

The rubric:

- `images` is declared with `hasManyAttached({ image: 'require' })`; the model's other declarations are unchanged.
- `store` attaches every file from `this.files('images')`; `destroyImage` removes one with `detach(post.id, 'images', attachmentId)`, scoped to the post, after the same `authorize('update', ...)` as every other change to a post.
- `show` loads `cover` and `images` in one `withAttachments` call, and the resource exposes the gallery as `AttachmentData[]`.
- The delete route carries `bind` for the post and a `params` schema for the attachment id, and lives in the `auth` group.
- All five attachment tests are green, and `guren check` still passes the four attachment rules.

**Checkpoint:** a post with three pictures, and a fourth you removed.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add a gallery to posts"
```

## Where you are

- An attachments layer on a private disk behind a signed route, with a table, a config and a prune command.
- A cover image per post: uploaded from a form, replaced through its own route, purged with the post.
- A gallery, delegated, with per-image removal scoped to the post.
- Four attachment rules in `guren check`, and the reason the disk rule is a failure rather than a warning.

## Common trip-ups

- **`guren check` fails on "Attachable model wiring".** A model mixes in `Attachable` but no `configureAttachments()` call exists anywhere under `config/`, `src/` or `app/`. The mixin resolves the layer at first use, so without the check this would fail on the first upload; `bunx guren add attachments` installs the missing half.
- **The image URL 404s in the browser.** The signed URL expired (five minutes by default); reload the page for a fresh one. If a freshly rendered page also 404s, `registerAttachmentRoutes` is not mounted.
- **Uploading from the edit form does nothing.** `form.put()` with a file needs method spoofing, which the framework does not do. Use a `POST` route for the file, as `posts.cover` does.
- **"The file must be an image."** `image: 'require'` checks the bytes, not the extension. A renamed text file is refused; a real PNG with a `.jpg` name is accepted.
- **Deleting a post leaves files in `storage/app/attachments`.** `purgeAttachments` was not called before `delete`. The attachments table has no foreign key to purge for you; `bunx guren attachments:prune` finds the leftovers.

## Next

Chapter 11, *Events and Mail* (coming), tells the author when someone comments: an event, a listener, a queued mail, and a notification channel the agent adds.
