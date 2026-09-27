# 第 3 章: posts テーブル

ブログには投稿が必要で、投稿にはそれを保存する場所が必要です。この章では最初のテーブルを定義し、マイグレーションを生成して適用したうえで、テーブルを読むモデルと、投稿を表示する 2 つのページを作ります。そのあと作成フォームのテストを先に書いてエージェントに任せ、`scaffold` スキルのおかげでエージェントがファイルを手で書かずにジェネレーターを使う流れを確認します。

**この章で学ぶこと:**

- テーブルは `db/schema.ts` で一度だけ宣言し、マイグレーションもモデルの型もそこから導き出されること
- `bun run db:make` と `bun run db:migrate` の役割と、テスト用データベースがどう用意されるか
- モデルがテーブルに加えるもの: `create`、`all`、`findOrFail`、`fillable` によるマスアサインメント対策
- ルートモデルバインディング: ルートの `bind: { id: Post }`、コントローラーの `this.model(Post)`、自分で書かなくても返る 404
- 実際のデータベースに対してコントローラーをテストし、テストごとにリセットする方法

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. テーブル

投稿の形に関することは、すべて `db/schema.ts` に一度だけ書きます。雛形にはすでに `users` テーブルがあります(第 5 章で使います)。その下に `posts` を追加します。

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

列は 4 つで、自動採番の id、タイトル、本文、自動で入る作成日時です。`notNull()` はデータベース側の制約として働きます。単なる目印ではないので、アプリケーションのコードがどうであれ、タイトルの無い行は SQLite が受け付けません。

スキーマは TypeScript で書きますが、データベースは TypeScript を読めません。データベースが読むのは SQL で、その SQL は次のコマンドで生成します。

```bash run
bun run db:make create_posts_table
```

`db:make` は、`db/schema.ts` と `db/migrations/` にある既存のマイグレーションをすべて突き合わせ、差分を埋める SQL を書き出します。今回は最初のマイグレーションなので、両方のテーブルを作る SQL になります。`db/migrations/` の下にできた新しいフォルダを開いてみてください。中には読みやすい `migration.sql` が入っていますが、このファイルを手で編集することはありません。マイグレーションを適用します。

```bash run
bun run db:migrate
```

いま適用した先は、開発用データベース `./data/guren.db` です。テストでは別のファイル `./data/guren.test.db` を使います。Guren はどちらのデータベースでも、最初に開いたときに未適用のマイグレーションを適用するので、テストスイートのためにマイグレーションを実行する手順は要りません。

## 2. モデル

テーブルは行の形を決め、モデルはアプリのほかの部分からその行を扱うための窓口になります。`app/Models/Post.ts` を作ります。

```ts file=app/Models/Post.ts
import { defineModel } from '@guren/core'
import { posts } from '../../db/schema.js'

export type PostRecord = typeof posts.$inferSelect
export type NewPostRecord = typeof posts.$inferInsert

export class Post extends defineModel(posts, { fillable: ['title', 'body'] }) {
}
```

モデルはこれだけで、あえて薄くしています。`defineModel(posts)` によって、クラスに `find`、`findOrFail`、`all`、`create`、`update`、`delete`、`paginate` とクエリビルダーが備わり、どれもテーブル定義から型が付きます。`PostRecord` は上の 4 列とまったく同じ型で、この型を手で書く必要はありません。

`fillable` の 1 行は、便利さのためではなく安全のための設定です。`Post.create(data)` は、ここに挙げたキーだけを書き込みます。`data` に紛れ込んだ `id` は何も言わずに取り除かれますが、それ以外のキー(たとえば `createdAt`)が含まれていると、`create` は `MassAssignmentException` を投げ、何も書き込みません。第 4 章ではバリデーション済みのリクエストボディを `create` に渡しますが、そのときもこの 1 行があるので、フォームに無いフィールドをクライアントが勝手に設定することはできません。`guren audit` もこの設定があるかを検査します。

## 3. 先にテストを書く

ページは 2 つで、`/posts` の一覧と `/posts/:id` の個別表示です。作る前に、それぞれが何をするかをテストに書きます。

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

このテストには新しい点が 2 つあります。1 つ目は `resetDatabase()` です。各テストの前に実行され、テスト用データベースの全テーブルを削除してマイグレーションを適用し直すので、各テストは空の状態から始まり、必要な行だけを作れます。2 つ目は、テストが行をモデル経由の `Post.create(...)` で作っていることで、これはアプリと同じ方法です。

```bash run expect-fail
bun test
```

