# Chapter 11: Events and Mail

Everything so far finished inside the request: validate, write a row, redirect. This chapter is about the work that should not. When Bob comments on Ada's post, Ada gets an email, and Bob's browser must not wait for a mail server to answer before it sees the page.

Four names for that one sentence, and the chapter is mostly about why there are four:

| Piece | Answers |
|---|---|
| **Event** | Something happened. The controller announces it and stops caring. |
| **Listener** | Somebody cares. It decides what to do about the announcement. |
| **Job** | Work that outlives the request. A payload on a queue, run by whoever picks it up. |
| **Mail** | The message itself: a subject, a body, a recipient. |

**What you'll learn:**

- Where each of the four is registered, and the one registration nothing checks for you
- Why a job payload is ids rather than records
- What `QUEUE_CONNECTION=sync` really does, and what changes when it stops being sync
- Three fakes for three different seams, and why one of them cannot be a container binding

Start the dev server if it is not running:

```bash run background
bun run dev
```

## 1. Three layers, three commands

```bash run
bunx guren add events
```

```bash run
bunx guren add queue
```

```bash run
bunx guren add mail
```

Each one wrote a sample of its kind plus a provider, and registered both the framework's service provider and yours in `src/app.ts`. Open it: the providers array has been rewritten onto a single line with six new entries at the end, a framework provider and an app provider for each command. That collapsing is the patcher's doing, not yours, and it is the shape every `add` command leaves behind.

The three providers are worth reading, because two of them are files you are about to edit:

- `app/Providers/EventProvider.ts` connects an event class to a listener object. That connection is a line of code, not a convention: nothing scans `app/Listeners/` looking for work.
- `app/Providers/QueueProvider.ts` builds the queue manager and calls `registerJob()` for each job class. Note the driver line: `QUEUE_CONNECTION=sync` runs a dispatched job **inline, in the dispatching process**; `memory` puts it in a queue a worker drains. Your `.env` already says `sync`.
- `app/Providers/MailProvider.ts` builds the mail manager. `MAIL_MAILER=log`, also already in your `.env`, prints outgoing mail to the server output instead of sending it. Nothing to sign up for, and nothing to accidentally deliver.

The samples (`OrderPlaced`, `SendOrderReceiptListener`, `ProcessWelcomeSequenceJob`, `WelcomeEmailMail`) exist so you can see the shape of each file. You will replace all four in section 3.

## 2. Specify the mail

Three tests, and each one is fake-shaped differently on purpose. Read the setup before the assertions:

```ts file=tests/CommentMail.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { MailManager, getQueueDriver, setQueueDriver } from '@guren/core'
import { TestApp, fakeMail, fakeQueue } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post, type PostRecord } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'
import { SendCommentMailJob, type SendCommentMailPayload } from '../app/Jobs/SendCommentMailJob.js'

const mail = fakeMail()

describe('comment mail', () => {
  let http: TestApp
  let ada: UserRecord
  let bob: UserRecord
  let post: PostRecord
  let asBob: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
    // Mail.send() asks the manager for a transport, so the fake goes inside a
    // real manager rather than in place of one.
    const manager = new MailManager({ default: 'fake', from: { email: 'blog@example.com', name: 'Blog' } })
    manager.registerTransport('fake', () => mail.getTransport())
    app.container.fake('mail', manager)
  })

  beforeEach(async () => {
    await resetDatabase()
    mail.clear()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    bob = await User.create({ name: 'Bob', email: 'bob@example.com', password: 'correct horse battery' })
    post = await Post.forceCreate({ title: 'Relativity', body: 'A body', authorId: ada.id })
    asBob = await http.actingAs(bob).withCsrf()
  })

  it('mails the post author when someone else comments', async () => {
    await asBob.post(`/posts/${post.id}/comments`, { body: 'Nice post' }).assertRedirect(`/posts/${post.id}`)

    mail.assertSentTo('ada@example.com')
    mail.assertSentWithSubject('New comment on Relativity')
    mail.assertSentWithBodyContaining('Bob')
  })

  it('does not mail you about your own comment', async () => {
    const asAda = await http.actingAs(ada).withCsrf()

    await asAda.post(`/posts/${post.id}/comments`, { body: 'A note to myself' }).assertRedirect(`/posts/${post.id}`)

    mail.assertNothingSent()
  })

  it('hands the mail to the queue instead of sending it in the request', async () => {
    const queue = fakeQueue()
    // Job.dispatch() reads a module-level driver, not the container, so this
    // seam is a setter and not a container fake. Put the real one back after.
    const real = getQueueDriver()
    setQueueDriver(queue.getDriver())
    try {
      await asBob.post(`/posts/${post.id}/comments`, { body: 'Nice post' }).assertRedirect(`/posts/${post.id}`)

      queue.assertPushed<SendCommentMailPayload>(SendCommentMailJob, (payload) => payload.commentId > 0)
      mail.assertNothingSent()
    } finally {
      if (real) setQueueDriver(real)
    }
  })
})
```

