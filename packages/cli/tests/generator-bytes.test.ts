import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { makeController } from '../src/make-controller'
import { makeEvent } from '../src/make-event'
import { buildRouteRegistrationHint, makeFeature } from '../src/make-feature'
import { makeJob } from '../src/make-job'
import { makeListener } from '../src/make-listener'
import { makeMail } from '../src/make-mail'
import { makeNotification } from '../src/make-notification'
import { makePolicy } from '../src/make-policy'
import { makeResource } from '../src/make-resource'
import { makeRoute } from '../src/make-route'
import { makeValidator } from '../src/make-validator'
import { parseFieldsString } from '../src/fields'

// These generators share their shells with plan:scaffold; this pins what the generators write.
describe('validator, resource and policy generators', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-generator-bytes-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const read = async (path: string): Promise<string> => readFile(join(dir, path), 'utf8')

  it('should write make:validator with every field type, byte for byte', async () => {
    await makeValidator('Post', { cwd: dir, fields: parseFieldsString('title:string,body:text?,views:number,draft:boolean,publishedAt:date?,meta:json') })
    expect(await read('app/Http/Validators/PostValidator.ts')).toMatchInlineSnapshot(`
      "import { z } from 'zod'

      export const PostIdParamSchema = z.object({
        id: z.coerce.number().int().positive(),
      })

      export const ListPostsQuerySchema = z.object({
        page: z.coerce.number().int().min(1).default(1),
      })

      export const PostPayloadSchema = z.object({
        title: z.string().trim().min(1),
        body: z.string().trim().min(1).nullable().optional(),
        views: z.coerce.number(),
        draft: z.boolean(),
        publishedAt: z.coerce.date().nullable().optional(),
        meta: z.record(z.string(), z.any()),
      })

      export type PostPayload = z.infer<typeof PostPayloadSchema>
      "
    `)
  })

  it('should write make:validator with no fields, byte for byte', async () => {
    await makeValidator('Status', { cwd: dir })
    expect(await read('app/Http/Validators/StatusValidator.ts')).toMatchInlineSnapshot(`
      "import { z } from 'zod'

      export const StatusIdParamSchema = z.object({
        id: z.coerce.number().int().positive(),
      })

      export const ListStatusesQuerySchema = z.object({
        page: z.coerce.number().int().min(1).default(1),
      })

      export const StatusPayloadSchema = z.object({
        // Add one entry per column, e.g. title: z.string().trim().min(1),
      })

      export type StatusPayload = z.infer<typeof StatusPayloadSchema>
      "
    `)
  })

  it('should write make:resource, byte for byte', async () => {
    await makeResource('Comment', { cwd: dir })
    expect(await read('app/Http/Resources/CommentResource.ts')).toMatchInlineSnapshot(`
      "import { Resource } from '@guren/core'
      import type { CommentRecord } from '../../Models/Comment.js'

      export interface CommentResourceData extends Record<string, unknown> {
        id: CommentRecord['id']
      }

      export class CommentResource extends Resource<CommentRecord, CommentResourceData> {
        toArray(): CommentResourceData {
          return {
            id: this.resource.id,
            // Map the remaining CommentRecord columns here. Only call
            // .toISOString() on Date columns — text timestamps are already strings.
          }
        }
      }
      "
    `)
  })

  it('should write make:policy, byte for byte', async () => {
    await makePolicy('Post', { cwd: dir })
    expect(await read('app/Policies/PostPolicy.ts')).toMatchInlineSnapshot(`
      "import { Policy, type AuthUser } from '@guren/core'

      interface PostLike {
        userId?: string | number
      }

      export class PostPolicy extends Policy {
        viewAny(_user: AuthUser | null): boolean {
          return true
        }

        view(_user: AuthUser | null, _post: PostLike): boolean {
          return true
        }

        create(user: AuthUser | null): boolean {
          return user !== null
        }

        update(user: AuthUser | null, post: PostLike): boolean {
          return user !== null && user.id === post.userId
        }

        delete(user: AuthUser | null, post: PostLike): boolean {
          return user !== null && user.id === post.userId
        }
      }
      "
    `)
  })

  // make:feature's validator and policy come from make:validator's and make:policy's builders, pinned above.
  it('should write make:feature’s resource, byte for byte', async () => {
    await makeFeature('Post', { cwd: dir, fields: 'title:string,body:text?,views:number,draft:boolean,publishedAt:date?,meta:json?', withPolicy: true })
    expect(await read('app/Http/Resources/PostResource.ts')).toMatchInlineSnapshot(`
      "import { Resource } from '@guren/core'
      import type { PostRecord } from '../../Models/Post.js'

      export interface PostResourceData extends Record<string, unknown> {
        id: PostRecord['id']
        title: string
        body: string | null
        views: number
        draft: boolean
        publishedAt: string | null
        meta: Record<string, unknown> | null
      }

      export class PostResource extends Resource<PostRecord, PostResourceData> {
        toArray(): PostResourceData {
          return {
            id: this.resource.id,
            title: this.resource.title,
            body: this.resource.body ?? null,
            views: this.resource.views,
            draft: this.resource.draft,
            publishedAt: this.resource.publishedAt == null ? null : new Date(this.resource.publishedAt).toISOString(),
            meta: (this.resource.meta as Record<string, unknown> | null) ?? null,
          }
        }
      }
      "
    `)
  })
})