新しく失敗するテストが 2 つあり、どちらも 404 です。3 つ目のテストは最初から通っています。この 3 つ目は少し立ち止まって考えてみてください。`/posts/999` は投稿が存在しないから 404 を返すはずのテストですが、いまは*ルート*が存在しないせいで 404 になっています。ルートができて初めて、このテストは書かれた目的どおりのことを確かめられるようになります。では、テストが示すものを作っていきます。

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

`index` はすべての投稿を新しい順に読み込み、各行をページに必要な 3 つのフィールドに変換します。この変換は無駄な手間ではなく、これによってページには送ると決めたフィールドだけが届きます。第 4 章では、この変換処理にふさわしい置き場所を用意します。

`show` には検索処理がありません。検索はルートの側で行います。`routes/web.ts` を置き換えます。

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

- `router.group('/posts', ...)` は、中のすべてのルートの先頭にパスを付けます。そのため `'/:id'` は `/posts/:id` になります。
- `bind: { id: Post }` が**ルートモデルバインディング**です。アクションが実行される前に、Guren がパスパラメータを使って `Post.findOrFail(id)` を呼び、見つかったレコードをコントローラーに渡します。コントローラーでは、`this.model(Post)` がそのレコードを `PostRecord` 型で返します。該当する投稿が無ければ `findOrFail` が例外を投げ、レスポンスは 404 になります。これで 3 つ目のテストは、書かれた目的どおりの理由で通るようになりました。そのためのコードは 1 行も書いていません。
- ルートにオプションがある場合は、options オブジェクトを第 2 引数に渡します。`.name()` はどちらの場合も使えます。

## 5. ページ

コンポーネントは 2 つです。まず一覧ページです。

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

`route('posts.show', { id: post.id })` は、`.guren/routes.gen.ts` にある型付きのルートヘルパーです。すべてのルート名と、それぞれが受け取るパラメータを知っているので、`route('posts.shwo', ...)` のような打ち間違いや `id` の渡し忘れはコンパイルエラーになります。`PostSummary` インターフェースはページの中だけで使う型ですが、codegen は `Props` と一緒にこれも読み取ります。

続いて個別ページです。

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

マニフェストを再生成してから、仕様のテストを実行します。

```bash run
bun run codegen
```

```bash run
bun test
```