`assertPushed` is given its payload type explicitly. `Job.dispatch` is a generic static, so a job class on its own does not tell TypeScript what its payload is, and an inferred `unknown` makes the predicate fail to compile.

The third test is the one that describes the design rather than the feature. With a fake queue driver in place the job is recorded and never run, so no mail goes out. If that test ever passes *and* mail is sent, the controller is doing the work itself.

```bash run expect-fail
bun test
```

Red on the import: there is no `SendCommentMailJob` yet.

## 3. The four pieces, by hand

An event carries the smallest thing that identifies what happened:

```ts file=app/Events/CommentPosted.ts
import { Event } from '@guren/core'

export class CommentPosted extends Event {
  static override eventName = 'CommentPosted'

  constructor(public readonly commentId: number) {
    super()
  }
}
```

The listener decides what happening means. This one does no work itself; it hands the work to a queue and returns:

```ts file=app/Listeners/SendCommentMailListener.ts
import { Listener } from '@guren/core'
import { CommentPosted } from '../Events/CommentPosted.js'
import { SendCommentMailJob } from '../Jobs/SendCommentMailJob.js'

export class SendCommentMailListener extends Listener<CommentPosted> {
  static override event = CommentPosted

  async handle(event: CommentPosted): Promise<void> {
    await SendCommentMailJob.dispatch({ commentId: event.commentId })
  }
}
```

The job is the piece that may run in another process, minutes later:

```ts file=app/Jobs/SendCommentMailJob.ts
import { Job } from '@guren/core'
import { Comment } from '../Models/Comment.js'
import { User } from '../Models/User.js'
import { NewCommentMail } from '../Mail/NewCommentMail.js'

/** A queued payload is JSON on its way to another process: ids, never records. */
export interface SendCommentMailPayload {
  commentId: number
}

export class SendCommentMailJob extends Job<SendCommentMailPayload> {
  static override queue = 'default'
  static override maxAttempts = 3

  async handle(payload: SendCommentMailPayload): Promise<void> {
    const comment = await Comment.findWith(payload.commentId, ['post', 'author'])
    if (!comment?.post || !comment.author) return

    const postAuthor = await User.find(comment.post.authorId)
    if (!postAuthor || postAuthor.id === comment.authorId) return

    await new NewCommentMail(this.make('mail'), {
      postTitle: comment.post.title,
      commenter: comment.author.name,
      body: comment.body,
      url: `/posts/${comment.post.id}`,
    })
      .to(postAuthor.email)
      .send()
  }
}
```

Two decisions in that file are the chapter's real content. The payload is a `commentId`, not the comment: by the time this runs, the row may have changed, and a record cannot be serialised onto a queue anyway. And "do not mail me about my own comment" lives here, next to the send, rather than in the controller. The controller announces what happened; it does not decide who deserves an email about it.

The mail is the message and nothing else:

```ts file=app/Mail/NewCommentMail.ts
import { Mail, type MailManager } from '@guren/core'

export interface NewCommentMailData {
  postTitle: string
  commenter: string
  body: string
  url: string
}

export class NewCommentMail extends Mail {
  constructor(
    manager: MailManager,
    private readonly data: NewCommentMailData,
  ) {
    super(manager)
  }

  build(): this {
    return this.subject(`New comment on ${this.data.postTitle}`).text(
      `${this.data.commenter} wrote:\n\n${this.data.body}\n\nRead it: ${this.data.url}`,
    )
  }
}
```

