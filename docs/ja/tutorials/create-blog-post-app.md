# Part 1: ブログ投稿アプリを作る

このパートではブログの心臓部 — 投稿の作成・一覧・閲覧 — を作ります。テーブル、モデル、バリデーター、コントローラー、ルート、ページと、すべてのファイルを自分の手で書くので、リクエストが Guren アプリケーションの中をどう流れるかを正確に把握できます。

**このパートで学ぶこと:**

- SQLite で新規 Guren アプリを雛形生成する方法（設定ゼロ）
- 各パーツのつながり: スキーマ → モデル → バリデーター → コントローラー → ルート → Inertia ページ
- Zod と `validateBody` / `validateQuery` / `validateParams` でリクエストをバリデーションする方法
- Inertia の `useForm` でフォームを組み、バリデーションエラーを表示する方法
- `bun run codegen` が存在する理由と、再実行すべきタイミング

> [!TIP]
> このパートの内容はすべて、コマンド 1 つで生成できます: `bunx guren add resource posts --fields "title:string,body:text"`。あえて手作りするのは、そのジェネレーターが何を生成しているのかを理解するためです — このチュートリアルを終えれば、いつショートカットに頼るべきかを自分で判断できるようになります。

## 1. アプリを雛形生成する

新規プロジェクトを作成し、プロンプトに答えます。

```bash
bunx create-guren-app my-blog
```

CLI は 2 つの質問をします。

- **レンダリングモード** — デフォルト（**SSR**）のままにします。
- **データベースドライバー** — デフォルト（**SQLite**、"zero-config, recommended for getting started"）のままにします。

スキャフォールダーがテンプレートをコピーし、すぐ使える `.env`（生成済みの `APP_KEY` と `DATABASE_URL=./data/guren.db` 入り）を書き出し、依存関係のインストールまで済ませてくれます。続けて開発サーバーを起動します。

```bash
cd my-blog
bun run dev
```

**チェックポイント:** [http://localhost:3333](http://localhost:3333) を開きます。ウェルカムページ — "Welcome to My Blog!" という見出し、機能カードのグリッド、おすすめコマンドが載った "Next steps" ボックス — が表示されるはずです。データベースのセットアップもコンテナも不要: SQLite ファイルは必要になった時点で `./data/` 以下に作成されます。

このターミナルでは開発サーバーを動かしたままにして、以降のコマンドは別のターミナルで実行してください。

## 2. posts テーブルを定義する

雛形は SQLite を使うので、テーブルは `sqliteTable` と SQLite 用のカラムヘルパーで宣言します。スキーマに `posts` テーブルを追加しましょう。

`db/schema.ts` を編集し、既存の `users` テーブルの下に次のテーブルを追加します。

```ts
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

スキーマからマイグレーションを生成し、適用します。

```bash
bun run db:make create_posts_table
bun run db:migrate
```

`db:make` は `db/schema.ts` と既存のマイグレーションの差分を取り、新しい SQL ファイルを `db/migrations/` に書き出します。`db:migrate` はそれを SQLite データベースに適用します。

## 3. Post モデルを作る

モデルは、Drizzle のテーブルの上に Laravel スタイルの API（`find`、`create`、`paginate`、リレーションシップ）を提供します。

`app/Models/Post.ts` を作成します。

```ts
import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts) {
  static fillable = ['title', 'body']
}
```

注目してほしい点が 2 つあります。

- `PostRecord` はテーブルから型推論されます — レコード型を手書きすることはありません。
- `fillable` はマスアサインメントの許可リストです: 許可リスト外のフィールドを `Post.create()` や `Post.update()` に渡すと `MassAssignmentException` がスローされるため、バグやインジェクションの試みが黙って破棄されることなく即座に表面化します。信頼できるサーバーサイドのデータ（シーダーやシステムレコード）には、許可リストをバイパスする `forceCreate()` を使用できます。詳細は[データベースガイド](../guides/database.md)を参照してください。

## 4. バリデーターを追加する

Zod スキーマはリソースごとに 1 ファイルにまとめておくと、コントローラーとルートで共有できます。

`app/Http/Validators/PostValidator.ts` を作成します。

```ts
import { z } from 'zod'

export const PostPayloadSchema = z.object({
  title: z.string().trim().min(1, 'Title is required.'),
  body: z.string().trim().min(1, 'Body is required.'),
})

export type PostPayload = z.infer<typeof PostPayloadSchema>

export const PostIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
})

