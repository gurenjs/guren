# 第 11 章: イベントとメール

ここまでの処理はすべてリクエストの中で完結していました。検証し、行を 1 つ書き、リダイレクトする。この章で扱うのは、そこに収めてはいけない仕事です。Bob が Ada の投稿にコメントすると Ada にメールが届きます。ただし Bob のブラウザは、ページが表示されるまでメールサーバーの応答を待たされてはいけません。

この一文に名前が 4 つ付きます。この章の大半は、なぜ 4 つに分かれるのかの説明です。

| 部品 | 答えるもの |
|---|---|
| **イベント** | 何かが起きた。コントローラーはそれを告知し、あとは気にしません。 |
| **listener** | 気にする誰か。告知に対して何をするかを決めます。 |
| **ジョブ** | リクエストより長生きする仕事。キューに載るペイロードで、拾った側が実行します。 |
| **メール** | メッセージそのもの。件名、本文、宛先。 |

リクエストは最初の箱で終わります。その先は、読者を待たせずに進む仕事です。

```mermaid
flowchart LR
  Controller["CommentController<br/>emit(new CommentPosted)"]
  Listener["SendCommentMailListener<br/>ジョブを dispatch する"]
  Job["SendCommentMailJob<br/>payload: { commentId }"]
  Mail["NewCommentMail<br/>投稿の著者へ"]
  Controller --> Listener --> Job --> Mail
```

**この章で学ぶこと:**

- 4 つがそれぞれどこで登録されるのかと、誰も代わりに検査してくれない唯一の登録
- ジョブのペイロードがレコードではなく id である理由
- `QUEUE_CONNECTION=sync` が実際にしていることと、sync をやめたときに変わること
- メールとキューをコンテナ経由で fake にする方法と、どちらの fake も本物のマネージャーの中に入れる理由

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. 3 つのレイヤー、3 つのコマンド

```bash run
bunx guren add events
```

```bash run
bunx guren add queue
```

```bash run
bunx guren add mail
```

どのコマンドも、その種類のサンプルと、それを動かすものを書き、`src/app.ts` に登録しました。開いてみてください。providers の配列は 1 行に書き直され、末尾に 3 つの要素が増えています。events はフレームワークのプロバイダーとアプリのプロバイダーを 1 つずつ、queue は `JobsProvider` を足しました。キューとメールのマネージャーは `config: [...]` の `queue` と `mail` です。この 1 行化はパッチを当てたコマンドによるもので、どの `add` コマンドも同じ形を残していきます。

次のファイルは読んでおく価値があります。うち 2 つは、このあと自分で編集するファイルです。

- `app/Providers/EventProvider.ts` は listener クラスを `events.listen()` に渡し、クラスが指定するイベントを購読させます。結び付けているのは規約ではなくコードの 1 行です。`app/Listeners/` を走査して仕事を探すものは何もありません。
- `config/queue.ts` はキューマネージャーを構築し、`app/Providers/JobsProvider.ts` はジョブクラスごとに `registerJob()` を呼びます。config のドライバーの行に注目してください。`QUEUE_CONNECTION=sync` は dispatch されたジョブを**インラインで、dispatch したプロセスの中で**実行します。`memory` はワーカーが処理するキューに載せます。`guren add queue` が `.env` に `sync` と書き込みました。
- `config/mail.ts` はメールマネージャーを構築します。同じく `.env` にある `MAIL_MAILER=log` は、メールを送る代わりに送信予定の内容をサーバーの出力に印字します。サービスの申し込みは要りませんし、うっかり本当に配送してしまうこともありません。

サンプル(`OrderPlaced`、`SendOrderReceiptListener`、`ProcessWelcomeSequenceJob`、`WelcomeEmailMail`)は、それぞれのファイルの形を確認できるように置かれています。第 3 節でこの 4 つをすべて置き換えます。

## 2. メールを仕様化する

テストは 3 つです。3 つともメールのトランスポートを fake にし、3 つ目はキューも fake にします。アサーションより先にセットアップを読んでください。