You never call `build()`. `send()` calls it once, then checks that the message has a recipient, a subject and a body, and hands it to the transport.

Now the two registrations. The event provider is where a class becomes a subscription:

```ts file=app/Providers/EventProvider.ts
import { ServiceProvider, type EventManager } from '@guren/core'
import { CommentPosted } from '../Events/CommentPosted.js'
import { SendCommentMailListener } from '../Listeners/SendCommentMailListener.js'

export default class EventProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const events = this.container.make<EventManager>('events')
    const listener = new SendCommentMailListener()

    events.on(CommentPosted, (event) => listener.handle(event), {
      priority: SendCommentMailListener.priority,
    })
  }
}
```

Read the wiring closely, because it explains a class of bug you will otherwise meet later. The provider passes `priority` and calls `handle`. That is all it reads. The `Listener` base class also declares `shouldQueue`, `queue` and an optional `shouldHandle()`, and this wiring honours none of them: a listener that sets `shouldQueue = true` and expects the framework to queue it will be run inline, silently. Whatever the class declares, the truth is the line in this file.

The queue provider is where a job class becomes dispatchable:

```ts file=app/Providers/QueueProvider.ts
import { ServiceProvider, MemoryDriver, SyncDriver, createQueueManager, registerJob, type QueueManager } from '@guren/core'
import { SendCommentMailJob } from '../Jobs/SendCommentMailJob.js'

export default class QueueProvider extends ServiceProvider {
  register(): void {
    const queue = createQueueManager({
      // QUEUE_CONNECTION=sync executes jobs inline on dispatch (default,
      // no worker process needed); 'memory' queues them for a Worker.
      default: process.env.QUEUE_CONNECTION === 'memory' ? 'memory' : 'sync',
      drivers: {
        sync: () => new SyncDriver(),
        memory: () => new MemoryDriver(),
      },
    })

    this.container.instance('queue', queue)
  }

  boot(): void {
    // A queued message carries the job's name, so the driver can only run a job
    // the registry knows. Nothing in `guren check` looks for a missing one.
    registerJob(SendCommentMailJob)
    const queue = this.container.make<QueueManager>('queue')
    queue.driver()
  }
}
```

Finally the controller announces:

```ts file=app/Http/Controllers/CommentController.ts
import { Controller } from '@guren/core'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPosted } from '../../Events/CommentPosted.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'

export default class CommentController extends Controller {
  async store(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('create', Comment)
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(CommentPayloadSchema)
    const comment = await Comment.forceCreate({ ...data, postId: post.id, authorId: author.id })
    await this.make('events').emit(new CommentPosted(comment.id))
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    await Comment.delete({ id: comment.id })
    return this.redirect(`/posts/${comment.postId}`)
  }
}
```

`emit` is awaited, and it awaits every listener in priority order. Under `sync` that means the whole chain, job included, finishes before the redirect is returned. That is worth being clear-eyed about: `sync` does not make the work asynchronous, it makes the *code* asynchronous-shaped. When you move to a worker, the controller does not change.

The four samples the blueprints installed have no owner now:

```bash run
rm app/Events/OrderPlaced.ts app/Listeners/SendOrderReceiptListener.ts app/Jobs/ProcessWelcomeSequenceJob.ts app/Mail/WelcomeEmailMail.ts
```

```bash run
bun test
```

Green.

**Checkpoint:** comment on someone else's post in the browser and look at the terminal running `bun run dev`:

```bash manual
[mail] ------------------------------------------------------------
[mail] To: ada@example.com
[mail] From: noreply@example.com
[mail] Subject: New comment on Relativity
[mail] Bob wrote:
[mail]
[mail] Nice post
[mail]
[mail] Read it: /posts/1
[mail] ------------------------------------------------------------
```