export const ListPostsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})
```

ルートパラメータやクエリ文字列は文字列として届くので、`z.coerce.number()` がバリデーション前に数値へ変換します。

## 5. コントローラーを作る

`app/Http/Controllers/PostController.ts` を作成します。

```ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post, type PostRecord } from '../../Models/Post.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostPayloadSchema,
} from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostRecord>

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })

    return this.inertia(pages.posts.Index, {
      data: result.data,
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const { id } = this.validateParams(PostIdParamSchema)
    const post = await Post.findOrFail(id)

    return this.inertia(pages.posts.Show, { post })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.Create, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)

    return this.redirect(post ? `/posts/${post.id}` : '/posts')
  }
}
```

各アクションの動きは次のとおりです。

- **`index`** は `validateQuery` で `?page=` をバリデーションし、投稿を 1 ページ分取得して、結果を `paginate` ヘルパーで包みます。このヘルパーが、React コンポーネントで描画するページリンクを組み立てます。
- **`show`** はルートパラメータ `:id` をバリデーションし、`findOrFail` を使います。投稿が存在しなければ自動的に 404 を返すので、手動の null チェックは不要です。
- **`create`** はフォームページを描画するだけです。
- **`store`** は `validateBody` でリクエストボディをバリデーションします。失敗するとフィールド単位のメッセージ付きで 422 を投げ、Inertia がそれを `form.errors` としてフォームに戻してくれます — このためのエラー処理コードを書く必要はありません。
- **`pages.posts.Index`** は `.guren/pages.gen.ts` 由来です。これはページ名と props の型を結びつける生成マニフェストで、ステップ 8 で codegen を実行するまではエディターがエラーを出しますが、それで正常です。

## 6. ルートを登録する

`routes/web.ts` を編集します。

```ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', [PostController, 'show']).name('posts.show')
    posts.post('/', { name: 'posts.store', body: PostPayloadSchema }, [PostController, 'store'])
  })
}
```

注目すべきポイント:

- すべてのルートに `.name()`（または `name` オプション）を付けています。これにより、ページ側で URL をハードコードする代わりに、型付きの `route()` ヘルパーでリンクできます。
- `body: PostPayloadSchema` オプションは Zod スキーマをルートコントラクトに紐づけます。これで codegen がフロントエンド向けに型付きのリクエストボディを生成できます。
- `/create` は `/:id` より **先に** 登録しています。ルートは上から順にマッチするため、`/:id` が先にあると `/posts/create` は `"create"` を id として解釈しようとしてしまいます。

## 7. ページを作る

Inertia ページは `resources/js/pages/` 以下に置く普通の React コンポーネントです。ディレクトリパスがそのままページ名になります: `resources/js/pages/posts/Index.tsx` は `pages.posts.Index` です。`interface Props` を宣言しておくと codegen が props の型を抽出し、`this.inertia()` がエンドツーエンドで型チェックされます。

`resources/js/pages/posts/Index.tsx` を作成します。

```tsx
import { Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostRecord } from '@/app/Models/Post'
import { route } from '@/.guren/routes.gen'

interface Props extends PaginatedPageProps<PostRecord> {}

export default function PostsIndex({ data: posts, pagination }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-semibold">Posts</h1>
        <Link href={route('posts.create')} className="rounded bg-black px-4 py-2 text-white">
          New post
        </Link>
      </div>

      {posts.length === 0 ? (
        <p className="text-zinc-500">No posts yet. Write the first one!</p>
      ) : (
        <div className="space-y-4">
          {posts.map((post) => (
            <article key={post.id} className="rounded border p-4">
              <Link
                href={route('posts.show', { id: post.id })}
                className="text-xl font-medium hover:underline"
              >
                {post.title}
              </Link>
              <p className="mt-1 text-sm text-zinc-500">
                {new Date(post.createdAt).toLocaleDateString()}
              </p>
            </article>
          ))}
        </div>
      )}

      {pagination.meta.lastPage > 1 && (
        <nav className="flex gap-2" aria-label="Pagination">
          {pagination.links.pages.map((page) => (
            <Link
              key={page.page}
              href={page.url ?? '#'}
              className={`rounded border px-3 py-1 ${page.active ? 'bg-black text-white' : ''}`}
            >
              {page.page}
            </Link>
          ))}
        </nav>
      )}
    </main>
  )
}
```

`import type { PostRecord }` の行はサーバーサイドのコードから型を取り込んでいますが、問題ありません — 型のみのインポートはビルド時に消去されるからです。

`resources/js/pages/posts/Show.tsx` を作成します。

```tsx
import { Link } from '@inertiajs/react'
import type { PostRecord } from '@/app/Models/Post'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostRecord
}

export default function PostsShow({ post }: Props) {
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')} className="text-sm text-zinc-500 hover:underline">
        &larr; Back to posts
      </Link>
      <h1 className="text-3xl font-semibold">{post.title}</h1>
      <p className="text-sm text-zinc-500">{new Date(post.createdAt).toLocaleDateString()}</p>
      <div className="space-y-4 leading-relaxed">
        {post.body.split('\n').map((paragraph, index) => (
          <p key={index}>{paragraph}</p>
        ))}
      </div>
    </main>
  )
}
```

`resources/js/pages/posts/Create.tsx` を作成します。

```tsx
import { Link, useForm } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

type PostFormData = {
  title: string
  body: string
}

