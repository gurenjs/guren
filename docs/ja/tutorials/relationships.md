# Part 3: リレーションシップ: コメント

[Part 2](./authentication.md) を終えて、ブログには投稿と著者が揃いました。最終パートでは読者に声を持たせます: 投稿とユーザーの両方に属する `comments` テーブルを追加し、モデルのリレーションシップを配線して、投稿ページにコメントフォームを作ります。

Part 1 の `add resource` は CRUD 一式をまとめて生成しましたが、コメントのような「投稿にぶら下がる」機能には、独立したページ群は要りません。こういうときは **単機能の `make:*` ジェネレーターで骨組みを作り、ドメインの形は自分で書く** のが Guren 流です。仕上げには、完成したコードから仕様ビューを導出し、アーキテクチャ上の意思決定を記録して、Docs Graph で結び付けます。

**このパートで学ぶこと:**

- 2 つの親を参照するテーブル（`postId`、`authorId`）をモデリングする方法
- `make:model` / `make:validator` / `make:resource` / `make:controller` で骨組みを生成し、肉付けする流れ
- 型付きの結果が得られる `hasMany` / `belongsTo` リレーションシップの宣言方法
- `findWithOrFail` とクエリビルダーの `.with()` でリレーションを eager load する方法
- Inertia のフォームからネストしたリソース（`POST /posts/:id/comments`）に送信する方法
- 生成スペックとアーキテクチャ上の意思決定を、完成したコードへ Docs Graph で結び付ける方法

## 1. comments テーブルを定義する

データの形はジェネレーターに任せず、あなたがスキーマで宣言します — ここがすべての導出の起点です。`db/schema.ts` の `posts` の下にテーブルを追加します。

```ts
export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

`onDelete: 'cascade'` は、投稿を削除するとそのコメントも一緒に削除されることを意味します。今回は完全に新規のテーブルなので、普通のマイグレーションで十分です — リセットは要りません。

```bash
bun run db:make create_comments_table
bun run db:migrate
```

## 2. 骨組みを生成する

コメント機能に必要な 4 つのレイヤーを、単機能ジェネレーターで一気に用意します。

```bash
bunx guren make:model Comment
bunx guren make:validator Comment --fields "body:text"
bunx guren make:resource Comment
bunx guren make:controller Comment
```

それぞれ `app/Models/Comment.ts`、`app/Http/Validators/CommentValidator.ts`、`app/Http/Resources/CommentResource.ts`、`app/Http/Controllers/CommentController.ts` が正しい場所に、プロジェクトの規約どおりの形で作られます。ここから各ファイルに、コメント固有のドメイン知識を肉付けしていきます。

## 3. モデルを仕上げる: リレーションシップ

生成された `app/Models/Comment.ts` に、マスアサインメントの許可リストと 2 つの `belongsTo` を追加します。

```ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { comments } from '../../db/schema.js'
import type { PostRecord } from './Post.js'
import type { UserRecord } from './User.js'

export type CommentRecord = typeof comments.$inferSelect
export type CommentAuthor = Pick<UserRecord, 'id' | 'name'>

export class Comment extends defineModel(comments) {
  static fillable = ['postId', 'authorId', 'body']

  static override relationTypes: {
    post: BelongsToRecord<PostRecord>
    author: BelongsToRecord<CommentAuthor>
  } = {
    post: null,
    author: null,
  }
}

Comment.belongsTo('post', () => import('./Post.js').then((m) => m.Post), 'postId', 'id')
Comment.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

次に逆側を宣言します。`app/Models/Post.ts` を更新して、投稿が多数のコメントを持つようにします（変わるのは import 2 行、`relationTypes` の `comments`、末尾の `hasMany` の 3 箇所です）。

```ts
import { defineModel, type BelongsToRecord, type HasManyRecord } from '@guren/core'
import { posts } from '../../db/schema.js'
import type { CommentRecord } from './Comment.js'
import type { UserRecord } from './User.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert
export type PostAuthor = Pick<UserRecord, 'id' | 'name'>

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body', 'authorId']

  static override relationTypes: {
    author: BelongsToRecord<PostAuthor>
    comments: HasManyRecord<CommentRecord>
  } = {
    author: null,
    comments: [],
  }
}

Post.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
Post.hasMany('comments', () => import('./Comment.js').then((m) => m.Comment), 'postId', 'id')
```

