# 第 6 章: ルートを保護する

ブログにユーザーはできましたが、まだ誰もユーザーを確認していません。ゲストは相変わらず投稿を書き、編集し、削除できますし、`guren audit` は第 3 章からずっとそう言い続けています。この章では投稿の変更をログインの壁の内側に置き、すでにある行を失わないマイグレーションですべての投稿に著者を与え、それからエージェントにマイグレーションをひとつ任せて `db-manage` スキルがそれを安全に保つ様子を見ます。最後に、いまなら読めるようになった `bunx guren add auth` の出力を見ます。

**この章で学ぶこと:**

- `requireAuthenticated` と `requireGuest` は何をするか、ミドルウェアのエイリアスとグループがルートをどう読みやすく保つか
- `guren audit` が `requireAuthenticated` を信頼し、名前に「auth」が付いた自作ミドルウェアを信頼しない理由
- すでに行があるテーブルに必須列を足す方法: nullable で追加、埋める、それから not null
- `forceCreate` と `forceUpdate` は何のためにあるか、なぜ `authorId` は決して fillable にしてはならないか
- スキルがエージェントのデータベースへの振る舞いをどう変えるか

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. 壁を仕様化する

ルートに手を付ける前に、テストファイルが 3 つ変わります。まず投稿です。変更系リクエストはすべて Ada として行い、ゲストが何を受け取るかを新しいテスト 2 つが述べます。

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('PostController', () => {
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

  it('paginates ten posts per page', async () => {
    for (let i = 1; i <= 11; i++) {
      await Post.create({ title: `Post ${String(i).padStart(2, '0')}`, body: `Body number ${i}` })
    }

    const firstPage = await http.get('/posts').assertOk()
    await firstPage.assertBodyContains('Post 11')
    await firstPage.assertBodyContains('Post 02')
    expect(await firstPage.text()).not.toContain('Post 01')

    const secondPage = await http.get('/posts?page=2').assertOk()
    await secondPage.assertBodyContains('Post 01')
    expect(await secondPage.text()).not.toContain('Post 02')
  })

  it('shows one post', async () => {
    const post = await Post.create({ title: 'Read me', body: 'The whole body' })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('sends a guest to the login page instead of the form', async () => {
    await http.get('/posts/create').assertRedirect('/login')
  })

  it('sends a guest to the login page instead of storing', async () => {
    const guest = await http.withCsrf()
    await guest.post('/posts', { title: 'Sneaky', body: 'No account' }).assertRedirect('/login')
    expect(await Post.where('title', 'Sneaky').first()).toBeNull()
  })

  it('serves the form for a new post to a signed-in user', async () => {
    await asAda.get('/posts/create').assertOk()
  })

  it('stores a post with the signed-in user as its author and redirects to it', async () => {
    await asAda.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
    expect(post?.authorId).toBe(ada.id)
  })

  it('rejects an empty post with a message per field', async () => {
    await asAda
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })

  it('serves the edit form with the post in it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    const response = await asAda.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('updates a post and redirects to it', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await asAda.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.create({ title: 'Before', body: 'The old body' })

    await asAda
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post and redirects to the list', async () => {
    const post = await Post.create({ title: 'Doomed', body: 'Gone soon' })

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })
})
```

プロフィールページは 401 を返すのをやめ、壁に加わります。

```ts file=tests/ProfileController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('ProfileController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
  })

  it('shows the signed-in user their name and email', async () => {
    const user = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })

    const response = await http.actingAs(user).get('/profile').assertOk()
    await response.assertBodyContains('ada@example.com')
  })

  it('sends a guest to the login page', async () => {
    await http.get('/profile').assertRedirect('/login')
  })
})
```

そしてログインページには逆向きのルールが加わります。サインイン済みのユーザーには用が無いページです。

```ts file=tests/LoginController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('LoginController', () => {
  let http: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
  })

  it('serves the login form', async () => {
    await http.get('/login').assertOk()
  })

  it('sends a signed-in user home instead of the login form', async () => {
    const user = await User.where('email', 'ada@example.com').first()
    await http.actingAs(user).get('/login').assertRedirect('/')
  })

  it('signs in with the right password and redirects', async () => {
    const csrf = await http.withCsrf('/login')
    await csrf.post('/login', { email: 'ada@example.com', password: 'correct horse battery' }).assertRedirect('/')
  })

  it('rejects the wrong password with a message', async () => {
    const csrf = await http.withCsrf('/login')
    await csrf
      .post('/login', { email: 'ada@example.com', password: 'wrong' })
      .assertStatus(422)
      .assertJsonPath('errors.message.0', 'Invalid credentials.')
  })

  it('signs out and redirects home', async () => {
    const user = await User.where('email', 'ada@example.com').first()
    const csrf = await http.actingAs(user).withCsrf()
    await csrf.post('/logout').assertRedirect('/')
  })
})
```

```bash run expect-fail
bun test
```

赤が 5 つ。ゲストのリダイレクト、サインイン済みユーザーの `/login` からのリダイレクト、そしてまだ存在しない、保存された投稿の著者です。`POST /posts` に対するゲストのテストの形に注目してください。CSRF は認証より先に検査されるので、他と同じように CSRF トークンを用意し、その上で何も保存されなかったことを assert しています。リダイレクトだけでは壁が持ちこたえた証明になりません。

## 2. エイリアス 2 つ、グループ 2 つ

`routes/web.ts` を置き換えます。

```ts file=routes/web.ts
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
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
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

