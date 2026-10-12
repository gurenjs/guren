# 計画からコードとテストを生成する

`plan:next` は、`scaffold` と `tests` のステップを `plan:scaffold` で書くよう指示します。`plan:scaffold` は、承認済みの計画からコードとテストの雛形を書き出します。このページでは、書き出すもの、残しておくもの、拒否する場合を説明します。前後の流れは[実装計画](./implementation-plans.md)にあります。

## scaffold ステップ: `plan:scaffold`

新しいモデルを追加するタスクは `scaffold` ステップから始まり、`plan:next` がそのステップを書くコマンドを示します。

```text
Next: task/entity/model.comment/scaffold
  task: entity Comment (task/entity/model.comment)
  verify: codegen → typecheck

Write this step with `bunx guren plan:scaffold docs/plans/comments/plan.json --step task/entity/model.comment/scaffold`, not by hand.
  It writes each added model (table and class), its validators and resources, each policy with a provider registering it, each added controller with its actions as stubs, the routes to them in a file of their own that the http step mounts, and the side-effect classes: model.comment, column.comment.id, column.comment.body, column.comment.postId, column.comment.createdAt, validator.comment, controller.comments, action.comments.store, action.comments.destroy, route.comments.store, route.comments.destroy, resource.comment, policy.comment
```

```bash
bunx guren plan:scaffold docs/plans/comments/plan.json --step task/entity/model.comment/scaffold
```

このコマンドは、追加する各モデルのテーブルを、スキーマの方言に合わせて `db/schema.ts` に追記します。テーブルには、計画でカラムに書いたオプションがすべて反映されます。型、null 許容、`unique`、`index`、`default`、`columnName`、`withTimezone`、精度とスケール、主キー、外部キーとその `onDelete` に加えて、モデルの複数カラムのインデックスも入ります。

```typescript
export const comments = pgTable('comments', {
  id: serial('id').primaryKey(),
  body: text('body').notNull(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('comments_post_id_index').on(table.postId),
])
```

`app/Models/Comment.ts` には、計画の `fillable` とリレーションが書かれます。リレーションのキーは、計画に書かれた外部キーから決まります。キーや相手がまだ存在しないリレーションは書かずに一覧で示すので、それがそろうステップで追加してください。後のタスクの作業を待っているリレーション (次のタスクで追加する子への `hasMany` など) については、その作業を受け持つステップ (後のタスクの `data` ステップか、その分割の 1 つ) が一覧に示されます。そのリレーションは、待っている先のモデルの性質としてそのステップで判定され、宣言する側のモデルのファイルに書きます。`plan:next` も、そのステップでこのリレーションを挙げます。それ以外のリレーションを書かずにおくと、追加するまで `plan:status` はそのモデルを `drifted` と判定します。

ステップの validator は、モデルの名前を付けた 1 つのファイル `app/Http/Validators/CommentValidator.ts` にまとめて書かれ、validator ごとにスキーマが 1 つ export されます。各フィールドは、計画の型、`required`、ルール (`min`、`max`、`email`、`url`、`uuid`) から、`plan:status` が読み返せる形で書かれます。

```typescript
import { z } from 'zod'

export const CommentPayloadSchema = z.object({
  body: z.string().min(1).max(2000),
})
```

アクションが `query` や `params` に使う validator では、数値と真偽値を `z.coerce.number()` と `z.stringbool()` で書きます。これらの値は文字列として届くためです。文章で書かれたルールや、フィールドの型に合わないルール (真偽値に対する上限など) は書かずに、レポートに一覧で示します。

このステップでモデルを追加する Resource は、計画のペイロード型を持つ `Resource` のサブクラスとして書かれます。このペイロード型は、`guren codegen` が `data.gen.ts` を作るときに読みます。カラムから読み返せる値がすべて計画の型に収まるフィールドには、カラムの値をそのまま使います。計画で `string` とした日時のカラムは `toISOString()` で文字列にし、JSON のカラムは計画の型にキャストします。それ以外のフィールドでは、対応付けるまで例外を投げるスタブを呼び、レポートに一覧で示します。

```typescript
export class CommentResource extends Resource<CommentRecord, CommentResourceData> {
  toArray(): CommentResourceData {
    return {
      id: this.resource.id,
      body: this.resource.body,
      createdAt: this.resource.createdAt.toISOString(),
    }
  }
}
```