`hasMany('comments', ..., 'postId', 'id')` は「`postId` がこの投稿の `id` に一致するコメントたち」と読めます。`relationTypes` を宣言しておくと、eager load 時の `post.comments` は `CommentRecord[]` と型付けされます。リレーションシップ API の全体像は[データベースガイド](../guides/database.md)を参照してください。

## 4. バリデーターとリソースを仕上げる

`make:validator` は 3 つのスキーマ（ペイロード・ID パラメータ・一覧クエリ）を生成しています。使うのは当面 `CommentPayloadSchema` だけです — 残りはコメントに専用ページを作る日まで出番を待ちます。メッセージだけ人間向けにしておきましょう（`app/Http/Validators/CommentValidator.ts`）。

```ts
export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1, 'Comment is required.'),
})
```

`make:resource` の生成した骨組みには「残りのカラムをここに写す」というコメントが入っています。`app/Http/Resources/CommentResource.ts` を、著者付きコメントの形に仕上げます。

```ts
import { Resource } from '@guren/core'
import type { CommentAuthor, CommentRecord } from '../../Models/Comment.js'

type CommentWithAuthor = CommentRecord & { author?: CommentAuthor | null }

export interface CommentResourceData extends Record<string, unknown> {
  id: number
  body: string
  createdAt: string
  author: { name: string } | null
}

export class CommentResource extends Resource<CommentWithAuthor, CommentResourceData> {
  toArray(): CommentResourceData {
    return {
      id: this.resource.id,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      author: this.resource.author ? { name: this.resource.author.name } : null,
    }
  }
}
```

Part 2 の `PostResource` と同じパターンです: 著者からは `name` だけを写し、`passwordHash` が決してブラウザに届かないようにします。

## 5. コントローラーを実装し、ルートを登録する

`make:controller` の生成したプレースホルダーを、コメント作成のアクションに置き換えます（`app/Http/Controllers/CommentController.ts`）。

```ts
import { Controller, type Sanitized } from '@guren/core'
import { Comment } from '../../Models/Comment.js'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPayloadSchema } from '../Validators/CommentValidator.js'
import { PostIdParamSchema } from '../Validators/PostValidator.js'

export default class CommentController extends Controller {
  async store(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)
    const data = await this.validateBody(CommentPayloadSchema)
    const user = await this.auth.userOrFail<Sanitized<UserRecord>>()

    await Comment.create({
      postId: post.id,
      authorId: user.id,
      body: data.body,
    })

    return this.redirect(`/posts/${post.id}`)
  }
}
```

ルートの `:id` は投稿の ID なので、`PostValidator` の `PostIdParamSchema` を再利用しています。`Post.findOrFail(id)` が存在しない投稿へのコメントを防ぎ、`userOrFail` が著者の存在を保証します。

ルートは `routes/web.ts` の認証グループの中に追加します（Part 2 で作った `authed` グループです — `body` スキーマ付きのルートはここに置くのでした）。

```ts
import CommentController from '../app/Http/Controllers/CommentController.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'

    // inside posts.middleware('auth').group((authed) => { ... }):
      authed.post('/:id/comments', { name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
```

## 6. コントローラーでコメントを読み込む

`app/Http/Controllers/PostController.ts` の `show` を更新します。

```ts
import { Comment } from '../../Models/Comment.js'
import { CommentResource } from '../Resources/CommentResource.js'

// inside PostController:

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')
    const comments = await Comment.where('postId', id)
      .with('author')
      .orderBy('createdAt', 'desc')
      .get()

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
      comments: comments.map((comment) => new CommentResource(comment).toJSON()),
    })
  }
```

`Comment.where(...)` はクエリビルダーを返すので、`.with('author')`（各コメントの著者を、コメントごとに 1 クエリ発行するのではなく、まとめて 1 回で eager load します）と並び替えをチェーンできます。ページに渡す直前で、各コメントを `CommentResource` に通しています。なお、`Show.tsx` の `Props` はまだ `comments` を受け取らないので、次のステップまでエディターが型エラーを出します — それで正常です。

## 7. ページにコメントセクションを追加する

`resources/js/pages/posts/Show.tsx` を、コメント一覧とサインイン済みユーザー向けフォームを備えたバージョンに置き換えます。