- `requireAuthenticated({ redirectTo: '/login' })` はガードにセッションにユーザーがいるか尋ね、いなければリダイレクトします。`redirectTo` が無ければ 401 を返します。API が望むもので、第 5 章のプロフィールページがしていたことです。
- `requireGuest({ redirectTo: '/' })` はその鏡像で、サインアウト状態でしか意味を持たないページのためのものです。
- `aliasMiddleware` がそれぞれに名前を与え、`router.middleware('auth').group(...)` が中のすべてに適用します。ファイルを上から下へ読むと壁が見えます。公開、ゲスト専用、サインイン専用、また公開。順序が守るべきルールは第 3 章から変わっていません。`/posts/create` は `/posts/:id` より前です。

次に著者です。まずスキーマを置き換えます。`authorId` は `users` を参照し、今のところ意図的に **nullable** です。

```ts file=db/schema.ts
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run
bun run db:make add_author_to_posts
```

```bash run
bun run db:migrate
```

そして `store` が誰が書いたかを記録します。

```ts file=app/Http/Controllers/PostController.ts
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { ListPostsQuerySchema, PostPayloadSchema } from '../Validators/PostValidator.js'

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
    const post = this.model(Post)

    return this.inertia(pages.posts.Show, {
      post: new PostResource(post).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }
}
```

ここでの `forceCreate` は意図的な選択で、少し立ち止まる価値があります。モデルの `fillable` は `title` と `body` を挙げていて、`authorId` はそこにありません。リクエストが投稿の著者を名乗れてはならないからです。したがって `Post.create(data)` は `authorId` を捨てます。`forceCreate` はそのフィルターを迂回しますが、安全です。そのオブジェクトの中に、フィルターされずにリクエストから来たものは何も無いからです。`data` はバリデーターを通り、`author.id` はセッションから来ました。ルールは「forceCreate を使うな」ではなく、「サーバーが選んだ値にだけ使え」です。

```bash run
bun test
```

緑です。では audit を見てみましょう。

```bash run
bunx guren audit
```