Policy には、計画の ability ごとにメソッドが 1 つ書かれます。どのメソッドもルールを書くまでは `false` を返し、計画のルールはメソッドのコメントに残ります。`app/Providers/CommentPolicyProvider.ts` が `boot()` でその Policy をゲートに登録し、コマンドはこのプロバイダーを `src/app.ts` の `createApp({ providers })` に追加します。`plan:status` は Policy を ability で判定し、登録までは読まないので、Policy は `present` になれば完了です。

ステップで追加するコントローラーには、計画したアクションだけが書かれます。各アクションは、計画の validator で `params` と `query` を検証し、計画の Policy の ability で認可し、`body` を検証してから 501 を返します。そのため Policy が拒否した呼び出しは、何を送っても 403 になります。

```typescript
export default class CommentController extends Controller {
  // Planned response: a redirect to /posts/:postId
  // Rule: The comment's author is the signed-in user.
  // postId is not fillable: write it with Comment.create(data, { set: { postId } }) (RFC 0031)
  async store(): Promise<Response> {
    await this.validateBody(CommentPayloadSchema)
    throw HttpException.notImplemented('CommentController.store is planned and not written yet')
  }

  // Planned response: a redirect to /posts/:postId
  async destroy(): Promise<Response> {
    const comment = this.model(Comment)
    await this.authorize('delete', [Comment, comment])
    throw HttpException.notImplemented('CommentController.destroy is planned and not written yet')
  }
}
```

ability は、レコードに対して `[Model, record]` の形で確認します。ORM のレコードはクラスを持たないので、ゲートがそこから Policy を探せないためです。レコードなしで確認する `viewAny` と `create` 以外の ability で、アクションへのルートがすべて Policy のモデルのレコードを 1 つバインドしている場合、スタブは `this.model()` でそのレコードを取り出してタプルを渡します。そうでない場合はクラスだけを渡し、レコード単位の ability (`view`、`update`、`delete` など) であれば、レコードを読み込んだあとで渡すべきタプルをアクションの上のコメントに示します。`POST` ルートで本文を受け取るアクションでは、同じコメントに、計画で追加するモデルの `fillable` に含まれない外部キーを並べます。`create()` は data にそれらが含まれていると拒否するので、`set` で渡します (RFC 0031)。

検証には `validated('comments.store')` ではなく `validateBody()` を使います。`validated()` の型は生成されたルート名から決まりますが、`http` ステップでマウントするまでルートは登録されないためです。レスポンスも書きません。`plan:status` は名前を読み取れるレスポンス (Resource、ページ、リダイレクト) を実装済みと数えるので、スタブがそれを書くと完了したように見えてしまいます。各アクションのレスポンスは、書き残したものとしてレポートに並びます。

これらのアクションへのルートは、専用のファイル `routes/comments.ts` に書かれます。メソッド、パス、名前、契約のスキーマ、バインディング、`auth` ミドルウェア、`.agent()` のメタデータは計画のとおりです。

```typescript
export function registerCommentRoutes(router: Router): void {
  const authRouter = router.aliasMiddleware('auth', requireAuthenticated({ redirectTo: '/login' }))
  authRouter.post('/posts/:postId/comments', { name: 'comments.store', body: CommentPayloadSchema, bind: { postId: Post } }, [CommentController, 'store']).middleware('auth')
  authRouter.delete('/comments/:id', { name: 'comments.destroy', bind: { id: Comment } }, [CommentController, 'destroy']).middleware('auth')
}
```

このファイルはまだどこからも呼ばれていないので、ルートは登録されず、`planned` と判定されます。ここでルートをマウントしてしまうと、`tests` ステップより前に 401 や 422 を返すことがあり、すでに通る振る舞いがあるとそのステップは失敗します。付けるミドルウェアは `auth` だけです。計画にほかのミドルウェア名があれば一覧で示し、アプリケーションがその名前に割り当てたハンドラーを知っている `http` ステップに任せます。計画が承認済みでまだ閉じておらず、その `http` ステップが未検証のあいだは、`guren check` はマウントされていないこのファイルを参考扱いの警告 (advisory) として報告します。そのため、途中のステップで `guren gate` が止まることはありません。そのステップが検証されるか計画が閉じたあとは、マウントされていないファイルはふたたび通常の警告になります。

ステップで追加するジョブ、イベント、リスナー、メール、通知は、対応する `make:*` コマンドと同じ形で、計画のクラス名を使って書かれます。`plan:status` はこれらを `present` と判定します。`wired` になるのは何かがディスパッチ、登録、送信したあとで、それは `http` ステップの作業です。`docs/entities/Comment.md` がすでにあれば、コントローラーとルートのファイルに `@docs docs/entities/Comment.md` を書きます。まだないドキュメントを指すタグは `guren check` で失敗するので、その場合は書きません。