That is the `log` transport. Point `MAIL_MAILER` at a real one and the same message leaves the building.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: mail the post author when someone comments"
```

## 4. The registration nothing checks

Run the integrity check and read it for what is *not* there:

```bash run
bunx guren check
```

It has an opinion about your routes, your pages, your schema, your attachments. It has none about `app/Jobs/`. A job class that never reaches `registerJob()` looks perfect: it compiles, it lints, its tests pass if they fake the queue. It fails the first time something dispatches it for real, with a message that at least names the problem:

```bash manual
SyncDriver: job class "SendCommentMailJob" is not registered. Call registerJob() with the class whose jobName (or class name) is "SendCommentMailJob".
```

This is exactly the situation chapter 8 was about: a project invariant the framework cannot see. So write it down where the agent reads it.

```md file=.claude/rules/background-work.md
---
description: Events, listeners and jobs — every job is registered, every listener is wired, and the payload is ids
globs:
  - "app/Events/**"
  - "app/Listeners/**"
  - "app/Jobs/**"
  - "app/Mail/**"
  - "app/Providers/EventProvider.ts"
  - "app/Providers/QueueProvider.ts"
---

# Background work

1. **Every `Job` subclass is registered.** Add `registerJob(TheJob)` to `boot()` in `app/Providers/QueueProvider.ts` in the same change that adds the class. A queued message carries the job's name and the driver resolves it through that registry; an unregistered job throws at dispatch time and `guren check` says nothing about it.
2. **Every listener is wired.** A class in `app/Listeners/` runs only because `app/Providers/EventProvider.ts` calls `events.on(TheEvent, (event) => listener.handle(event), …)`. `shouldQueue`, `queue` and `shouldHandle()` on the class are inert unless that wiring reads them, so do not rely on them: to queue work, dispatch a job from `handle`.
3. **A job payload is JSON: ids, never records.** The job may run in another process, after the row has changed. Load what you need inside `handle`, and return early when the record is gone.
4. **Controllers announce, listeners decide.** A controller emits an event and returns. Rules about who gets mail (skip the actor, skip duplicates) live in the job or the listener, not in the action.
5. **Test the seam, not the plumbing.** Mail is faked by registering a `fakeMail()` transport on a real `MailManager` and binding that with `app.container.fake('mail', manager)`. The queue is faked with `setQueueDriver(fakeQueue().getDriver())`, never through the container, because `Job.dispatch()` reads a module-level driver.
```

The `PostToolUse` hook runs `guren check --arch` after every edit, and check will keep quiet about all five of these. The rule is the check.

```bash run
git add -A
git commit -m "docs: add a background-work rule for the agent"
```

## 5. Specify the announcement

Publishing a post should tell everyone who took the trouble to comment on it. Same four pieces, one shape harder: a fan-out with a de-duplication rule.

```ts file=tests/PostPublishedMail.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { MailManager } from '@guren/core'
import { TestApp, fakeMail } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post, type PostRecord } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { User, type UserRecord } from '../app/Models/User.js'

const mail = fakeMail()

