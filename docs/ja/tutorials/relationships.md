# Part 3: リレーションシップ: コメント

[Part 2](./authentication.md) を終えて、ブログには投稿と著者が揃いました。最終パートでは読者に声を持たせます: 投稿とユーザーの両方に属する `comments` テーブルを追加し、モデルのリレーションシップを配線して、投稿ページにコメントフォームを作ります。

**このパートで学ぶこと:**

- 2 つの親を参照するテーブル（`postId`、`authorId`）をモデリングする方法
- 型付きの結果が得られる `hasMany` / `belongsTo` リレーションシップの宣言方法
- `findWithOrFail` とクエリビルダーの `.with()` でリレーションを eager load する方法
- Inertia のフォームからネストしたリソース（`POST /posts/:id/comments`）に送信する方法

## 1. comments テーブルを定義する

`db/schema.ts` の `posts` の下にテーブルを追加します。

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

## 2. Comment モデルを作る

`app/Models/Comment.ts` を作成します。

```ts
import { defineModel, type BelongsToRecord } from '@guren/core'
import { comments } from '../../db/schema.js'
import type { PostRecord } from './Post.js'
import type { UserRecord } from './User.js'

export type CommentRecord = typeof comments.$inferSelect

export class Comment extends defineModel(comments) {
  static fillable = ['postId', 'authorId', 'body']

  static override relationTypes: {
    post: BelongsToRecord<PostRecord>
    author: BelongsToRecord<Pick<UserRecord, 'id' | 'name'>>
  } = {
    post: null,
    author: null,
  }
}

Comment.belongsTo('post', () => import('./Post.js').then((m) => m.Post), 'postId', 'id')
Comment.belongsTo('author', () => import('./User.js').then((m) => m.User), 'authorId', 'id')
```

次に逆側を宣言します。`app/Models/Post.ts` を更新して、投稿が多数のコメントを持つようにします。

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

`hasMany('comments', ..., 'postId', 'id')` は「`postId` がこの投稿の `id` に一致するコメントたち」と読めます。`relationTypes` を宣言しておくと、eager load 時の `post.comments` は `CommentRecord[]` と型付けされます。

## 3. コントローラーでコメントを読み込む

`app/Http/Controllers/PostController.ts` の `show` を更新し、バリデーターのインポートを追加します。

```ts
import { Comment } from '../../Models/Comment.js'

// inside PostController:

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findWithOrFail(id, 'author')
    const comments = await Comment.where('postId', id)
      .with('author')
      .orderBy('createdAt', 'desc')
      .get()

    return this.inertia(pages.posts.Show, {
      post: {
        id: post.id,
        title: post.title,
        body: post.body,
        createdAt: post.createdAt,
        author: post.author ? { id: post.author.id, name: post.author.name } : null,
      },
      comments: comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        author: comment.author ? { name: comment.author.name } : null,
      })),
    })
  }
```

`Comment.where(...)` はクエリビルダーを返すので、`.with('author')`（各コメントの著者を、コメントごとに 1 クエリ発行するのではなく、まとめて 1 回で eager load します）と並び替えをチェーンできます。Part 2 と同様、レコードを明示的なペイロードにマッピングして、`passwordHash` が決してブラウザに届かないようにします。

## 4. 新しいコメントを受け付ける

`app/Http/Validators/CommentValidator.ts` を作成します。

```ts
import { z } from 'zod'

export const CommentPayloadSchema = z.object({
  body: z.string().trim().min(1, 'Comment is required.'),
})

export const CommentPostParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})
```

`app/Http/Controllers/CommentController.ts` を作成します。

```ts
import { Controller } from '@guren/core'
import { Comment } from '../../Models/Comment.js'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { CommentPayloadSchema, CommentPostParamSchema } from '../Validators/CommentValidator.js'

export default class CommentController extends Controller {
  async store(): Promise<Response> {
    const { id } = this.validateParams(CommentPostParamSchema)
    const post = await Post.findOrFail(id)
    const data = await this.validateBody(CommentPayloadSchema)
    const user = await this.auth.userOrFail<UserRecord>()

    await Comment.create({
      postId: post.id,
      authorId: user.id,
      body: data.body,
    })

    return this.redirect(`/posts/${post.id}`)
  }
}
```