```ts file=tests/CommentMail.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { MailManager, createQueueManager } from '@guren/core'
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
    // Job.dispatch() sends through the bound queue manager's default driver, so
    // the fake driver goes inside a real manager too. `using` restores the app's
    // own manager when the test ends.
    using _queue = app.container.fake(
      'queue',
      createQueueManager({ default: 'fake', drivers: { fake: () => queue.getDriver() } }),
    )

    await asBob.post(`/posts/${post.id}/comments`, { body: 'Nice post' }).assertRedirect(`/posts/${post.id}`)

    queue.assertPushed<SendCommentMailPayload>(SendCommentMailJob, (payload) => payload.commentId > 0)
    mail.assertNothingSent()
  })
})
```

`assertPushed` にはペイロードの型を明示的に渡しています。`Job.dispatch` はジェネリックな static なので、ジョブクラスだけでは TypeScript にペイロードの型が伝わりません。推論結果が `unknown` になると、述語がコンパイルできなくなります。

3 つ目のテストが記述しているのは、機能ではなく設計です。fake のキュードライバーを差し込むとジョブは記録されるだけで実行されないので、メールは 1 通も出ません。このテストが通っていて*かつ*メールが送られているなら、コントローラーが自分で仕事をしています。

```bash run expect-fail
bun test
```

import で赤です。`SendCommentMailJob` がまだありません。

## 3. 4 つの部品を手で書く

イベントは、何が起きたかを特定できる最小のものを運びます。

```ts file=app/Events/CommentPosted.ts
import { Event } from '@guren/core'

export class CommentPosted extends Event {
  static override eventName = 'CommentPosted'

  constructor(public readonly commentId: number) {
    super()
  }
}
```

listener は、それが起きたことの意味を決めます。この listener 自身は何もせず、仕事をキューに渡して戻ります。

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

ジョブは、別のプロセスで、数分後に実行されるかもしれない部品です。

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

このファイルにある 2 つの判断が、この章の本題です。ひとつは、ペイロードがコメントそのものではなく `commentId` であること。実行されるころには行が変わっているかもしれませんし、そもそもレコードはキューにシリアライズできません。もうひとつは、「自分のコメントについて自分にメールを送らない」というルールが、コントローラーではなく送信の隣にあること。コントローラーは何が起きたかを告知するだけで、誰がそのメールを受け取るべきかは決めません。

メールはメッセージそのもので、それ以上のことはしません。

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

`build()` を自分で呼ぶことはありません。`send()` が一度だけ呼び、それからメッセージに宛先と件名と本文があることを検査して、トランスポートに渡します。

続いて 2 つの登録です。イベントプロバイダーは、クラスを購読に変える場所です。

```ts file=app/Providers/EventProvider.ts
import { ServiceProvider, type EventManager } from '@guren/core'
import { SendCommentMailListener } from '../Listeners/SendCommentMailListener.js'

export default class EventProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const events = this.container.make<EventManager>('events')

    events.listen(SendCommentMailListener)
  }
}
```

`listen()` はクラスを受け取り、設定をクラス自身から読みます。`event` は購読するイベントです。`priority` は同じイベントの listener 同士の順番で、大きいほうが先に走ります。`shouldHandle()` をクラスが定義していれば、`handle` の前にイベントを見送れます。`shouldQueue = true` にすると、listener は直接呼ばれず、`queue` で指定したキューに渡されます。ただし `sync` のキューはそれをその場で実行するので、リクエストの外に出るのは、本物のキューをワーカーが処理するときだけです。インスタンスはイベントごとに作り直されるので、あるコメントで持った状態が次のコメントに持ち越されることはありません。

`SendCommentMailListener` は `shouldQueue` を `false` のままにして、代わりにジョブを dispatch します。キューに載せた listener がワーカーに送るのはイベントです。ジョブが送るのは自分で決めたペイロードで、ジョブ固有の `maxAttempts` も持ちます。3 つ目のテストが fake のキューで探しているのも、このジョブです。

`events.on(CommentPosted, (event) => listener.handle(event))` でも listener は動きますが、`Listener` クラスにはこの配線を使いません。`on()` が受け取るのは関数だけで、それがどのクラスから来たかを知りません。そのため `shouldHandle()` も `shouldQueue` も、何の警告もなく無視されます。