このコマンドは codegen もマイグレーションも実行しません。codegen と型検査は `plan:verify` が、マイグレーションの生成は `data` ステップが受け持ちます。

拒否するかどうかは、すべて最初の書き込みより前に判定します。拒否されるのは次の場合です。

- 下書き、またはどの承認にも記録されていない計画
- `scaffold` と `tests` 以外のステップ (そのタスクの scaffold ステップを示します)、または `plan:next` が印を付けていないステップ
- モジュールに属するモデル、validator、Resource、Policy、コントローラー、副作用 (書き込み先はプロジェクトのルートだけです) と、API 専用のアプリケーション
- MySQL で `text` か `json` のカラムに付けたキー (主キー、`unique`、インデックス、MySQL がインデックスを作る外部キー)。drizzle-kit が拒否し、MySQL もプレフィックス長のないキーを受け付けません (カラムを `string` にするか、キーを外してください)。値が `null` の `default` も拒否されます
- 名前が `Resource` で終わらない Resource (`guren codegen` が見つけられないため)、`Policy` 自身のメンバー (`before`、`allow`、`deny`) と同じ名前の ability、`Controller` のメンバー (`redirect`、`json`) と同じ名前のアクション
- 登録できない Policy プロバイダー。`src/app.ts` も `app.ts` もない場合、書き換えられる `createApp()` の呼び出しがない場合、すでに登録されている場合が該当します
- すでに存在する書き込み先。モデルのファイルやクラス、スキーマの export、いずれかのアプリケーションルートにあるテーブル名、作成するファイル、ほかの validator ファイルが export している validator 名、同じ名前の Resource、Policy、コントローラー、副作用のクラスが対象です

scaffold 済みのステップでもう一度実行すると、ファイルがすでにあるので同じように拒否されます。その場合はステップを検証してください。`--json` を付けると、作ったファイル、追記したテーブル、登録したプロバイダー、マウントせずに残したルートのファイルとそれをマウントするステップ、書いた要素、残した要素、スタブにしたものや書かなかったもの、書かなかったリレーションが出力されます。

## ルートのマウント: `plan:scaffold --mount`

scaffold が書いたルートを持つ `http` ステップでは、最初にそのルートをマウントします。実行するコマンドは `plan:next` が示します。

```text
Mount the routes the scaffold step wrote first, with `bunx guren plan:scaffold docs/plans/comments/plan.json --step task/entity/model.comment/http --mount`, not by hand: it calls routes/comments.ts from the entry registrar.
  Written as stubs by plan:scaffold, to finish: validator.comment, controller.comments, action.comments.store, action.comments.destroy, route.comments.store, route.comments.destroy, resource.comment, policy.comment. Each action validates and authorizes as planned and answers 501; write its body and response.
```

このコマンドは `registerCommentRoutes` を `routes/web.ts` に import し、そこの registrar の先頭で呼び出します。先頭で呼ぶので、エントリーで設定した `auth` の別名が、ルートのファイルでの設定より優先されます。マウントしたルートは、エントリー自身のルートより先に登録されます。そのため、`/posts/:id` のようにパラメーターを含む scaffold のパスが、`/posts/create` のようなエントリーのルートを覆ってしまうことがあります。パスが重なる場合は順序を確かめてください。マウントすると、`plan:status` はルートとそのアクションを `wired` と判定し、それらが使う validator も `wired` になります。残る作業は、各アクションの本体とレスポンス、そして scaffold がスタブにしたものや書かなかったものです。

次の場合は、何も書かずに拒否します。下書きやどの承認にも記録されていない計画、`plan:next` が印を付けていないステップ、scaffold したルートを持たないステップ (持っているステップを示します)、存在しないルートのファイルや registrar を export しなくなったファイル、`routes/web.ts` のないアプリケーション、registrar と同じ名前で別のものを import しているエントリー、すでにマウントされたファイルです。エントリーが直接呼んでいる場合も、別のルートのファイルが呼んでいる場合も、マウント済みとみなします。

## テストの雛形: tests ステップの `plan:scaffold`

`tests` ステップも同じコマンドで書きます。`plan:scaffold <plan> --step <task>/tests` を実行すると、`tests/plans/<plan>/<collection>.test.ts` が 1 つ書かれます (comments の計画なら `tests/plans/comments/comments.test.ts`)。中身は、ステップの振る舞いごとに 1 つずつの `TestApp` テストです。