```tsx
import { Link, useForm, usePage } from '@inertiajs/react'
import type { CommentResourceData } from '@/app/Http/Resources/CommentResource'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
  comments: CommentResourceData[]
}

export default function PostShow({ post, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const isAuthenticated = Boolean(props.auth?.user)
  const form = useForm({ body: '' })

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')}>Back</Link>
      <h1 className="text-3xl font-semibold">{post.title}</h1>
      <p className="text-sm text-zinc-500">by {post.author?.name ?? 'Unknown author'}</p>
      <p>{post.body}</p>
      <div className="flex gap-4">
        <Link href={route('posts.edit', { id: post.id })}>Edit</Link>
        <Link
          href={route('posts.destroy', { id: post.id })}
          method="delete"
          as="button"
          onBefore={() => window.confirm('Delete this post?')}
          className="text-red-600"
        >
          Delete
        </Link>
      </div>

      <section className="border-t pt-6">
        <h2 className="text-xl font-semibold">
          Comments{comments.length > 0 && ` (${comments.length})`}
        </h2>

        {comments.length === 0 ? (
          <p className="mt-4 text-zinc-500">No comments yet.</p>
        ) : (
          <ul className="mt-4 space-y-4">
            {comments.map((comment) => (
              <li key={comment.id} className="rounded border p-4">
                <p>{comment.body}</p>
                <p className="mt-2 text-sm text-zinc-500">
                  {comment.author?.name ?? 'Unknown'} ·{' '}
                  {new Date(comment.createdAt).toLocaleDateString()}
                </p>
              </li>
            ))}
          </ul>
        )}

        {isAuthenticated ? (
          <form
            className="mt-6 space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              form.post(route('comments.store', { id: post.id }), {
                onSuccess: () => form.reset(),
              })
            }}
          >
            <label htmlFor="comment" className="block text-sm font-medium">
              Add a comment
            </label>
            <textarea
              id="comment"
              rows={3}
              value={form.data.body}
              onChange={(event) => form.setData('body', event.target.value)}
              className="w-full rounded border px-3 py-2"
            />
            {form.errors.body && <p className="text-sm text-red-600">{form.errors.body}</p>}
            <button
              type="submit"
              disabled={form.processing}
              className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
            >
              Post comment
            </button>
          </form>
        ) : (
          <p className="mt-6 text-sm text-zinc-500">
            <Link href={route('login')} className="underline">
              Sign in
            </Link>{' '}
            to leave a comment.
          </p>
        )}
      </section>
    </main>
  )
}
```

ポイント:

- `usePage().props.auth?.user` は、Part 2 で見た `AuthProvider` の `boot()` が共有している auth props を読み取ります — ページはこれを見て、フォームとサインインの案内のどちらを表示するか決めています。
- 成功するとリダイレクトによってページが最新のコメント付きで再描画され、`form.reset()` がテキストエリアをクリアします。

いつものループで締めます: `bun run codegen`（`bun run dev` 中なら自動）で `comments.store` ルートと新しい `Props` をマニフェストに反映し、`bunx guren check` で配線を検証します（`CommentController` のテスト未作成警告が増えているはずです — `check` はちゃんと見ています）。

## 8. チェックポイント: コメントを残す

1. サインアウトした状態で投稿を開きます — コメント一覧と "Sign in to leave a comment" の案内が表示されます。
2. サインインして（**demo@example.com** / **secret**）投稿を開き、空のコメントを送信します — "Comment is required." が表示されます。
3. 本物のコメントを書きます — ページが再読み込みされ、あなたのコメントが "Demo User" 名義で一番上に表示されます。

これでミニブログの完成です: 公開の閲覧、認証付きの書き込み、そして 3 つのテーブルにまたがる関連データが揃いました。

## 9. 作ったものを Docs Graph で結び付ける

動いているアプリは、コメントのフローが **何をするか** を証明しています。次は構造を要約するビューを生成し、コメントの著者をこの方法で扱う **理由** を記録します。

まず、スペックビューを最新化します。`comments` テーブルとリレーションシップが増えたので、Part 2 と同じく `bunx guren check --spec` がビューの古さを指摘するはずです — 再生成して追随させます。

```bash
bunx guren spec:generate
```

更新された `docs/spec/er.md` には 3 つのテーブルと外部キーが、`domain.md` にはここで宣言したモデルのリレーションシップが表示されます。

続いて、`Comment` エンティティに結び付くアーキテクチャ上の意思決定を作ります。