ジョブプロバイダーは、ジョブクラスが dispatch 可能になる場所です。

```ts file=app/Providers/JobsProvider.ts
import { ServiceProvider, registerJob } from '@guren/core'
import { SendCommentMailJob } from '../Jobs/SendCommentMailJob.js'

// config/queue.ts binds the queue; this registers the jobs it runs.
export default class JobsProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    // A queued message carries the job's name, so the driver can only run a job
    // the registry knows. Nothing in `guren check` looks for a missing one.
    registerJob(SendCommentMailJob)
  }
}
```

最後に、コントローラーが告知します。

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

`emit` は await されており、その中で優先度順にすべての listener が await されます。`sync` のもとでは、ジョブまで含めた連鎖全体がリダイレクトを返す前に終わります。ここは正確に捉えておいてください。`sync` が非同期にするのは仕事そのものではなく、*コード*の形です。ワーカーへ移行しても、コントローラーは変わりません。

ブループリントが置いた 4 つのサンプルは、もう役目を終えました。

```bash run
rm app/Events/OrderPlaced.ts app/Listeners/SendOrderReceiptListener.ts app/Jobs/ProcessWelcomeSequenceJob.ts app/Mail/WelcomeEmailMail.ts
```

```bash run
bun test
```

緑です。出力に `[guren] Deprecation` で始まる行がひとつも無いことも確かめてください。キューの fake はコンテナ経由なので、非推奨の API を通っていません。

**チェックポイント:** ブラウザで他人の投稿にコメントし、`bun run dev` が動いているターミナルを見てください。

```bash manual
[mail] ------------------------------------------------------------
[mail] To: ada@example.com
[mail] From: hello@example.com
[mail] Subject: New comment on Relativity
[mail] Bob wrote:
[mail]
[mail] Nice post
[mail]
[mail] Read it: /posts/1
[mail] ------------------------------------------------------------
```

これが `log` トランスポートです。`MAIL_MAILER` を本物のトランスポートに向ければ、同じメッセージがそのまま外へ送られます。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: mail the post author when someone comments"
```

## 4. 誰も検査しない登録

整合性チェックを実行して、そこに*無い*ものを読み取ってください。

```bash run
bunx guren check
```

このコマンドはルート、ページ、スキーマ、attachments については意見を持ちますが、`app/Jobs/` については何も言いません。`registerJob()` に届いていないジョブクラスも完璧に見えます。コンパイルは通り、lint も通り、キューを fake するテストなら通ります。失敗するのは、何かが実際にそれを dispatch した最初のときです。そのときのメッセージは、少なくとも問題のジョブ名は教えてくれます。

```bash manual
SyncDriver: job class "SendCommentMailJob" is not registered. Call registerJob() with the class whose jobName (or class name) is "SendCommentMailJob".
```

これは第 8 章で扱った状況そのものです。フレームワークからは見えない、プロジェクト固有の不変条件です。エージェントが読む場所に書き留めておきましょう。

```md file=.claude/rules/background-work.md
---
paths:
  - "app/Events/**"
  - "app/Listeners/**"
  - "app/Jobs/**"
  - "app/Mail/**"
  - "app/Providers/EventProvider.ts"
  - "app/Providers/JobsProvider.ts"
---

# Background work