テストが通りました。**チェックポイント:** [http://localhost:3333/posts](http://localhost:3333/posts) を開くと、「No posts yet.」と表示されます。ブラウザから投稿を書く手段はまだないので、このあと作ります。ここまでの変更をゲートに通して、コミットします。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the posts table, model, and read pages"
```

## 6. 作成フォームのテストを先に書く

テストをさらに 2 つ追加します。フォームが表示されることと、フォームを送信すると投稿が作られ、その投稿のページにリダイレクトされることです。テストファイルを置き換えます。

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

2 つが失敗し、3 つが通ります。2 つ目の新しいテストで問題になる、ルートの順序に注意してください。`/posts/create` は `/posts/:id` より*前に*登録する必要があります。そうしないと、ルーターは id が `create` の投稿を探しに行き、404 を返してしまいます。

## 7. エージェントに任せる

エージェントに次のプロンプトを送ります。

```text
Add the create form for posts. `GET /posts/create`, named `posts.create`, renders `resources/js/pages/posts/New.tsx` with a title input and a body textarea that submit to `POST /posts`, named `posts.store`. The `store` action validates `title` and `body` as non-empty strings with zod, creates the post, and redirects to its page. Register `/posts/create` before `/posts/:id`. `tests/PostController.test.ts` describes the behaviour; make it pass.
```

この章で扱うハーネスの仕組みは、`.claude/skills/scaffold/` にある **`scaffold` スキル**です。このスキルは、どんな `bunx guren make:*` ジェネレーターがあり、記憶を頼りにファイルを書く代わりにいつそれを使えばよいかを、エージェントに教えます。たとえば、ページの骨組みには `make:view posts/New`、Zod スキーマのファイルには `make:validator Post` を使います。エージェントがジェネレーターを使うかどうかを見ていてください。どちらの結果でも構いませんが、ジェネレーターの出力はフレームワークの検証済みの書き方なので、ジェネレーターを使うエージェントほど間違える余地が小さくなります。

**手元にエージェントが無い場合は、** 次の 3 ファイルを書きます。コントローラーにはアクションが 2 つ増えます。

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

このページでは Inertia の `useForm` を使っています。`useForm` はフィールドの値を保持し、`form.post()` で送信してリダイレクト先に移動します。サーバーが送信を拒否した場合は、エラーメッセージが `form.errors` に入ります。このページではまだそれを表示していませんが、表示は第 4 章で扱います。

マニフェストを再生成して、仕様のテストを実行します。

```bash run
bun run codegen
```

```bash run
bun test
```

確認項目は次のとおりです。

- `routes/web.ts` が `/create` を `/:id` より前に登録していて、`POST /posts` に `posts.store` という名前が付いている。
- `store` がスキーマを渡して `this.validateBody()` を呼んでいて、それ以外の方法でリクエストボディを読んでいない。`guren audit` は、バリデーションせずにボディを読むコードがあるとゲートを失敗させるので、これは書き方の好みの問題ではない。
- `store` はバリデーション済みのデータだけを `Post.create()` に渡し、ページをレンダリングせずにリダイレクトしている。
- ページは `useForm` と `route('posts.store')` で送信していて、URL を直接書いていない。
- 5 件のテストがすべて通る。

**チェックポイント:** [http://localhost:3333/posts/create](http://localhost:3333/posts/create) で投稿を書いてみます。送信するとその投稿のページに移動し、一覧でも先頭に表示されます。

```bash run
bunx guren gate
```

ゲートは通りましたが、`gate` が報告するのは失敗だけです。先に進む前に、audit を単独で実行してください。

```bash run
bunx guren audit
```

`POST /posts` に認証チェックが無い、つまり誰でも投稿を作れる、という警告が出ます。この警告で audit やゲートが失敗することはありませんが、指摘の内容は正しいものです。いまはこのままにしておきます。このブログにはまだ認証するユーザーがいないので、対処は第 6 章で行います。

```bash run
git add -A
git commit -m "feat: add the new post form"
```

## ジェネレーターで作る場合

この章と次の章で作るものは、すべて `bunx guren add resource` のコマンド 1 つで生成できます。スキーマのテーブル定義、モデル、バリデーター、リソース、7 つのアクションを持つコントローラー、ルート、4 つのページです。マイグレーションはこれまでどおり `bun run db:make` で生成します。ここまで手で作ってきたので、ジェネレーターの出力を読んで理解できるはずです。第 5 章からは、そのうえでジェネレーターを使っていきます。今すぐ比べてみたい場合は、あとで捨てるブランチで試してください。

```bash manual
git switch -c scratch/add-resource
bunx guren add resource Post --fields "title:string,body:text" --force
git status --short
git switch main
git reset --hard
git clean -fdn
git clean -fd
git branch -D scratch/add-resource
```

`git switch main` と `git branch -D` は参照を動かすだけで、どちらを実行してもコミットしていない作業は元に戻りません。`reset` と `clean` を省くと、ジェネレーターが書いたファイルはすべて `main` の作業ツリーに残ります。消す前に対象の一覧を確認できるよう、先に `-n` で空実行します。また、ジェネレーターが新しく作ったファイルは未追跡で diff には表示されないため、`git diff` ではなく `git status` で確認します。

コードを読む前に、まずファイルの一覧を見てください。`db/schema.ts` と `routes/web.ts` は一覧にありません。スキーマはすでに `posts` をエクスポートしていて、ルートも `/posts` を登録済みなので、コマンドはどちらのファイルも変更せず、生成すべきマイグレーションもありません。それ以外のファイルは、`--force` を付けたので上書きされています。`app/Models/Post.ts` もその 1 つで、生成されたモデルには `fillable` がありません。そのため、このブランチで `bunx guren audit` を実行すると、マスアサインメントの警告が出ます。

生成されたコントローラーは、この章で書いたものと 3 か所違います。1 つ目は `:id` パラメータをモデルにバインドせずスキーマで検証している点、2 つ目は `index` がページネーションしている点、3 つ目は `store`、`update`、`destroy` が `this.auth.userOrFail()` から始まる点です。1 つ目と 2 つ目は第 4 章、3 つ目は第 6 章で扱います。`edit`、`update`、`destroy` アクションと `Edit.tsx` ページも生成されますが、このブランチではどこからもアクセスできません。ルートファイルは変更されていないので、これらのルートが 1 つも登録されていないからです。

## ここまでの状態

- `posts` テーブルとそのマイグレーション、`fillable` を持つモデルができました。
- 実際の行を読む一覧ページと個別ページがあり、存在しない投稿にはルーターが 404 を返します。
- テストは本物のデータベースに対して実行され、ケースごとにデータベースをリセットします。
- 作成フォームは、読者が先にテストを書き、エージェント(または 3 つのファイル)が作りました。データベースに届く前にバリデーションをかけています。
- `audit` の警告が 1 件ありますが、意味を理解したうえで意図的に残しています。

## よくあるつまずき

- **`db:make` が「No schema changes」と言う。** 前回のマイグレーション以降、スキーマファイルが変わっていないか、別のファイルを編集しています。`db/schema.ts` から `posts` が export されているか確認してください。
- **テストが「no such table: posts」で失敗する。** テスト用データベースは初めて使うときに作られ、そのときにマイグレーションが適用されます。前回の実行で途中までしかマイグレーションされていない `data/guren.test.db` が残っている場合は、ファイルを削除してテストをやり直してください。
- **新しいページのレイアウトが崩れ、`bun run dev` のログに `Unable to locate Inertia page "posts/New" in the generated page manifest.` が出る。** 開発サーバーを動かしたままページファイルを追加すると、ページマニフェストと生成済みの Tailwind の CSS が古いまま残ることがあります。codegen が正常に実行されていて、`.guren/pages.gen.ts` が最新でも起こります。ハードリロードでは直らないので、`bun run dev` を再起動してください。
- **`/posts/create` が 404 を返す。** `/posts/:id` より後に登録されています。ルートは上から順に照合されるので、順序が大事です。
- **`guren audit` が「Request body is read without validation」で失敗する。** store アクションが `validateBody()` 以外の方法でボディを読んでいます。スキーマを使って読んでください。
- **`this.model(Post)` が「No model binding found」で例外を投げる。** そのパラメータに対応する `bind` オプションがルートにありません。バインディングはルートで宣言するもので、コントローラーから推測されることはありません。

## 演習

1. マイグレーションで生成された `migration.sql` を開いてください。drizzle-kit が `NOT NULL` にした列はどれで、それは `db/schema.ts` のどこに由来していますか。ブランチを切って `body` を nullable にし、適用はせずに `bun run db:make` だけを実行して、生成される SQL を読んでください。読み終えたら、上の比較と同じ手順(`git switch main`、`git reset --hard`、`git clean -fd`)で変更を捨てます。ブランチを消すだけではマイグレーションのフォルダがディスクに残り、次の `bun run dev` で適用されてしまいます。
2. `Post.findOrFail(id)` は行が無ければ 404 を返しますが、`PostController` ではその例外を捕まえていません。例外をレスポンスに変換している部分を探してください。そのうえで、`Post.find(id)` を使っていた場合はどうなっていたかを答えてください。

<details>
<summary>演習 1: ヒントと答えの例</summary>

`migration.sql` の各列の行を、`db/schema.ts` の対応する行と並べて見てください。

`posts` の `title`、`body`、`created_at` と、`users` の `name`、`email`、`created_at` が `NOT NULL` です。どれも、その列で `.notNull()` を呼んでいるからです。細かい点が 2 つあります。`id` は `integer PRIMARY KEY AUTOINCREMENT` で、`NOT NULL` が付いていません。SQLite の整数の主キーはもともと null になり得ないので、drizzle-kit はこのキーワードを省きます。`created_at` には `NOT NULL` があっても `DEFAULT` がありません。`$defaultFn` は、モデルが行を挿入するときにアプリの中で実行されるからです。生の SQL で `created_at` を指定せずに挿入すると拒否されます。

`body` を nullable にしても、`db:make` は `ALTER COLUMN` を書きません。代わりにテーブルを作り直します。`body` に `NOT NULL` のない `__new_posts` テーブルを作り、`INSERT … SELECT` で `posts` から行をコピーし、`DROP TABLE posts` のあと `__new_posts` を `posts` に名前を変えます。同じ手順は第 5 章と第 6 章でも出てきます。SQLite にこれが必要な理由は、第 6 章の演習 2 で扱います。

</details>

<details>
<summary>演習 2: ヒントと答えの例</summary>

行を探しているのはコントローラーではなく、`bind: { id: Post }` を持つ `posts.show` のルートです。そこから例外の行き先をたどり、[エラーハンドリング](../guides/error-handling.md)を読んでください。

ルートモデルバインディングは `Post.findOrFail(id)` を呼びます。行がなければ、ステータス 404 を持つ `ModelNotFoundException` を投げます。途中で捕まえるものはないので、例外はアプリの `ExceptionHandler` まで届き、例外が持つステータスで応答します。応答はエラーページか JSON で、呼び出し元とデバッグモードの設定によって変わります。`Post.find(id)` は例外を投げず、`null` を返します。`show` で `const post = await Post.find(id)` と書くと、TypeScript は `post.id` の箇所で `post` が null かもしれないと指摘します。それを無視すると、行がないときは 404 ではなく `TypeError` による 500 になります。404 に戻すには `null` を確かめて自分で例外を投げる必要があり、それは `findOrFail` がすでにしていることです。

</details>

## 次へ

[第 4 章: バリデーションとリソース](./04-validation-and-resources.md) では、スキーマをルート契約付きのバリデーターファイルに移し、フォームにバリデーションエラーを表示し、リソース層を導入したうえで、編集・削除・ページネーションをエージェントに任せます。