`Post.findOrFail(id)` が存在しない投稿へのコメントを防ぎ、`userOrFail` が著者の存在を保証します。

`routes/web.ts` の既存の `/posts` グループ内にルートを登録します。

```ts
import CommentController from '../app/Http/Controllers/CommentController.js'
import { CommentPayloadSchema } from '../app/Http/Validators/CommentValidator.js'

  // inside router.group('/posts', (posts) => { ... }):
    posts.middleware('auth').post('/:id/comments', { name: 'comments.store', body: CommentPayloadSchema }, [CommentController, 'store'])
```

## 5. ページにコメントセクションを追加する

`resources/js/pages/posts/Show.tsx` を、コメント一覧とサインイン済みユーザー向けフォームを備えたバージョンに置き換えます。

```tsx
import { Link, useForm, usePage } from '@inertiajs/react'
import { route } from '../../../../.guren/routes.gen'

interface CommentData {
  id: number
  body: string
  createdAt: string
  author: { name: string } | null
}

interface Props {
  post: {
    id: number
    title: string
    body: string
    createdAt: string
    author: { id: number; name: string } | null
  }
  comments: CommentData[]
}

export default function PostsShow({ post, comments }: Props) {
  const { props } = usePage<{ auth?: { user?: { name?: string } | null } }>()
  const isAuthenticated = Boolean(props.auth?.user)
  const form = useForm({ body: '' })

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')} className="text-sm text-zinc-500 hover:underline">
        &larr; Back to posts
      </Link>
      <h1 className="text-3xl font-semibold">{post.title}</h1>
      <p className="text-sm text-zinc-500">
        {new Date(post.createdAt).toLocaleDateString()} · {post.author?.name ?? 'Unknown author'}
      </p>
      <div className="space-y-4 leading-relaxed">
        {post.body.split('\n').map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
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

- `usePage().props.auth?.user` は、Part 2 の認証雛形がすべてのページに公開する共有 auth props を読み取ります — ページはこれを見て、フォームとサインインの案内のどちらを表示するか決めています。
- 成功するとリダイレクトによってページが最新のコメント付きで再描画され、`form.reset()` がテキストエリアをクリアします。

`Props` が変わり、ルートも追加されたので、マニフェストを更新します: `bun run codegen`（`bun run dev` 中なら自動）。

## 6. チェックポイント: コメントを残す

1. サインアウトした状態で投稿を開きます — コメント一覧と "Sign in to leave a comment" の案内が表示されます。
2. サインインして（**demo@example.com** / **secret**）投稿を開き、空のコメントを送信します — "Comment is required." が表示されます。
3. 本物のコメントを書きます — ページが再読み込みされ、あなたのコメントが "Demo User" 名義で一番上に表示されます。

これでミニブログの完成です: 公開の閲覧、認証付きの書き込み、そして 3 つのテーブルにまたがる関連データが揃いました。

## よくあるつまずき

**コメントの著者が "Unknown" と表示される。**
`PostController.show` の `.with('author')` 呼び出しが抜けているか、`Comment.belongsTo('author', ...)` が登録されていません（クラス定義の後、モジュール読み込み時に実行される必要があります）。

**サインインしているのに、コメントを送信すると `/login` にリダイレクトされる。**
セッションがリセットされています（インメモリのセッションドライバーで開発サーバーを再起動した場合）— もう一度サインインしてください。それでも続く場合は、ルートに `.middleware('auth')` が付いていて、エイリアス名にタイポがないか確認してください。

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
- [テスト](../guides/testing.md) — 作ったものすべてをコントローラーテストと HTTP テストで固める