3 つの警告が消え、「Protected by an authentication guard (verified via middleware capabilities)」に置き換わっています。この最後の言い回しが重要です。`requireAuthenticated` はフレームワークが刻印したマーカーを持っていて、`audit` は名前ではなくそのマーカーを信頼します。もしあなたが自前の `requireLogin` ミドルウェアを書いて `auth` というエイリアスを付けていたら、audit はそのミドルウェアはガード*のような名前*だが認識できるものではないと言い、警告を続けたでしょう。それが正しい答えです。人間であれ機械であれ、レビュアーは名前から関数が何かを検査しているかどうかを知ることはできません。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: protect post mutations and record each post's author"
```

## 3. すでにある行

`authorId` は nullable で、あなたの開発用データベースには第 3 章と第 4 章で書いた著者無しの投稿があります。今この列を必須にすればそれらの行で失敗します。従来の回避策、つまりデータベースを落として最初からやり直す方法はデータを捨てますが、アプリが一度デプロイされたらそれは許されません。実データを生き延びるマイグレーションは 3 段階です。列を nullable で足す(済み)、埋める、それから必須にする。

埋める作業はマイグレーションではなくスクリプトです。マイグレーションが独断で下すべきでない決定、つまり孤児になった投稿を誰のものにするかを決めるからです。ここでは、誰もサインインできない「Legacy author」アカウントにします。

```ts file=scripts/backfill-post-authors.ts
import app from '../src/app.js'
import { Post } from '../app/Models/Post.js'
import { User } from '../app/Models/User.js'

await app.boot()

const orphans = (await Post.all()).filter((post) => post.authorId === null)
if (orphans.length === 0) {
  console.log('Every post has an author; nothing to do.')
  process.exit(0)
}

const legacy =
  (await User.where('email', 'legacy@guren-blog.test').first()) ??
  (await User.create({ name: 'Legacy author', email: 'legacy@guren-blog.test', password: crypto.randomUUID() }))

for (const post of orphans) {
  await Post.forceUpdate({ id: post.id }, { authorId: legacy.id })
}