// These generators share their shells with plan:scaffold's controller, routes and side-effect emitters.
describe('controller, route and side-effect generators', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'guren-generator-bytes-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const read = async (path: string): Promise<string> => readFile(join(dir, path), 'utf8')

  it('should write make:controller for an Inertia app and an API-only one, byte for byte', async () => {
    await makeController('Post', { cwd: dir })
    expect(await read('app/Http/Controllers/PostController.ts')).toMatchInlineSnapshot(`
      "import { Controller } from '@guren/core'
      import { pages } from '@/.guren/pages.gen'

      export default class PostController extends Controller {
        async index(): Promise<Response> {
          return this.inertia(pages.post.Index, {}, {
            title: 'Post',
          })
        }
      }
      "
    `)
    await Bun.write(join(dir, 'api/package.json'), JSON.stringify({ name: 'api', dependencies: { '@guren/core': '*' } }))
    await makeController('Post', { cwd: join(dir, 'api') })
    expect(await read('api/app/Http/Controllers/PostController.ts')).toMatchInlineSnapshot(`
      "import { Controller } from '@guren/core'

      export default class PostController extends Controller {
        async index(): Promise<Response> {
          return this.json({
            data: [],
          })
        }
      }
      "
    `)
  })

  it('should write make:route, byte for byte', async () => {
    await makeRoute('posts', { cwd: dir })
    expect(await read('routes/posts.ts')).toMatchInlineSnapshot(`
      "import { Router } from '@guren/core'
      import PostController from '../app/Http/Controllers/PostController.js'

      export function registerRoutes(router: Router): void {
        router.group('/posts', (group) => {
          group.get('/', [PostController, 'index'])
        })
      }
      "
    `)
  })

  it('should write make:feature’s controller with a policy, and without auth, byte for byte', async () => {
    await makeFeature('Post', { cwd: dir, fields: 'title:string', withPolicy: true })
    expect(await read('app/Http/Controllers/PostController.ts')).toMatchInlineSnapshot(`
      "import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
      import { pages } from '@/.guren/pages.gen'
      import { Post } from '../../Models/Post.js'
      import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
      import { PostIdParamSchema, ListPostsQuerySchema } from '../Validators/PostValidator.js'

      type PostsIndexProps = PaginatedPageProps<PostResourceData>

      export default class PostController extends Controller {
        async index(): Promise<Response> {
          const { page } = this.validateQuery(ListPostsQuerySchema)
          const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
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
          const post = await Post.findOrFail(id)

          return this.inertia(pages.posts.Show, {
            post: new PostResource(post).toJSON(),
          })
        }

        async create(): Promise<Response> {
          return this.inertia(pages.posts.New, {})
        }

        async store(): Promise<Response> {
          await this.auth.userOrFail()
          await this.authorize('create', Post)
          const { body: data } = this.validated('posts.store')
          const post = await Post.create(data)
          return this.redirect('/posts/' + post?.id)
        }

        async edit(): Promise<Response> {
          const { id } = this.validateParams(PostIdParamSchema)
          const post = await Post.findOrFail(id)
          return this.inertia(pages.posts.Edit, {
            post: new PostResource(post).toJSON(),
            errors: {},
          })
        }

        async update(): Promise<Response> {
          await this.auth.userOrFail()
          const { id } = this.validateParams(PostIdParamSchema)
          await this.authorize('update', [Post, await Post.findOrFail(id)])
          const { body: data } = this.validated('posts.update')
          await Post.update({ id }, data)
          return this.redirect('/posts/' + id)
        }

        async destroy(): Promise<Response> {
          await this.auth.userOrFail()
          const { id } = this.validateParams(PostIdParamSchema)
          const post = await Post.findOrFail(id)
          await this.authorize('delete', [Post, post])
          await Post.delete({ id: post.id })
          return this.redirect('/posts')
        }
      }
      "
    `)
    await makeFeature('Note', { cwd: dir, fields: 'body:text', publicAccess: true })
    expect(await read('app/Http/Controllers/NoteController.ts')).toMatchInlineSnapshot(`
      "import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
      import { pages } from '@/.guren/pages.gen'
      import { Note } from '../../Models/Note.js'
      import { NoteResource, type NoteResourceData } from '../Resources/NoteResource.js'
      import { NoteIdParamSchema, ListNotesQuerySchema } from '../Validators/NoteValidator.js'

      type NotesIndexProps = PaginatedPageProps<NoteResourceData>

      export default class NoteController extends Controller {
        async index(): Promise<Response> {
          const { page } = this.validateQuery(ListNotesQuerySchema)
          const result = await Note.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
          const paginator = paginate(result, { path: this.request.path ?? '/notes' })

          return this.inertia(pages.notes.Index, {
            data: result.data.map((note) => new NoteResource(note).toJSON()),
            pagination: {
              meta: paginator.meta(),
              links: paginator.links(),
            },
          } satisfies NotesIndexProps)
        }

        async show(): Promise<Response> {
          const { id } = this.validateParams(NoteIdParamSchema)
          const note = await Note.findOrFail(id)

          return this.inertia(pages.notes.Show, {
            note: new NoteResource(note).toJSON(),
          })
        }

        async create(): Promise<Response> {
          return this.inertia(pages.notes.New, {})
        }

        async store(): Promise<Response> {
          const { body: data } = this.validated('notes.store')
          const note = await Note.create(data)
          return this.redirect('/notes/' + note?.id)
        }

        async edit(): Promise<Response> {
          const { id } = this.validateParams(NoteIdParamSchema)
          const note = await Note.findOrFail(id)
          return this.inertia(pages.notes.Edit, {
            note: new NoteResource(note).toJSON(),
            errors: {},
          })
        }

        async update(): Promise<Response> {
          const { id } = this.validateParams(NoteIdParamSchema)
          const { body: data } = this.validated('notes.update')
          await Note.update({ id }, data)
          return this.redirect('/notes/' + id)
        }

        async destroy(): Promise<Response> {
          const { id } = this.validateParams(NoteIdParamSchema)
          const note = await Note.findOrFail(id)
          await Note.delete({ id: note.id })
          return this.redirect('/notes')
        }
      }
      "
    `)
  })

  it('should print make:feature’s route block with and without auth, line for line', () => {
    expect(buildRouteRegistrationHint({ singular: 'Post', routeName: 'posts', routeVar: 'posts', withAuth: true }).join('\n')).toMatchInlineSnapshot(`
      "const authRouter = router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
      authRouter.group('/posts', (posts) => {
        posts.get('/', [PostController, 'index']).name('posts.index')
        posts.get('/create', [PostController, 'create']).name('posts.create')
        posts.get('/:id', [PostController, 'show']).name('posts.show')
        posts.get('/:id/edit', [PostController, 'edit']).name('posts.edit')
        posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store']).middleware('auth')
        posts.put('/:id', { name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update']).middleware('auth')
        posts.delete('/:id', { name: 'posts.destroy' }, [PostController, 'destroy']).middleware('auth')
      })"
    `)
    expect(buildRouteRegistrationHint({ singular: 'Post', routeName: 'posts', routeVar: 'posts', withAuth: false, receiver: 'app' }).join('\n')).toMatchInlineSnapshot(`
      "app.group('/posts', (posts) => {
        posts.get('/', [PostController, 'index']).name('posts.index')
        posts.get('/create', [PostController, 'create']).name('posts.create')
        posts.get('/:id', [PostController, 'show']).name('posts.show')
        posts.get('/:id/edit', [PostController, 'edit']).name('posts.edit')
        posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
        posts.put('/:id', { name: 'posts.update', body: PostPayloadSchema }, [PostController, 'update'])
        posts.delete('/:id', { name: 'posts.destroy' }, [PostController, 'destroy'])
      })"
    `)
  })

  it('should write make:job, make:event, make:listener, make:mail and make:notification, byte for byte', async () => {
    await makeJob('SendWelcome', { cwd: dir })
    expect(await read('app/Jobs/SendWelcomeJob.ts')).toMatchInlineSnapshot(`
      "import { Job } from '@guren/core'

      export interface SendWelcomeJobPayload {
        [key: string]: unknown
      }

      export class SendWelcomeJob extends Job<SendWelcomeJobPayload> {
        static override jobName = 'SendWelcomeJob'
        static override queue = 'default'
        static override maxAttempts = 3

        async handle(payload: SendWelcomeJobPayload): Promise<void> {
          void payload
        }

        async failed(payload: SendWelcomeJobPayload, error: Error): Promise<void> {
          void payload
          console.error('SendWelcomeJob failed:', error.message)
        }
      }
      "
    `)
    await makeEvent('OrderPlaced', { cwd: dir })
    expect(await read('app/Events/OrderPlaced.ts')).toMatchInlineSnapshot(`
      "import { Event } from '@guren/core'

      export class OrderPlaced extends Event {
        static override eventName = 'OrderPlaced'

        constructor(
          public readonly data: Record<string, unknown> = {},
        ) {
          super()
        }
      }
      "
    `)
    await makeListener('SendReceipt', { cwd: dir, event: 'OrderPlaced' })
    expect(await read('app/Listeners/SendReceiptListener.ts')).toMatchInlineSnapshot(`
      "import { Listener } from '@guren/core'
      import { OrderPlaced } from '../Events/OrderPlaced'

      export class SendReceiptListener extends Listener<OrderPlaced> {
        static override event = OrderPlaced

        async handle(event: OrderPlaced): Promise<void> {
          void event
        }

        static override shouldQueue = false

        // Reporting hook, not a catch. Inline, the error still propagates once
        // this has run; queued, it runs when the job has run out of retries.
        async failed(event: OrderPlaced, error: Error): Promise<void> {
          console.error('SendReceiptListener failed:', error.message)
        }
      }
      "
    `)
    await makeListener('AuditTrail', { cwd: dir })
    expect(await read('app/Listeners/AuditTrailListener.ts')).toMatchInlineSnapshot(`
      "import { Listener, Event } from '@guren/core'
      // import { YourEvent } from '../Events/YourEvent'

      export class AuditTrailListener extends Listener {
        async handle(event: Event): Promise<void> {
          void event
        }

        static override shouldQueue = false

        // Reporting hook, not a catch. Inline, the error still propagates once
        // this has run; queued, it runs when the job has run out of retries.
        async failed(event: Event, error: Error): Promise<void> {
          console.error('AuditTrailListener failed:', error.message)
        }
      }
      "
    `)
    await makeMail('Welcome', { cwd: dir })
    expect(await read('app/Mail/WelcomeMail.ts')).toMatchInlineSnapshot(`
      "import { Mail, type MailManager } from '@guren/core'

      export class WelcomeMail extends Mail {
        constructor(
          manager: MailManager,
          public readonly data: Record<string, unknown> = {},
        ) {
          super(manager)
        }

        build(): this {
          return this
            .subject('Welcome')
            .text('Replace this body with your real email content.')
        }
      }
      "
    `)
    await makeNotification('InvoicePaid', { cwd: dir })
    expect(await read('app/Notifications/InvoicePaidNotification.ts')).toMatchInlineSnapshot(`
      "import { Notification, type NotificationMailMessage } from '@guren/core'

      export class InvoicePaidNotification extends Notification {
        constructor(
          public readonly data: Record<string, unknown> = {},
        ) {
          super()
        }

        // A getter is inherited: without the check a subclass would take this pin and its registry key.
        override get type(): string {
          return this.constructor === InvoicePaidNotification ? 'InvoicePaidNotification' : this.constructor.name
        }

        via(): string[] {
          return ['mail', 'database']
        }

        override toMail(): NotificationMailMessage {
          return {
            subject: 'InvoicePaid',
            text: 'Your notification content here.',
          }
        }

        override toDatabase(): Record<string, unknown> {
          return {
            ...this.data,
          }
        }

        override toArray(): Record<string, unknown> {
          return {
            ...this.data,
          }
        }
      }
      "
    `)
  })
})