describe('publishing a post', () => {
  let http: TestApp
  let ada: UserRecord
  let post: PostRecord
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
    const manager = new MailManager({ default: 'fake', from: { email: 'blog@example.com', name: 'Blog' } })
    manager.registerTransport('fake', () => mail.getTransport())
    app.container.fake('mail', manager)
  })

  beforeEach(async () => {
    await resetDatabase()
    mail.clear()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    post = await Post.forceCreate({ title: 'Relativity', body: 'A body', authorId: ada.id })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('mails everyone who commented, once each', async () => {
    const bob = await User.create({ name: 'Bob', email: 'bob@example.com', password: 'correct horse battery' })
    const cleo = await User.create({ name: 'Cleo', email: 'cleo@example.com', password: 'correct horse battery' })
    await Comment.forceCreate({ body: 'First', postId: post.id, authorId: bob.id })
    await Comment.forceCreate({ body: 'Second', postId: post.id, authorId: bob.id })
    await Comment.forceCreate({ body: 'Third', postId: post.id, authorId: cleo.id })

    await asAda.post(`/posts/${post.id}/publish`).assertRedirect(`/posts/${post.id}`)

    mail.assertSentTo('bob@example.com')
    mail.assertSentTo('cleo@example.com')
    mail.assertSentWithSubject('Relativity is published')
    mail.assertSentTimes(2)
  })

  it('does not mail the author their own post', async () => {
    await Comment.forceCreate({ body: 'A note to myself', postId: post.id, authorId: ada.id })

    await asAda.post(`/posts/${post.id}/publish`).assertRedirect(`/posts/${post.id}`)

    mail.assertNothingSent()
  })
})
```

`assertSentTimes(2)` is the whole point of the first test. Bob commented twice; Bob gets one email.

```bash run expect-fail
bun test
```

Two red.

## 6. Delegate it

> When a post is published, mail everyone who commented on it. Emit a `PostPublished` event from `publish` in `PostController`, wire a listener in `EventProvider` that dispatches a `NotifyCommentersJob`, and send a `PostPublishedMail` to each distinct commenter, skipping the post's author. `tests/PostPublishedMail.test.ts` describes it; make it pass.

The prompt does not mention `registerJob`, and it does not need to: the rule you wrote in section 4 is scoped to `app/Jobs/**` and `app/Providers/QueueProvider.ts`, so the agent reads it before it writes either. That is the whole experiment. Check the diff for the registration line before you check anything else.

**No agent handy?** The event carries the post:

```ts file=app/Events/PostPublished.ts fallback
import { Event } from '@guren/core'

export class PostPublished extends Event {
  static override eventName = 'PostPublished'

  constructor(public readonly postId: number) {
    super()
  }
}
```

```ts file=app/Listeners/NotifyCommentersListener.ts fallback
import { Listener } from '@guren/core'
import { PostPublished } from '../Events/PostPublished.js'
import { NotifyCommentersJob } from '../Jobs/NotifyCommentersJob.js'

export class NotifyCommentersListener extends Listener<PostPublished> {
  static override event = PostPublished

  async handle(event: PostPublished): Promise<void> {
    await NotifyCommentersJob.dispatch({ postId: event.postId })
  }
}
```

```ts file=app/Mail/PostPublishedMail.ts fallback
import { Mail, type MailManager } from '@guren/core'

export interface PostPublishedMailData {
  postTitle: string
  url: string
}

export class PostPublishedMail extends Mail {
  constructor(
    manager: MailManager,
    private readonly data: PostPublishedMailData,
  ) {
    super(manager)
  }

  build(): this {
    return this.subject(`${this.data.postTitle} is published`).text(
      `A post you commented on is now published.\n\nRead it: ${this.data.url}`,
    )
  }
}
```

```ts file=app/Jobs/NotifyCommentersJob.ts fallback
import { Job } from '@guren/core'
import { Post } from '../Models/Post.js'
import { Comment } from '../Models/Comment.js'
import { User } from '../Models/User.js'
import { PostPublishedMail } from '../Mail/PostPublishedMail.js'

export interface NotifyCommentersPayload {
  postId: number
}

export class NotifyCommentersJob extends Job<NotifyCommentersPayload> {
  static override queue = 'default'
  static override maxAttempts = 3

  async handle(payload: NotifyCommentersPayload): Promise<void> {
    const post = await Post.find(payload.postId)
    if (!post) return

    const comments = await Comment.where('postId', post.id).get()
    const recipientIds = [...new Set(comments.map((comment) => comment.authorId))].filter(
      (id) => id !== post.authorId,
    )
    if (recipientIds.length === 0) return

    const recipients = await User.where({ id: recipientIds }).get()
    const manager = this.make('mail')

    for (const recipient of recipients) {
      await new PostPublishedMail(manager, {
        postTitle: post.title,
        url: `/posts/${post.id}`,
      })
        .to(recipient.email)
        .send()
    }
  }
}
```

```ts file=app/Providers/EventProvider.ts fallback
import { ServiceProvider, type EventManager } from '@guren/core'
import { CommentPosted } from '../Events/CommentPosted.js'
import { PostPublished } from '../Events/PostPublished.js'
import { SendCommentMailListener } from '../Listeners/SendCommentMailListener.js'
import { NotifyCommentersListener } from '../Listeners/NotifyCommentersListener.js'

export default class EventProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const events = this.container.make<EventManager>('events')
    const commentListener = new SendCommentMailListener()
    const publishListener = new NotifyCommentersListener()

    events.on(CommentPosted, (event) => commentListener.handle(event), {
      priority: SendCommentMailListener.priority,
    })
    events.on(PostPublished, (event) => publishListener.handle(event), {
      priority: NotifyCommentersListener.priority,
    })
  }
}
```

```ts file=app/Providers/QueueProvider.ts fallback
import { ServiceProvider, MemoryDriver, SyncDriver, createQueueManager, registerJob, type QueueManager } from '@guren/core'
import { SendCommentMailJob } from '../Jobs/SendCommentMailJob.js'
import { NotifyCommentersJob } from '../Jobs/NotifyCommentersJob.js'

export default class QueueProvider extends ServiceProvider {
  register(): void {
    const queue = createQueueManager({
      // QUEUE_CONNECTION=sync executes jobs inline on dispatch (default,
      // no worker process needed); 'memory' queues them for a Worker.
      default: process.env.QUEUE_CONNECTION === 'memory' ? 'memory' : 'sync',
      drivers: {
        sync: () => new SyncDriver(),
        memory: () => new MemoryDriver(),
      },
    })

    this.container.instance('queue', queue)
  }

  boot(): void {
    // A queued message carries the job's name, so the driver can only run a job
    // the registry knows. Nothing in `guren check` looks for a missing one.
    registerJob(SendCommentMailJob)
    registerJob(NotifyCommentersJob)
    const queue = this.container.make<QueueManager>('queue')
    queue.driver()
  }
}
```

And the publish action announces:

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, ValidationException, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import { Comment } from '../../Models/Comment.js'
import { Tag } from '../../Models/Tag.js'
import { PostTag } from '../../Models/PostTag.js'
import type { UserRecord } from '../../Models/User.js'
import { PostPublished } from '../../Events/PostPublished.js'
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
    await this.make('events').emit(new PostPublished(post.id))
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

```bash run
bun test
```

The rubric:

- `registerJob(NotifyCommentersJob)` is in `QueueProvider.boot()`, and `events.on(PostPublished, …)` is in `EventProvider.boot()`. Without both, the feature is dead code that compiles.
- The payload is `{ postId }`. Recipients are resolved inside `handle`, not passed in.
- Commenters are de-duplicated by author id and the post's author is removed from the list, in the job. Two comments from Bob are one email to Bob.
- `publish` emits and returns. It does not query comments and it does not know that mail exists.
- Both new tests and the three from section 2 are green.

**Checkpoint:** comment on a draft from two accounts, publish it, and watch two `[mail]` blocks and no third one for yourself.

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: mail commenters when a post is published"
```

## Where you are

- An event, a listener, a job and a mail, each registered in a place you can point at.
- A controller that announces and returns, and business rules about recipients that live next to the sending.
- Three test seams: a mail transport inside a real manager, a queue driver set globally, and a request that proves the two are connected.
- A project rule carrying the one invariant `guren check` has no opinion about, and an agent that followed it.

## Common trip-ups

- **`SyncDriver: job class "X" is not registered.`** `registerJob(X)` is missing from `QueueProvider.boot()`. This is the error the rule in section 4 exists to prevent.
- **`Email must have at least one recipient` (or subject, or body).** `send()` validates the built message. A `to()` that received `undefined`, or a `build()` that returns before setting the subject, both land here.
- **Nothing arrives and no error appears.** Check the listener is wired in `EventProvider.boot()`. An event with no listeners is a successful `emit`.
- **`container.fake('queue', …)` changes nothing in a test.** `Job.dispatch()` resolves its driver from a module-level setter, not the container. Use `setQueueDriver()`, and put the previous driver back.
- **A test faking `mail` with `fakeMail()` directly throws.** `Mail.send()` calls `manager.transport(name)`, and the fake is a transport, not a manager. Register it on a real `MailManager` and bind that.
- **The mail is sent during the request even though there is a queue.** That is `QUEUE_CONNECTION=sync` working as designed. Set it to `memory` and run `bunx guren queue:work` to watch a worker drain the queue instead.

## Next

[Chapter 12: Your App as an Agent's Tool](./12-agent-tools.md) turns the routes you already have into tools an agent can call, and shows the same authorization gap from chapter 7 becoming a hard failure instead of a passing audit.
