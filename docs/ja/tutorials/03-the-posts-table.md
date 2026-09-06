# 第 3 章: posts テーブル

ブログには投稿が要り、投稿には置き場所が要ります。この章では最初のテーブルを定義し、そのマイグレーションを生成して適用し、テーブルを読むモデルを書き、投稿を表示する 2 つのページを作ります。その後、作成フォームをテストで仕様化してエージェントに委ね、`scaffold` スキルがエージェントを手打ちではなくジェネレーターへ向かわせる様子を見ます。

**この章で学ぶこと:**

- テーブルは `db/schema.ts` に一度だけ宣言され、マイグレーションもモデルの型もそこから導出されること
- `bun run db:make` と `bun run db:migrate` が何をするか、テスト用データベースはどこから来るか
- モデルがテーブルの上に足すもの: `create`、`all`、`findOrFail`、そして `fillable` によるマスアサインメント保護
- ルートモデルバインディング: ルートの `bind: { id: Post }`、コントローラーの `this.model(Post)`、そして自分では書かない 404
- 本物のデータベースに対してコントローラーをテストし、テストごとにリセットする方法

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. テーブル

投稿の形に関するすべては `db/schema.ts` に一度だけ書きます。雛形にはすでに `users` テーブルがあります(第 5 章で使います)。その下に `posts` を足します。

```ts file=db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

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

4 つの列があります。自動採番の id、タイトル、本文、そして自分で埋まる作成時刻です。`notNull()` はヒントではなくデータベースの制約です。アプリケーションコードが何をしようと、タイトルの無い行は SQLite が拒否します。

スキーマは TypeScript ですが、データベースは TypeScript を読みません。読むのは SQL で、その SQL は生成します。

```bash run
bun run db:make create_posts_table
```

`db:make` は `db/schema.ts` を `db/migrations/` にある既存のマイグレーションすべてと突き合わせ、差を埋める SQL を書き出します。これは最初のマイグレーションなので、両方のテーブルを作ります。`db/migrations/` 配下にできた新しいフォルダを開いてみてください。読める `migration.sql` があり、手で編集することは決してありません。適用します。

```bash run
bun run db:migrate
```

これは開発用データベース `./data/guren.db` に対して実行されました。テストは別のファイル `./data/guren.test.db` を使い、Guren は最初に開いたデータベースに未適用のマイグレーションを適用するので、テストスイートに独自のマイグレーション手順は要りません。

## 2. モデル

テーブルは行を記述します。モデルは、アプリの残りの部分が行について語る手段です。`app/Models/Post.ts` を作ります。

```ts file=app/Models/Post.ts
import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts, { fillable: ['title', 'body'] }) {
}
```

これがモデルのすべてで、意図的に薄くしています。`defineModel(posts)` はクラスに `find`、`findOrFail`、`all`、`create`、`update`、`delete`、`paginate` とクエリビルダーを与え、すべてテーブルから型付けされます。`PostRecord` は上の 4 列そのもので、この型を手で書くことはありません。

`fillable` は、便利さではなく安全のための 1 行です。`Post.create(data)` はここに挙げたキーだけを書き込みます。`data` に紛れ込んだ `id` や `createdAt` は捨てられます。第 4 章ではバリデーション済みのリクエストボディを `create` に渡しますが、フォームが差し出していないフィールドをクライアントが設定できないようにしているのがこれです。`guren audit` もここを検査します。

## 3. 仕様

ページは 2 つ。`/posts` の一覧と `/posts/:id` の個別表示です。存在する前に、何をするかを書きます。

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'

describe('PostController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('lists posts, newest first', async () => {
    await Post.create({ title: 'First post', body: 'Hello' })
    await Post.create({ title: 'Second post', body: 'Again' })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })
})
```

このテストには新しいものが 2 つあります。`resetDatabase()` が各テストの前に走り、テスト用データベースの全テーブルを落としてマイグレーションを適用し直すので、各テストは何も無い状態から始まり、必要な行だけを作れます。そしてテストはモデル経由、つまり `Post.create(...)` で行を作ります。アプリがやるのと同じやり方です。

```bash run expect-fail
bun test
```