1. **Every `Job` subclass is registered.** Add `registerJob(TheJob)` to `boot()` in `app/Providers/JobsProvider.ts` in the same change that adds the class. A queued message carries the job's name and the driver resolves it through that registry; an unregistered job throws at dispatch time and `guren check` says nothing about it.
2. **Every listener is wired with `listen()`.** A class in `app/Listeners/` runs only because `boot()` in `app/Providers/EventProvider.ts` calls `events.listen(TheListener)`. That call reads the class's `event`, `priority`, `shouldQueue`, `queue` and `shouldHandle()`. Never wire a `Listener` class through `events.on(TheEvent, (event) => listener.handle(event))`: `on()` sees only the function, so `shouldHandle()` and `shouldQueue` are silently ignored. To queue work, dispatch a job from `handle`; set `shouldQueue` only when the listener itself should run on the worker.
3. **A job payload is JSON: ids, never records.** The job may run in another process, after the row has changed. Load what you need inside `handle`, and return early when the record is gone.
4. **Controllers announce, listeners decide.** A controller emits an event and returns. Rules about who gets mail (skip the actor, skip duplicates) live in the job or the listener, not in the action.
5. **Test the seam, not the plumbing.** A fake goes inside a real manager, and the manager is bound with `app.container.fake(key, manager)`. For mail, register a `fakeMail()` transport on a `MailManager` and bind it as `mail`. For the queue, give `createQueueManager()` a driver factory that returns `fakeQueue().getDriver()` and bind it as `queue` with `using`, so the app's own manager comes back when the test ends. Neither fake is a manager, so binding one directly throws. Do not use `setQueueDriver()`: it is deprecated and removed in 3.0.0.
```

`PostToolUse` hook は編集のたびに `guren check --arch` を実行しますが、check はこの 5 つのどれについても何も言いません。ここではこの rule 自体がチェックの役目を果たします。

```bash run
git add -A
git commit -m "docs: add a background-work rule for the agent"
```

## 5. 告知を仕様化する

投稿を公開したら、わざわざコメントしてくれた全員に知らせたいところです。使う部品は同じ 4 つですが、形はひとつ難しくなります。重複排除のルールを伴う一斉送信です。

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

最初のテストの要点は `assertSentTimes(2)` に尽きます。Bob は 2 回コメントしましたが、受け取るメールは 1 通です。

```bash run expect-fail
bun test
```

赤は 1 件です。2 つ目のテストは最初から緑ですが、理由は褒められたものではありません。まだメールを送るものが何も無いので、何もしないアプリでも `assertNothingSent()` は満たされてしまいます。このテストが仕事をしはじめるのは、1 つ目が通ってからです。

## 6. 委ねる

> When a post is published, mail everyone who commented on it. Emit a `PostPublished` event from `publish` in `PostController`, wire a listener in `EventProvider` that dispatches a `NotifyCommentersJob`, and send a `PostPublishedMail` to each distinct commenter, skipping the post's author. `tests/PostPublishedMail.test.ts` describes it; make it pass.

このプロンプトは `registerJob` に触れていませんが、触れる必要もありません。第 4 節で書いた rule は `app/Jobs/**` と `app/Providers/JobsProvider.ts` にスコープされているので、エージェントはそのどちらかを書く前に rule を読みます。この実験の狙いはそこにあります。何よりも先に、diff の中の登録の行を確かめてください。

**手元にエージェントが無い場合は、** イベントが投稿を運びます。

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
import { SendCommentMailListener } from '../Listeners/SendCommentMailListener.js'
import { NotifyCommentersListener } from '../Listeners/NotifyCommentersListener.js'

export default class EventProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    const events = this.container.make<EventManager>('events')

    events.listen(SendCommentMailListener)
    events.listen(NotifyCommentersListener)
  }
}
```

```ts file=app/Providers/JobsProvider.ts fallback
import { ServiceProvider, registerJob } from '@guren/core'
import { SendCommentMailJob } from '../Jobs/SendCommentMailJob.js'
import { NotifyCommentersJob } from '../Jobs/NotifyCommentersJob.js'

// config/queue.ts binds the queue; this registers the jobs it runs.
export default class JobsProvider extends ServiceProvider {
  register(): void {}

  boot(): void {
    // A queued message carries the job's name, so the driver can only run a job
    // the registry knows. Nothing in `guren check` looks for a missing one.
    registerJob(SendCommentMailJob)
    registerJob(NotifyCommentersJob)
  }
}
```

そして publish アクションが告知します。

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

rubric は次のとおりです。

- `registerJob(NotifyCommentersJob)` が `JobsProvider.boot()` にあり、`events.listen(NotifyCommentersListener)` が `EventProvider.boot()` にある。この 2 つが揃っていなければ、この機能はコンパイルの通る死んだコードです。`events.on(...)` で配線した listener もここでは動きますが、rule 2 に反します。
- ペイロードは `{ postId }`。宛先は渡されるのではなく `handle` の中で解決される。
- コメントした人が著者 id で重複排除され、投稿の著者がリストから外れる。しかもジョブの中で。Bob からのコメント 2 件に対して、Bob へのメールは 1 通です。
- `publish` は emit して戻る。コメントを問い合わせもしないし、メールの存在も知らない。
- 新しいテスト 2 件と、第 2 節の 3 件がどちらも緑。

**チェックポイント:** 下書きに 2 つのアカウントからコメントし、それを公開して、`[mail]` のブロックが 2 つ出ることと、自分宛ての 3 つ目が出ないことを確かめてください。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: mail commenters when a post is published"
```

## いまいる場所

- イベント、listener、ジョブ、メール。それぞれが、場所を指し示せる形で登録されている。
- 告知して戻るコントローラーと、送信の隣に置かれた宛先に関する業務ルール。
- テストの継ぎ目 3 つ: 本物のマネージャーの中のメールトランスポート、もうひとつのマネージャーの中のキュードライバー、そしてその 2 つがつながっていることを示すリクエスト。
- `guren check` が意見を持たない唯一の不変条件を書き留めたプロジェクトの rule と、それに従ったエージェント。

## よくあるつまずき

- **`SyncDriver: job class "X" is not registered.`** `JobsProvider.boot()` に `registerJob(X)` がありません。第 4 節の rule は、まさにこのエラーを防ぐために存在します。
- **`Email must have at least one recipient`(あるいは subject、body)。** `send()` は組み立てられたメッセージを検証します。`undefined` を受け取った `to()` も、件名を設定する前に return する `build()` も、どちらもここに行き着きます。
- **何も届かないのにエラーも出ない。** listener が `EventProvider.boot()` で配線されているか確かめてください。listener がひとつも無いイベントは、成功した `emit` です。
- **キューを fake にしたテストで `manager.getDefaultDriverName is not a function` が出て、リクエストが 500 を返す。** `fakeQueue()` を `queue` に直接バインドしています。このキーが保持するのは `QueueManager` で、fake はドライバーです。`fakeMail()` を `mail` にバインドしたときと同じ間違いです。ドライバーを `createQueueManager()` のファクトリーから返し、そのマネージャーをバインドしてください。
- **テストの出力に `[guren] Deprecation (global-service-setters): setQueueDriver() is deprecated` が出る。** ドライバーをピンで固定しているテストが残っています。第 2 節と同じように `app.container.fake('queue', …)` でマネージャーをバインドしてください。このピンは 3.0.0 で削除されます。
- **`fakeMail()` で `mail` を直接 fake したテストが throw する。** `Mail.send()` は `manager.transport(name)` を呼びますが、fake はマネージャーではなくトランスポートです。本物の `MailManager` に登録し、それをバインドしてください。
- **キューがあるのにメールがリクエストの中で送られる。** `QUEUE_CONNECTION=sync` が設計どおりに動いています。`memory` に設定して `bunx guren queue:work` を実行すれば、代わりにワーカーがキューを処理します。

## 演習

1. `.env` の `QUEUE_CONNECTION` を `memory` にしてサーバーを再起動し、コメントを投稿してください。メールは出ません。次に別のターミナルで `bunx guren queue:work --once` を走らせてください。それでも何も起きません。理由を説明してから値を戻してください。その答えが、`memory` が開発用のドライバーであってデプロイ向きではない理由です。
2. `CommentPosted` に、ログを出すだけで `priority` の高い listener をもう 1 つ登録してください。先に走るのはどちらですか。次に先に走るほうで例外を投げて、もう一方とリクエストに何が起きるかを答えてください。

## 次へ

[第 12 章: アプリをエージェントのツールにする](./12-agent-tools.md) では、すでにあるルートをエージェントが呼び出せるツールに変えます。第 7 章と同じ認可のギャップが、通過する audit ではなくはっきりした失敗として現れます。