console.log(`Assigned ${orphans.length} post(s) to ${legacy.name} (#${legacy.id}).`)
```

```bash run
bun scripts/backfill-post-authors.ts
```

`forceUpdate` なのは `forceCreate` と同じ理由です。`authorId` は fillable ではなく、この値はここで選ばれました。パスワードにランダムな UUID を使うのは、有効なハッシュを持ちながら誰も知らないパスワードのアカウントにするためです。

列を必須にするのが次のスライスで、それはエージェントの仕事です。

## 4. 制約と名前を仕様化する

ブログの読者にまだ見えないものが 2 つあります。すべての投稿に著者がいること、そしてそれが誰かです。投稿のテストファイルを置き換えます。テストで作る投稿はすべて著者を名指しし、新しいテストが 3 つ。スキーマが `authorId` を not null と宣言していること、一覧とページが著者名を表示することです。

```ts file=tests/PostController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { posts } from '../db/schema.js'
import { Post } from '../app/Models/Post.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('PostController', () => {
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

  it('requires an author at the schema level', () => {
    expect(posts.authorId.notNull).toBe(true)
  })

  it('lists posts, newest first, each with its author', async () => {
    const grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    await Post.forceCreate({ title: 'First post', body: 'Hello', authorId: ada.id })
    await Post.forceCreate({ title: 'Second post', body: 'Again', authorId: grace.id })

    const response = await http.get('/posts').assertOk()
    const html = await response.text()
    const first = html.indexOf('First post')
    const second = html.indexOf('Second post')
    if (first === -1 || second === -1 || second > first) {
      throw new Error('expected the newer post to be listed before the older one')
    }
    await response.assertBodyContains('Ada')
    await response.assertBodyContains('Grace')
  })

  it('paginates ten posts per page', async () => {
    for (let i = 1; i <= 11; i++) {
      await Post.forceCreate({ title: `Post ${String(i).padStart(2, '0')}`, body: `Body number ${i}`, authorId: ada.id })
    }

    const firstPage = await http.get('/posts').assertOk()
    await firstPage.assertBodyContains('Post 11')
    await firstPage.assertBodyContains('Post 02')
    expect(await firstPage.text()).not.toContain('Post 01')

    const secondPage = await http.get('/posts?page=2').assertOk()
    await secondPage.assertBodyContains('Post 01')
    expect(await secondPage.text()).not.toContain('Post 02')
  })

  it('shows one post with its author', async () => {
    const post = await Post.forceCreate({ title: 'Read me', body: 'The whole body', authorId: ada.id })

    const response = await http.get(`/posts/${post.id}`).assertOk()
    await response.assertBodyContains('The whole body')
    await response.assertBodyContains('Ada')
  })

  it('answers 404 for a post that does not exist', async () => {
    await http.get('/posts/999').assertNotFound()
  })

  it('sends a guest to the login page instead of the form', async () => {
    await http.get('/posts/create').assertRedirect('/login')
  })

  it('sends a guest to the login page instead of storing', async () => {
    const guest = await http.withCsrf()
    await guest.post('/posts', { title: 'Sneaky', body: 'No account' }).assertRedirect('/login')
    expect(await Post.where('title', 'Sneaky').first()).toBeNull()
  })

  it('serves the form for a new post to a signed-in user', async () => {
    await asAda.get('/posts/create').assertOk()
  })

  it('stores a post with the signed-in user as its author and redirects to it', async () => {
    await asAda.post('/posts', { title: 'Written in a test', body: 'By a test' }).assertRedirect()

    const post = await Post.where('title', 'Written in a test').first()
    expect(post).not.toBeNull()
    expect(post?.body).toBe('By a test')
    expect(post?.authorId).toBe(ada.id)
  })

  it('rejects an empty post with a message per field', async () => {
    await asAda
      .post('/posts', { title: '', body: '' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
      .assertJsonPath('errors.body.0', 'Body is required')
  })

  it('serves the edit form with the post in it', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    const response = await asAda.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('updates a post and redirects to it', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post and redirects to the list', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })
})
```

```bash run expect-fail
bun test
```

赤が 3 つ。最初の `posts.authorId.notNull` はスキーマそのもののテストです。Drizzle の列オブジェクトは自分の制約を知っているので、「投稿には著者がいる」という決定をデータベース無しで固定できます。

## 5. 委ねる

エージェントに頼みます。

> Every post now has an author (`scripts/backfill-post-authors.ts` has run). Make `authorId` on the `posts` table NOT NULL with a new migration, and show each post's author name on the posts list and the post page. Load the authors for a page of posts in one query, not one per post, and keep `PostResource` the one place a post's shape is defined. `tests/PostController.test.ts` describes all of it; make it pass.

エージェントがあなたのデータベースに触れるのはこれが初めてで、この章のハーネス要素は `.claude/skills/db-manage/` の **`db-manage` スキル**です。エージェントより先に読んでください。このアプリでマイグレーションがどう生成・適用・確認されるか(`make:migration`、`db:migrate`、`db:status`)、それらが前進専用であること、そして安全ルールを伝えています。破壊的な操作(`db:reset`、`db:fresh`)は、影響範囲を示しデータ損失を警告した上であなたに確認せずには決して実行しない、というルールです。エージェントがマイグレーションを生成して適用するか、リセットについてあなたに尋ねるかを見ていてください。スキルは、その違いをモデルの気分に委ねないために存在します。

**手元にエージェントが無い場合は、** スキーマが一語増え、それからマイグレーション、それからコードです。

```ts file=db/schema.ts fallback
import { sqliteTable, integer, text } from '@guren/orm/drizzle/sqlite'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  rememberToken: text('remember_token'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  authorId: integer('author_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make require_post_authors
```

```bash run fallback
bun run db:migrate
```

リソースが著者を知るようになります。著者レコードを伴うかもしれない投稿を受け取り、著者の id と名前だけを送ります。

```ts file=app/Http/Resources/PostResource.ts fallback
import { Resource } from '@guren/core'
import type { PostRecord } from '../../Models/Post.js'
import type { UserRecord } from '../../Models/User.js'

export type PostWithAuthor = PostRecord & { author?: UserRecord | null }

export interface PostResourceData extends Record<string, unknown> {
  id: number
  title: string
  body: string
  createdAt: string
  author: { id: number; name: string } | null
}

export class PostResource extends Resource<PostWithAuthor, PostResourceData> {
  toArray(): PostResourceData {
    const author = this.resource.author
    return {
      id: this.resource.id,
      title: this.resource.title,
      body: this.resource.body,
      createdAt: this.resource.createdAt,
      author: author ? { id: author.id, name: author.name } : null,
    }
  }
}
```

```ts file=app/Http/Controllers/PostController.ts fallback
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Post, type PostRecord } from '../../Models/Post.js'
import { User, type UserRecord } from '../../Models/User.js'
import { PostResource, type PostResourceData } from '../Resources/PostResource.js'
import { ListPostsQuerySchema, PostPayloadSchema } from '../Validators/PostValidator.js'

type PostsIndexProps = PaginatedPageProps<PostResourceData>

async function authorsOf(posts: PostRecord[]): Promise<Map<number, UserRecord>> {
  const ids = [...new Set(posts.map((post) => post.authorId))]
  const authors = ids.length === 0 ? [] : await User.where({ id: ids }).get()
  return new Map(authors.map((author) => [author.id, author]))
}

export default class PostController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListPostsQuerySchema)
    const result = await Post.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/posts' })
    const authors = await authorsOf(result.data)

    return this.inertia(pages.posts.Index, {
      data: result.data.map((post) => new PostResource({ ...post, author: authors.get(post.authorId) ?? null }).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies PostsIndexProps)
  }

  async show(): Promise<Response> {
    const post = this.model(Post)
    const author = await User.find(post.authorId)

    return this.inertia(pages.posts.Show, {
      post: new PostResource({ ...post, author }).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.posts.New, {})
  }

  async store(): Promise<Response> {
    const author = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(PostPayloadSchema)
    const post = await Post.forceCreate({ ...data, authorId: author.id })
    return this.redirect(`/posts/${post.id}`)
  }

  async edit(): Promise<Response> {
    const post = this.model(Post)

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }
}
```

配列を渡した `User.where({ id: ids })` は `IN` クエリです。著者が何人いようと、投稿 1 ページ分で往復 1 回です。第 9 章で `authorsOf` はリレーションシップと `with('author')` に置き換わり、より少ないコードで同じことをします。走るクエリはこれです。

2 つのページが名前をレンダリングします。

```tsx file=resources/js/pages/posts/Index.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { PaginatedPageProps } from '@guren/core'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props extends PaginatedPageProps<PostResourceData> {}

export default function PostsIndex({ data, pagination }: Props) {
  return (
    <>
      <Head title="Posts" />
      <main className="min-h-screen bg-g-page font-sans text-g-text">
        <div className="mx-auto max-w-3xl space-y-6 px-6 py-12">
          <div className="flex items-center justify-between">
            <h1 className="flex items-center gap-3 text-3xl font-bold text-g-heading">
              <span aria-hidden className="h-7 w-[3px] shrink-0 rounded-full bg-[image:var(--g-tick)]" />
              Posts
            </h1>
            <Link href={route('posts.create')} className="rounded-g-ctl bg-g-accent px-4 py-2 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
              New post
            </Link>
          </div>
          {data.length === 0 && <p className="text-g-text-2">No posts yet.</p>}
          <div className="space-y-4">
            {data.map((post) => (
              <article key={post.id} className="rounded-g-card border border-g-line bg-g-panel p-4 shadow-g-card">
                <Link href={route('posts.show', { id: post.id })} className="text-xl font-bold text-g-heading transition hover:text-g-accent-text">
                  {post.title}
                </Link>
                <p className="mt-1 font-mono text-xs text-g-text-2">by {post.author?.name ?? 'unknown'}</p>
                <p className="mt-2 text-sm text-g-text-2">{post.body}</p>
              </article>
            ))}
          </div>
          {pagination?.links?.pages && pagination.links.pages.length > 1 && (
            <nav className="flex gap-2 font-mono text-sm">
              {pagination.links.pages.map((page) => (
                <Link key={page.page} href={page.url ?? '#'} className="rounded-g-ctl border border-g-line px-3 py-1 text-g-text-2 transition hover:border-g-line-strong hover:text-g-heading">
                  {page.page}
                </Link>
              ))}
            </nav>
          )}
        </div>
      </main>
    </>
  )
}
```

```tsx file=resources/js/pages/posts/Show.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
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
          <p className="font-mono text-xs text-g-text-2">
            by {post.author?.name ?? 'unknown'} · {post.createdAt}
          </p>
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          <div className="flex items-center gap-4">
            <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
              Edit
            </Link>
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

rubric は次のとおりです。

- `db/migrations/` の下に新しいマイグレーションフォルダがあり、`bun run db:status` が適用済みと表示する。トランスクリプトに `db:reset` も `db:fresh` も無い。エージェントがそれを提案したなら、先にあなたに尋ねたはずで、それはスキルが仕事をした証拠であり、答えは「いいえ」だった。
- `authorId` はスキーマで `notNull()` になっており、相変わらず `fillable` には入っていない。
- 一覧は著者を `IN` クエリ 1 回で読み込んでいる。map の中の `User.find` ではない。
- `PostResource` は相変わらず投稿の形が書かれた唯一の場所で、出力する著者は id と名前であって、ユーザーレコードではない。
- 14 件のテストがすべて緑。

**チェックポイント:** [http://localhost:3333/posts](http://localhost:3333/posts) の投稿一覧で、この章より前に書いた投稿には「by Legacy author」、これから書く投稿にはあなたの名前が付きます。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: require an author on every post and show it"
```

## `add auth` なら何をくれていたか

セッション、ガード、ハッシュ、CSRF トークン、ログインの壁が何かを、あなたはそれぞれ自分で組んだから知っています。ジェネレーターを見るのはその瞬間です。使い捨てのブランチで。

```bash manual
git switch -c scratch/add-auth
bunx guren add auth --force
git diff main --stat
git switch main
git branch -D scratch/add-auth
```

差分の大半はあなたが書いたものと同じ形です。モデル、プロバイダー、2 つのコントローラー、バリデーター。残りはあなたが書かなかったものです。メールによるパスワードリセット、メール確認、「ログイン状態を保持する」トークン、デモユーザーのシーダー、ダッシュボード。これ以降、コースがそのどれかを必要とするときはジェネレーターに手を伸ばし、そして書かれたものを読めるはずです。

## いまいる場所

- 投稿の変更、プロフィール、ログアウトは `requireAuthenticated` の内側に、ログインと登録のページは `requireGuest` の内側に。
- きれいな audit、そしてそれがフレームワークのガードを信頼し名前を信頼しない理由の理解。
- 行をひとつも失わずに足した、すべての投稿の著者。nullable、埋める、必須。
- `db-manage` スキルのルールの下で行われた、エージェントの最初のマイグレーション。

## よくあるつまずき

- **`.middleware('auth')` がコンパイルできない。** `aliasMiddleware()` はその名前を知っている新しいルーター型を返しますが、その結果を受け取っていません。上のファイルのようにチェーンして代入してください。
- **サインイン済みのテストが `/login` にリダイレクトされる。** `actingAs()` は `withCsrf()` より前でなければなりません。用意のためのリクエストも認証済みである必要があります。どちらも新しいクライアントを返すので、代入し直してください。
- **`db:migrate` が「NOT NULL constraint failed」で失敗する。** まだ著者の無い投稿があります。先に `bun scripts/backfill-post-authors.ts` を実行してください。順序こそが第 3 節の要点です。
- **保存された投稿の `authorId` が `null`。** `store` が `Post.create` を使い、`fillable` が著者を落としました。サーバーが選んだ値で `forceCreate` を使ってください。
- **一覧の著者がすべて「unknown」になる。** `IN` クエリに渡した id の型が違うか、map のキーがユーザーの id 以外です。`authors` を一度ログに出してください。著者ごとに 1 エントリあるはずです。

## 次へ

[第 7 章: 認可、そしてゲートに見えないもの](./07-authorization.md) では、ポリシーで編集と削除を著者だけのものにし、それから認可に触れないままエージェントに機能を頼み、あなたの安全装置のどれが気づくかを見ます。