新しい失敗が 3 つ、すべて 404 です。では、テストが記述したものを作りましょう。

## 4. コントローラーとルート

`app/Http/Controllers/PostController.ts` を作ります。

```ts file=app/Http/Controllers/PostController.ts
import { Controller } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const posts = await Post.orderBy(['id', 'desc'])

    return this.inertia(pages.posts.Index, {
      posts: posts.map((post) => ({ id: post.id, title: post.title, body: post.body })),
    })
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: { id: post.id, title: post.title, body: post.body, createdAt: post.createdAt },
    })
  }
}
```

`index` はすべての投稿を新しい順に読み、各行をページが必要とする 3 つのフィールドに写します。この写しは無駄な作業ではありません。ページはあなたが送ると決めたものだけを受け取り、それ以外は受け取りません。第 4 章でこの写しにきちんとした置き場所を与えます。

`show` には検索がありません。検索はルートがします。`routes/web.ts` を置き換えます。

```ts file=routes/web.ts
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

- `router.group('/posts', ...)` は中のすべてのルートにプレフィックスを付けるので、`'/:id'` は `/posts/:id` です。
- `bind: { id: Post }` が**ルートモデルバインディング**です。アクションが走る前に Guren がパスパラメータで `Post.findOrFail(id)` を呼び、レコードをコントローラーに渡します。コントローラーでは `this.model(Post)` がそれを `PostRecord` 型で返します。該当する投稿が無ければ `findOrFail` が throw し、レスポンスは 404 になります。それが 3 つ目のテストで、あなたはそのためのコードを 1 行も書いていません。
- ルートにオプションがあるときは options オブジェクトが第 2 引数です。`.name()` はどちらの書き方でも使えます。

## 5. ページ

コンポーネントは 2 つ。一覧です。

```tsx file=resources/js/pages/posts/Index.tsx
import { Head, Link } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

interface PostSummary {
  id: number
  title: string
  body: string
}

interface Props {
  posts: PostSummary[]
}

export default function PostsIndex({ posts }: Props) {
  return (
    <>
      <Head title="Posts" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
            <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
            Posts
          </h1>
          {posts.length === 0 && <p className="text-g-text-2">No posts yet.</p>}
          <div className="space-y-4">
            {posts.map((post) => (
              <article key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card">
                <Link href={route('posts.show', { id: post.id })} className="text-xl font-bold text-g-heading transition hover:text-g-accent-text">
                  {post.title}
                </Link>
                <p className="mt-2 text-sm text-g-text-2">{post.body}</p>
              </article>
            ))}
          </div>
        </div>
      </main>
    </>
  )
}
```

`route('posts.show', { id: post.id })` は `.guren/routes.gen.ts` の型付きルートヘルパーです。すべてのルート名と、それぞれが取るパラメータを知っています。`route('posts.shwo', ...)` や `id` の欠落はコンパイルエラーです。`PostSummary` インターフェースはページ内のローカルな型で、codegen は `Props` と一緒にこれも拾います。

そして個別ページです。

```tsx file=resources/js/pages/posts/Show.tsx
import { Head, Link } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: {
    id: number
    title: string
    body: string
    createdAt: string
  }
}

export default function PostShow({ post }: Props) {
  return (
    <>
      <Head title={post.title} />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <Link href={route('posts.index')} className="text-sm text-g-accent-text transition hover:underline">
            All posts
          </Link>
          <h1 className="text-3xl font-bold text-g-heading">{post.title}</h1>
          <p className="font-mono text-xs text-g-text-2">{post.createdAt}</p>
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
        </div>
      </main>
    </>
  )
}
```

マニフェストを再生成してから、仕様を走らせます。

```bash run
bun run codegen
```

```bash run
bun test
```

緑です。**チェックポイント:** [http://localhost:3333/posts](http://localhost:3333/posts) を開きます。「No posts yet.」ブラウザから投稿を書く手段はまだありません。それが次のスライスです。ここまでをゲートに通してコミットします。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the posts table, model, and read pages"
```

## 6. 作成フォームを仕様化する

テストをさらに 2 つ。フォームが表示されること、送信すると投稿が作られてそこへリダイレクトされることです。テストファイルを置き換えます。

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'