```ts
test('[AC-comments-1] A signed-in user can comment on a post.', async () => {
  given('a post exists')
  const actor = given<object>('the actor: user')
  const postId = given<number | string>('the :postId parameter')
  await (await client(actor)).post(`/posts/${postId}/comments`, { body: 'Nice post' }).assertStatus(302)
  expect(await Comment.where({ body: 'Nice post' }).first()).not.toBeNull()
})
```

- タイトルは振る舞いの id で始まり、`plan:verify` はこの id でファイルを選びます。計画の文中にある角括弧は丸括弧に置き換えて書くので、ファイルがほかの id を含むことはありません。
- リクエストは、ルートが示すものを書きます。メソッド、パラメーターをセグメント全体の埋め込みにしたパス、ボディ (`GET` ならクエリ文字列) にした `input` です。
- 期待値は計画に書かれたものを使います。`status`、`redirect` (ルートと共通のパラメーターにはルートの値を使います)、`inertia` (JSON を求めるリクエストにして、Inertia のバージョン確認を通さずにページを受け取ります)、`errors` (JSON のボディから読みます)、`database` の行を書きます。行の確認はモデルを通したクエリで、ルートにモデルがあり、計画のカラムの型と比べられる値のときに書きます。行の準備と後片付けは、実装する側の作業です。ほかのテストが残した行があると、実装とは関係なく期待値が通ったり失敗したりします。
- 計画に文章で書いた前提、ルートがサインインを求める場合のアクター、パスの各パラメーターは、呼ぶと例外を投げる `given()` の呼び出しになります。雛形に書けない期待値は、同じく例外を投げる `unwritten()` の呼び出しになります。期待する 404 も同じ扱いです。まだないルートも 404 を返すからです。どれもレポートと出力に一覧で示します。
- `ready()` は `src/app.ts` を import し、`TestApp.fromApp()` で一度だけ起動します。ファイルの `beforeAll` がこれを呼ぶので、行の作成や削除のために追加した `beforeEach` より先に ORM が設定されます。Bun のフックの既定の制限時間は 5 秒ですが、起動は 120 秒まで待ちます。起動に失敗しても `beforeAll` では例外を投げずに出力するだけなので、追加したフックの内容に関係なく、`plan:verify` はステップを `blocked` と記録します。そして `ready()` か `client()` を呼んだテストが、それぞれその失敗を理由に名前付きで失敗します。自分で追加するフックは `await ready()` から始めてください。そうすれば、各テストが報告するのはデータベースのエラーではなく起動の失敗になります。
- `client()` は起動済みのアプリケーションを返し、アクターを渡すとそのアクターとして振る舞います。アプリケーションが CSRF をマウントしていれば、`withCsrf()` で準備します。`cookie: false` で CSRF をマウントしたアプリケーションには対応していません。
- サインイン済みのアクターを用意するのは、`auth` か `auth:*` のミドルウェア、Policy、`forbidden` の振る舞いがある場合だけです。

実装する前は、どのテストも `given()` の呼び出しか、まだマウントされていないルートで失敗します。skip されるテストはないので、`tests:fail` の条件どおりにステップを検証できます。アプリケーションが起動しない場合は、どのテストもルートに届いていないので、`plan:verify` はステップを `blocked` と記録します。コードを書く前に通ってしまうケースが 2 つあり、そのときは `tests:fail` でステップが失敗します。1 つは既存のルートに対する振る舞いで準備するものがない場合で、レポートに一覧で示します。もう 1 つは、新しいルートのパスに既存のルートがすでに応答してしまう振る舞いで、こちらは一覧に出ません。`given()` と `unwritten()` の呼び出しは、それぞれが示す前提やアサーションに置き換えてください。テストを `test.skip` や `test.todo` に変えないでください。skip したケースは実行したことにならず、ステップはそこで失敗します。後のステップも同じファイルを実行して通ることを求めるので、タイトルの id とリクエストは残してください。

次の場合は、何も書かずに拒否します。下書きや承認のない計画、`plan:next` が印を付けていないステップ、すでにあるファイル (再実行した場合)、ほかのテストファイルがすでに持っている振る舞い (`plan:verify` が 2 つのファイルで見つけてしまうため)、ほかの振る舞いの id を含むリクエストのボディや期待値、起動できる default export が `src/app.ts` にも `app.ts` にもないアプリケーションです。API 専用のアプリケーションには `scaffold` ステップはありませんが、`tests` ステップはほかと同じようにあり、雛形も書けます。制約付きのルートパラメーター (`:id{[0-9]+}`) は、静的な読み取りでは判断しきれません。実行時の値が制約を満たすとは限らないので、そのリクエストはルートに届くとは判断せず、不確かなものとして扱います。