```bash
bunx guren make:adr "Comments require authenticated authors" --entity Comment
```

コマンドが表示したパス（新規アプリでは `docs/adr/0002-` で始まります）を開き、3 つのプレースホルダーを次の内容に置き換えてください。

```md
## Context

コメントは誰でも読めますが、匿名での書き込みを許すと、モデレーションと帰属に使える信頼できる本人情報が残りません。

## Decision

コメントの作成には認証済みセッションを必須とします。コントローラーは認証済みユーザーの ID を `authorId` として保存し、ブラウザーには著者を選ばせません。

## Consequences

すべてのコメントに責任を持つ著者が付きます。サインアウト中の読者もコメントを閲覧できますが、投稿するにはサインインが必要です。
```

プロジェクト知識を信頼する前に、宣言と生成物の両方を検証します。

```bash
bunx guren check --docs
bunx guren check --spec
```

`check --docs` は、ADR が実在する `Comment` モデルと関連コードパスを指しているかを検証します。`check --spec` は、コミットされた生成ビューが現在のコードと一致するかを検証します。

ターミナルから `Comment` の近傍を照会してみましょう。2 つの視点があります。

```bash
bunx guren docs:graph --entity Comment
bunx guren context Comment
```

`docs:graph` はドキュメント側から見た近傍（この ADR が `Comment` を統べる、という関係）を、`context Comment` はコード側から見たエンティティの全体像 — モデルのカラムとリレーション、ルート、コントローラー、リソース、そしてリンクされた ADR — を 1 画面にまとめます。あなた（や AI エージェント）が半年後にこの機能へ戻ってきたとき、最初に打つコマンドです。

最後に、Part 1 から見てきた [http://localhost:3333/_guren/docs](http://localhost:3333/_guren/docs) をもう一度開きます。これまではコードから導出されたビューと雛形付属の ADR だけでしたが、今度はあなたが **宣言した** 知識 — 新しい ADR と、それが統べる `Comment` エンティティ — がグラフに加わっています。エッジを辿って関連コントローラーを確認し、更新された ER ビューとドメインビューも開いてください。CLI と同じ検証済みの関係を、視覚的な画面から読んでいます。

文書形式、trust metadata、ドリフト検証、エージェント向けワークフローの詳細は [スペックアンカード開発](../guides/spec-anchored.md) を参照してください。

## よくあるつまずき

**コメントの著者が "Unknown" と表示される。**
`PostController.show` の `.with('author')` 呼び出しが抜けているか、`Comment.belongsTo('author', ...)` が登録されていません（クラス定義の後、モジュール読み込み時に実行される必要があります）。

**サインインしているのに、コメントを送信すると `/login` にリダイレクトされる。**
セッションがリセットされています（インメモリのセッションドライバーで、開発サーバーを再起動したか、バックエンドの編集でホットリロードが走った場合）— もう一度サインインしてください。それでも続く場合は、ルートが `authed` グループの中にあり、エイリアス名にタイポがないか確認してください。

**`no such table: comments`。**
マイグレーションが適用されていません。`bun run db:make create_comments_table` に続けて `bun run db:migrate` を実行してください。

**コメント作成時に `FOREIGN KEY constraint failed`。**
`postId` または `authorId` が存在しません — 多くの場合、不完全なリセット後に残った古い開発データが原因です。`bun run db:reset --seed` を実行して、投稿を作り直してください。

**`route('comments.store', ...)` が型エラーになる。**
ルートマニフェストが新しいルートより古い状態です。`bun run codegen` を実行してください。

## この先へ

これで Guren アプリのすべてのレイヤーに触れました。それぞれをさらに深めましょう。

- [ルーティング](../guides/routing.md) — ルートグループ、モデルバインディング、名前付きルート、ミドルウェア
- [コントローラー](../guides/controllers.md) — レスポンス、バリデーションヘルパー、依存解決
- [データベースと ORM](../guides/database.md) — スコープ、リレーション件数、トランザクション、ポリモーフィックリレーション
- [認可](../guides/authorization.md) — 「著者だけが編集できる」を実現するポリシーとゲート
- [テスト](../guides/testing.md) — `guren check` が指摘し続けているテストの穴を、コントローラーテストと HTTP テストで塞ぐ
- [CLI リファレンス](../guides/cli.md) — このシリーズで使った `add` / `make:*` / `check` / `audit` コマンドの全体像