describe('PostController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('lists posts, newest first', async () => {
    await Post.create({ title: 'First post', body: 'Hello' })
    await Post.create({ title: 'Second post', body: 'Again' })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('serves the form for a new post', async () => {
    await http.get('/posts/create').assertOk()
  })

  it('stores a post and redirects to it', async () => {
    await http.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
  })
})
```

```bash run expect-fail
bun test
```

赤が 2 つ、緑が 3 つ。2 つ目の新しいテストが引き起こそうとしている順序の問題に注意してください。`/posts/create` は `/posts/:id` より*前に*登録しなければなりません。さもないとルーターは `create` という id の投稿を探しに行き、404 を返します。

## 7. 委ねる

エージェントに頼みます。

> Add the create form for posts. `GET /posts/create`, named `posts.create`, renders `resources/js/pages/posts/New.tsx` with a title input and a body textarea that submit to `POST /posts`, named `posts.store`. The `store` action validates `title` and `body` as non-empty strings with zod, creates the post, and redirects to its page. Register `/posts/create` before `/posts/:id`. `tests/PostController.test.ts` describes the behaviour; make it pass.

この章のハーネス要素は `.claude/skills/scaffold/` の **`scaffold` スキル**です。どの `bunx guren make:*` ジェネレーターが存在し、記憶からファイルを打ち込む代わりにいつそれらに手を伸ばすべきかをエージェントに教えます。ページの骨組みには `make:view posts/New`、Zod スキーマファイルには `make:validator Post` です。あなたのエージェントがどれかを使うか見ていてください。ここではどちらの結果でも構いませんが、ジェネレーターの出力は検証済みのフレームワークの慣用句であり、それに手を伸ばすエージェントは間違える余地が小さくなります。

**手元にエージェントが無い場合は、** 3 ファイルです。コントローラーはアクションを 2 つ得ます。

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller } from '@guren/core'
import { z } from 'zod'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'

const PostPayloadSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
})

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const posts = await Post.orderBy(['id', 'desc'])

    return this.inertia(pages.posts.Index, {
      posts: posts.map((post) => ({ id: post.id, title: post.title, body: post.body })),
    })
  }

  async show(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: { id: post.id, title: post.title, body: post.body, createdAt: post.createdAt },
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.create(data)
    return this.redirect(`/posts/${post.id}`)
  }
}
```

```ts file=routes/web.ts fallback
import { Router } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import { Post } from '../app/Models/Post.js'

export function registerWebRoutes(router: Router): void {
  router.get('/', [HomeController, 'index'])
  router.get('/about', [AboutController, 'index']).name('about')
  router.get('/contact', [ContactController, 'index']).name('contact')

  router.group('/posts', (posts) => {
    posts.get('/', [PostController, 'index']).name('posts.index')
    posts.get('/create', [PostController, 'create']).name('posts.create')
    posts.get('/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
    posts.post('/', [PostController, 'store']).name('posts.store')
  })

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```tsx file=resources/js/pages/posts/New.tsx fallback
import { Head, useForm } from '@inertiajs/react'
import { route } from '@/.guren/routes.gen'

interface PostForm {
  title: string
  body: string
}