export default function PostsCreate() {
  const form = useForm<PostFormData>({ title: '', body: '' })

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-12">
      <Link href={route('posts.index')} className="text-sm text-zinc-500 hover:underline">
        &larr; Back to posts
      </Link>
      <h1 className="text-3xl font-semibold">New post</h1>

      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          form.post(route('posts.store'))
        }}
      >
        <div>
          <label htmlFor="title" className="block text-sm font-medium">
            Title
          </label>
          <input
            id="title"
            value={form.data.title}
            onChange={(event) => form.setData('title', event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
          {form.errors.title && <p className="mt-1 text-sm text-red-600">{form.errors.title}</p>}
        </div>

        <div>
          <label htmlFor="body" className="block text-sm font-medium">
            Body
          </label>
          <textarea
            id="body"
            rows={8}
            value={form.data.body}
            onChange={(event) => form.setData('body', event.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
          {form.errors.body && <p className="mt-1 text-sm text-red-600">{form.errors.body}</p>}
        </div>

        <button
          type="submit"
          disabled={form.processing}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          Create post
        </button>
      </form>
    </main>
  )
}
```

`useForm` は送信ライフサイクル全体を面倒みてくれます: `form.post()` がデータを送信し、送信中は `form.processing` でボタンが無効化され、サーバーが 422 で拒否したときは `form.errors.title` / `form.errors.body` に Zod スキーマのメッセージが入ります。

## 8. codegen を実行する

```bash
bun run codegen
```

**なぜ必要か:** codegen はルートとページをスキャンして、型付きマニフェストを `.guren/` に書き出します — `pages.gen.ts`（ページ名と、各コンポーネントから抽出した `Props`。`this.inertia()` が使用）と `routes.gen.ts`（ルート名とパラメータの補完が効く `route()` ヘルパー）です。これがあるからこそ、`pages.posts.Idnex` のようなタイポや props の渡し忘れが、実行時の事故ではなく **コンパイル時** のエラーになります。

**再実行のタイミング:** ルートやページを追加・リネーム・削除したとき、またはページの `Props` を変更したときです。実際に手動で実行することはほとんどありません — `bun run dev` が起動時に codegen を実行し、開発サーバーが `routes/web.ts` と `resources/js/pages/` を監視して変更のたびに再生成するからです。エディターに古い型が表示されたときだけ、明示的にコマンドを実行してください。

## 9. チェックポイント: 最初の投稿を作る

開発サーバーが動いている状態で（止めていたら `bun run dev`）:

1. [http://localhost:3333/posts](http://localhost:3333/posts) を開くと、空の状態（"No posts yet"）が表示されます。
2. **New post** をクリックし、両方のフィールドを **空のまま** フォームを送信します — ページは遷移せず、入力欄の下に "Title is required." が表示されます。これはあなたの Zod スキーマの声です。422 レスポンスを経由して `form.errors` まで往復してきました。
3. タイトルと本文を入力して送信します — 新しい投稿のページにリダイレクトされます。
4. `/posts` に戻ります — 投稿が一覧に載っています。

これで完全なリクエストサイクルを 1 つ作り上げました: ルート → バリデーション → モデル → データベース → Inertia ページ、そのすべてが型チェック済みです。

## よくあるつまずき

**`Cannot find module '.guren/pages.gen'`、または `pages.posts.Index` が存在しない。**
ページを追加してから codegen が実行されていません。`bun run codegen` を実行してください（または `bun run dev` を再起動）。

**`/posts` を開くと `no such table: posts`。**
マイグレーションが生成されていないか、適用されていません。`bun run db:make create_posts_table` に続けて `bun run db:migrate` を実行してください。

**`bun run db:migrate` が "cannot connect to the database" で失敗する。**
スキャフォールド時に SQLite ではなく PostgreSQL / MySQL を選んでいます。先に `bun run db:up` でコンテナを起動してください。詳しくは[トラブルシューティング](../guides/troubleshoot.md)を参照してください。

**フォームを送信しても何も起きない。**
ほぼ間違いなく 422 が返っています。ページが `form.errors.title` と `form.errors.body` を描画しているか確認してください — メッセージは届いているのに、表示していないだけです。ネットワークタブ（`/posts` への `X-Inertia` POST）で確認できます。

**`/posts/create` が 404、または `id` に関するバリデーションエラーを返す。**
`/:id` ルートが `/create` より先に登録されています。`posts.get('/create', ...)` を `posts.get('/:id', ...)` より上に宣言してください。

**props を変更したあと `this.inertia(pages.posts.Index, ...)` で型エラー。**
ページマニフェストが古くなっています。`bun run codegen` を再実行して、抽出済みの `Props` をコントローラーの送信内容に合わせてください。

**雛形生成時に `Directory "my-blog" is not empty`。**
別の新しいディレクトリ名を選ぶか、`--force` を渡して強制的に生成してください。

## 次へ

今のままでは誰でも投稿を公開できてしまいます。[Part 2: 認証を追加する](./authentication.md) で直しましょう。