export default function NewPost() {
  const form = useForm<PostForm>({ title: '', body: '' })

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
            <input
              value={form.data.title}
              onChange={(event) => form.setData('title', event.target.value)}
              placeholder="Title"
              className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            <textarea
              value={form.data.body}
              onChange={(event) => form.setData('body', event.target.value)}
              placeholder="Body"
              rows={8}
              className="w-full rounded-g-ctl border border-g-line-strong bg-g-panel px-3 py-2 text-g-text transition outline-none placeholder:text-g-muted focus:border-transparent focus:outline-2 focus:-outline-offset-1 focus:outline-g-accent"
            />
            <button type="submit" className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              Publish
            </button>
          </form>
        </div>
      </main>
    </>
  )
}
```

このページは Inertia の `useForm` を使います。フィールドの値を保持し、`form.post()` が送信してリダイレクトに追従します。サーバーが送信を拒否すると、メッセージは `form.errors` に入ります。ページはまだそれを表示していません。第 4 章はまさにそのための章です。

再生成して仕様を走らせます。

```bash run
bun run codegen
```

```bash run
bun test
```

rubric は次のとおりです。

- `routes/web.ts` は `/create` を `/:id` より前に登録し、`POST /posts` は `posts.store` と名付けられている。
- `store` はスキーマ付きで `this.validateBody()` を呼び、それ以外の方法でリクエストボディを読んでいない。`guren audit` はバリデーション無しのボディ読み取りでゲートを落とすので、これはスタイルの話ではない。
- `store` はバリデーション済みのデータだけを `Post.create()` に渡し、レンダリングではなくリダイレクトしている。
- ページは `useForm` と `route('posts.store')` で送信し、URL をハードコードしていない。
- 5 件のテストがすべて緑。

**チェックポイント:** [http://localhost:3333/posts/create](http://localhost:3333/posts/create) で投稿を書きます。その投稿のページに着き、一覧では先頭に表示されます。

```bash run
bunx guren gate
```

ゲートは緑ですが、`gate` が報告するのは失敗だけです。先に進む前に、audit を単体で実行してください。

```bash run
bunx guren audit
```

`POST /posts` に認証チェックが無い、つまり誰でも投稿を作れる、という警告が出ます。この警告は audit もゲートも落としませんし、正しい指摘です。そのままにしておきましょう。第 6 章はまさにそのための章で、それまでこのブログには認証すべきユーザーがいません。

```bash run
git add -A
git commit -m "feat: add the new post form"
```

## ジェネレーターならこうしていた

この章と次の章のすべては、`bunx guren add resource` がコマンド 1 つで書くものです。スキーマ、マイグレーション、モデル、バリデーター、リソース、7 アクションのコントローラー、ルート、4 つのページ。手で作ったのは、その出力を読めるようになるためです。第 5 章からはそうやって使います。今すぐ比較を見たければ、使い捨てのブランチで。

```bash manual
git switch -c scratch/add-resource
bunx guren add resource Post --fields "title:string,body:text" --force
git diff main --stat
git switch main
git branch -D scratch/add-resource
```

生成されたコントローラーがあなたのものと違う点は 2 つあり、どちらも注目に値します。`:id` パラメータをモデルにバインドせずスキーマで検証していること、そして `index` がページネーションしていることです。どちらも第 4 章です。

## いまいる場所

- `posts` テーブル、そのマイグレーション、`fillable` 付きのモデル。
- 本物の行を読む一覧ページと個別ページ、そしてルーターが提供する 404。
- 本物のデータベースに対して走り、ケースごとにリセットするテスト。
- あなたが仕様化し、エージェント(または 3 つのファイル)が作った、データベースの前にバリデーションを置いた作成フォーム。
- 意味を理解した上で、意図的に残している `audit` の警告 1 件。

## よくあるつまずき

- **`db:make` が「No schema changes」と言う。** 最後のマイグレーション以降スキーマファイルが変わっていないか、別のファイルを編集しています。`db/schema.ts` から `posts` が export されているか確認してください。
- **テストが「no such table: posts」で失敗する。** テスト用データベースは初回利用時に作られ、そのときにマイグレーションされます。前回の実行が中途半端にマイグレーションされた `data/guren.test.db` を残していたら、ファイルを削除してテストをやり直してください。
- **`/posts/create` が 404 を返す。** `/posts/:id` より後に登録されています。順序が大事です。ルートは上から順に照合されます。
- **`guren audit` が「Request body is read without validation」で失敗する。** store アクションが `validateBody()` 以外の方法でボディを読んでいます。スキーマを使ってください。
- **`this.model(Post)` が「No model binding found」で throw する。** そのパラメータに対する `bind` オプションがルートにありません。バインディングはルートに宣言するもので、コントローラーから推測されるものではありません。

## 次へ

[第 4 章: バリデーションとリソース](./04-validation-and-resources.md) では、スキーマをルート契約付きのバリデーターファイルへ移し、フォームにバリデーションエラーを表示し、リソース層を導入して、編集・削除・ページネーションをエージェントに委ねます。
