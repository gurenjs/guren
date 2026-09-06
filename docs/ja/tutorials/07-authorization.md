# 第 7 章: 認可、そしてゲートに見えないもの

第 6 章は壁を作りました。投稿を変えるにはサインインが要ります。扉は作っていません。サインイン済みのユーザーなら誰でも、誰の投稿でも編集・削除できます。その違いが**認証**(あなたは誰か)と**認可**(あなたは許されているか)で、この章では後者をポリシーで手で組みます。そして、この章だけが意図的にやることがあります。認可に一言も触れずにエージェントに機能を委ね、それが抜けたときにあなたの安全装置のどれが気づくかを見せます。

**この章で学ぶこと:**

- ポリシーとは何か、どう登録するか、`this.authorize()` がそれをどう使うか
- 誰でも呼べるルートで `guren audit` と `guren check` が緑である理由、それがテストにとって何を意味するか
- 仕様化するテストと、カバーする test-writer の違い
- ハーネスの 2 つ目の subagent `test-writer` は何のためにあり、何ができないか

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. 扉を仕様化する

ユーザーは 2 人になり、新しいテストは 3 つ。Grace が Ada の投稿にできることは読むことだけで、それ以外は何もできない、というものです。`tests/PostController.test.ts` を置き換えます。

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
  let grace: UserRecord
  let asAda: TestApp
  let asGrace: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
    asGrace = await http.actingAs(grace).withCsrf()
  })

  it('requires an author at the schema level', () => {
    expect(posts.authorId.notNull).toBe(true)
  })

  it('lists posts, newest first, each with its author', async () => {
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

  it('serves the edit form to the author', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    const response = await asAda.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('refuses the edit form to anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asGrace.get(`/posts/${post.id}/edit`).assertForbidden()
  })

  it('updates a post for its author and redirects to it', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('refuses to update a post for anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asGrace.put(`/posts/${post.id}`, { title: 'Hijacked', body: 'By Grace' }).assertForbidden()

    expect((await Post.findOrFail(post.id)).title).toBe('Before')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post for its author and redirects to the list', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })

  it('refuses to delete a post for anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asGrace.delete(`/posts/${post.id}`).assertForbidden()

    expect(await Post.find(post.id)).not.toBeNull()
  })
})
```

```bash run expect-fail
bun test
```

赤が 3 つ。サインイン済みで壁を越えた Grace が Ada の投稿を編集し、削除し、アプリはありがとうと言いました。

## 2. ポリシー

Guren は認可のルールを**ポリシー**に置きます。モデルごとにクラスひとつ、能力ごとにメソッドひとつ、それぞれがユーザーとレコードに対して true か false を答えます。骨組みを生成します。

```bash run
bunx guren make:policy Post
```

骨組みは所有者の列を `userId` と仮定していますが、あなたのは `authorId` です。`app/Policies/PostPolicy.ts` を置き換えます。

```ts file=app/Policies/PostPolicy.ts
import { Policy, type AuthUser } from '@guren/core'
import type { PostRecord } from '../Models/Post.js'

export class PostPolicy extends Policy {
  viewAny(_user: AuthUser | null): boolean {
    return true
  }

  view(_user: AuthUser | null, _post: PostRecord): boolean {
    return true
  }

  create(user: AuthUser | null): boolean {
    return user !== null
  }

  update(user: AuthUser | null, post: PostRecord): boolean {
    return user !== null && user.id === post.authorId
  }

  delete(user: AuthUser | null, post: PostRecord): boolean {
    return user !== null && user.id === post.authorId
  }
}
```

どのメソッドもユーザー(ゲストなら `null`)を受け取って判断します。ここに HTTP の知識は何もありません。コンソールコマンドやキューのジョブから呼んでも同じ答えが返ります。それがクラスにする理由です。「編集するのは著者だけ」というルールは一度だけ書かれ、どこからでも尋ねられます。

ポリシーはそのモデルに対して登録しなければなりません。置き場所は他の認証の配線の隣、`AuthProvider` です。

```ts file=app/Providers/AuthProvider.ts
import { ServiceProvider, shareInertiaProps, getGate, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext, AuthManager } from '@guren/core'
import { User } from '../Models/User.js'
import { Post } from '../Models/Post.js'
import { PostPolicy } from '../Policies/PostPolicy.js'

export default class AuthProvider extends ServiceProvider {
  register(): void {
    const auth = this.container.make<AuthManager>('auth')
    auth.useModel(User, {
      usernameColumn: 'email',
      passwordColumn: 'passwordHash',
      rememberTokenColumn: 'rememberToken',
      credentialsPasswordField: 'password',
    })
  }

  boot(): void {
    getGate().policy(Post, PostPolicy)

    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}
```

では尋ねましょう。コントローラーの 3 つのアクションがそれぞれ 1 行ずつ増えます。

```ts file=app/Http/Controllers/PostController.ts
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
    await this.authorize('update', [Post, post])

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }
}
```

`this.authorize('update', [Post, post])` は `Post` に登録されたポリシーを見つけ、その `update` を現在のユーザーとレコードで呼び、答えが「いいえ」なら 403 を throw します。タプルは飾りではありません。データベースから読み込んだレコードは自分のクラスを持たない素のオブジェクトなので、ゲートがポリシーを見つけられるようモデルクラスが一緒に旅をしなければならないのです。

```bash run
bun test
```

緑です。Grace は編集フォーム、更新、削除で 403 を受け取り、Ada は受け取りません。

## 3. ゲートに見えないもの

次は audit です。

```bash run
bunx guren audit
```

すべての投稿ルートが「Protected by an authentication guard」です。ポリシーを書く前とまったく同じです。`bunx guren check` を実行しても、前も後も同じように満足しています。どちらのツールも、1 時間前に Grace が Ada の投稿を編集できたことを知りません。どちらもそれを探していないからです。`audit` は変更系ルートが*何らかの*ユーザーを要求しているかを検査します。`check` は配線が整合しているかを検査します。*この*ユーザーが*この*レコードに触れてよいかはあなたのアプリケーションのルールで、教えられない限り、静的ツールにそのルールは分かりません。

3 つのことが導かれ、コースの残りはその上に立ちます。

1. **緑のゲートは安全なアプリではありません。** ゲートが検査の仕方を知っているすべてに合格したゲートです。
2. **403 のテストは、リポジトリの中でそのルールを知る唯一のものです。** 第 1 節で、ポリシーが存在する前に書きました。「Grace が Ada の投稿を編集した」を事実から失敗に変えたのはそれです。
3. **第 2 拍はこのためにあります。** 変更を委ねるとき、最初に書くテストはエージェントがしたことの記録ではありません。あなたが意図したことを反映する唯一の安全装置で、エージェント、audit、check がルールを理解していようといまいと働きます。

コミットして、3 つ目の点をエージェントで試しましょう。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: let only the author edit or delete a post"
```

## 4. 公開を仕様化する

投稿は下書きでもありえます。テストは 3 つ。著者は公開と非公開ができ、他のユーザーはできず、ゲストはサインインへ送られます。テストファイルを置き換えます。

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
  let grace: UserRecord
  let asAda: TestApp
  let asGrace: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    grace = await User.create({ name: 'Grace', email: 'grace@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
    asGrace = await http.actingAs(grace).withCsrf()
  })

  it('requires an author at the schema level', () => {
    expect(posts.authorId.notNull).toBe(true)
  })

  it('lists posts, newest first, each with its author', async () => {
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

  it('serves the edit form to the author', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    const response = await asAda.get(`/posts/${post.id}/edit`).assertOk()
    await response.assertBodyContains('The old body')
  })

  it('refuses the edit form to anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asGrace.get(`/posts/${post.id}/edit`).assertForbidden()
  })

  it('updates a post for its author and redirects to it', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda.put(`/posts/${post.id}`, { title: 'After', body: 'The new body' }).assertRedirect(`/posts/${post.id}`)

    const updated = await Post.findOrFail(post.id)
    expect(updated.title).toBe('After')
    expect(updated.body).toBe('The new body')
  })

  it('refuses to update a post for anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asGrace.put(`/posts/${post.id}`, { title: 'Hijacked', body: 'By Grace' }).assertForbidden()

    expect((await Post.findOrFail(post.id)).title).toBe('Before')
  })

  it('rejects an invalid update with the same messages', async () => {
    const post = await Post.forceCreate({ title: 'Before', body: 'The old body', authorId: ada.id })

    await asAda
      .put(`/posts/${post.id}`, { title: '', body: 'Still here' })
      .assertStatus(422)
      .assertJsonPath('errors.title.0', 'Title is required')
  })

  it('deletes a post for its author and redirects to the list', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asAda.delete(`/posts/${post.id}`).assertRedirect('/posts')

    expect(await Post.find(post.id)).toBeNull()
  })

  it('refuses to delete a post for anyone else', async () => {
    const post = await Post.forceCreate({ title: 'Doomed', body: 'Gone soon', authorId: ada.id })

    await asGrace.delete(`/posts/${post.id}`).assertForbidden()

    expect(await Post.find(post.id)).not.toBeNull()
  })

  it('lets the author publish and unpublish a post', async () => {
    const post = await Post.forceCreate({ title: 'Draft', body: 'Not yet', authorId: ada.id })

    await asAda.post(`/posts/${post.id}/publish`).assertRedirect(`/posts/${post.id}`)
    expect((await Post.findOrFail(post.id)).publishedAt).not.toBeNull()

    await asAda.post(`/posts/${post.id}/unpublish`).assertRedirect(`/posts/${post.id}`)
    expect((await Post.findOrFail(post.id)).publishedAt).toBeNull()
  })

  it('refuses to let anyone else publish a post', async () => {
    const post = await Post.forceCreate({ title: 'Draft', body: 'Not yet', authorId: ada.id })

    await asGrace.post(`/posts/${post.id}/publish`).assertForbidden()

    expect((await Post.findOrFail(post.id)).publishedAt).toBeNull()
  })

  it('sends a guest to the login page instead of publishing', async () => {
    const post = await Post.forceCreate({ title: 'Draft', body: 'Not yet', authorId: ada.id })
    const guest = await http.withCsrf()

    await guest.post(`/posts/${post.id}/publish`).assertRedirect('/login')
  })
})
```

```bash run expect-fail
bun test
```

赤が 3 つ、すべて 404 です。どちらのルートも存在しません。`publishedAt` はまだ列ではないので typecheck もこのファイルを拒否するはずです。`bun test` は typecheck をしないので、ゲートが両方を走らせるのはそのためです。それでいいのです。テストが仕様で、仕様にはスキーマも含まれます。

## 5. その言葉を使わずに委ねる

送る前にプロンプトを読んでください。誰が公開できるかについては何も言っていません。

> Add publishing to posts. Give the `posts` table a nullable `publishedAt` text column with a new migration. `POST /posts/:id/publish`, named `posts.publish`, sets it to the current time; `POST /posts/:id/unpublish`, named `posts.unpublish`, clears it; both redirect back to the post. The post page shows "Draft" or "Published" with the date, and a button for whichever action applies. Add `publishedAt` to `PostResource`. `tests/PostController.test.ts` describes it; make it pass.

そして、次のどちらが起きるかを見守ってください。

- **エージェントが `authorize` の呼び出しとポリシーの `publish` 能力を足す。** 何かがそうさせました。コントローラーを開いたときに読み込まれた `controllers-http.md` の rule、新しいアクションの隣にある既存の 2 つの `authorize` 呼び出し、あるいは「refuses to let anyone else publish」という名前のテストです。良いことです。どれだったかを記録してください。第 8 章は、それを決して偶然に任せないための章だからです。
- **エージェントが忘れる。** `PostToolUse` hook が `guren check` を走らせ、緑。Stop hook が `guren gate` を走らせ、audit は緑、そしてテストのステージが「refuses to let anyone else publish a post」の 1 件で失敗し、停止はブロックされます。エージェントは失敗を読んで呼び出しを足します。そうなった唯一の理由は、第 4 節であなたが書いたテストです。

どちらにせよ、この節から持ち帰るべきは後者の分岐です。ハーネスの他のすべては、そこでは緑です。

**手元にエージェントが無い場合は、** スキーマが列をひとつ得ます。

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
  publishedAt: text('published_at'),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make add_published_at_to_posts
```

```bash run fallback
bun run db:migrate
```

ポリシーが能力を得ます。編集と同じルールです。

```ts file=app/Policies/PostPolicy.ts fallback
import { Policy, type AuthUser } from '@guren/core'
import type { PostRecord } from '../Models/Post.js'

export class PostPolicy extends Policy {
  viewAny(_user: AuthUser | null): boolean {
    return true
  }

  view(_user: AuthUser | null, _post: PostRecord): boolean {
    return true
  }

  create(user: AuthUser | null): boolean {
    return user !== null
  }

  update(user: AuthUser | null, post: PostRecord): boolean {
    return user !== null && user.id === post.authorId
  }

  delete(user: AuthUser | null, post: PostRecord): boolean {
    return user !== null && user.id === post.authorId
  }

  publish(user: AuthUser | null, post: PostRecord): boolean {
    return user !== null && user.id === post.authorId
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
      canManage: await this.can('update', [Post, post]),
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
    await this.authorize('update', [Post, post])

    return this.inertia(pages.posts.Edit, {
      post: new PostResource(post).toJSON(),
    })
  }

  async update(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('update', [Post, post])
    const data = await this.validateBody(PostPayloadSchema)
    await Post.update({ id: post.id }, data)
    return this.redirect(`/posts/${post.id}`)
  }

  async destroy(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('delete', [Post, post])
    await Post.delete({ id: post.id })
    return this.redirect('/posts')
  }

  async publish(): Promise<Response> {
    const post = this.model(Post)
    await this.authorize('publish', [Post, post])
    await Post.forceUpdate({ id: post.id }, { publishedAt: new Date().toISOString() })
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

`show` は `canManage`、つまり現在の閲覧者に対するポリシーの答えも送るので、どのみち 403 を受け取る人からページがボタンを隠せます。隠すのは礼儀で、各アクションの `authorize` 呼び出しがルールです。

```ts file=routes/web.ts fallback
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
    auth.post('/posts/:id/publish', { bind: { id: Post }, name: 'posts.publish' }, [PostController, 'publish'])
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

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
  publishedAt: string | null
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
      publishedAt: this.resource.publishedAt,
      author: author ? { id: author.id, name: author.name } : null,
    }
  }
}
```

```tsx file=resources/js/pages/posts/Show.tsx fallback
import { Head, Link } from '@inertiajs/react'
import type { PostResourceData } from '@/app/Http/Resources/PostResource'
import { route } from '@/.guren/routes.gen'

interface Props {
  post: PostResourceData
  canManage: boolean
}

export default function PostShow({ post, canManage }: Props) {
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
            by {post.author?.name ?? 'unknown'} · {post.publishedAt ? `Published ${post.publishedAt}` : 'Draft'}
          </p>
          <p className="whitespace-pre-wrap text-lg">{post.body}</p>
          {canManage && (
            <div className="flex items-center gap-4">
              <Link href={route('posts.edit', { id: post.id })} className="text-g-accent-text transition hover:underline">
                Edit
              </Link>
              {post.publishedAt ? (
                <Link href={route('posts.unpublish', { id: post.id })} method="post" as="button" className="rounded-g-ctl border border-g-line-strong px-3 py-1 text-sm text-g-text transition hover:border-g-muted">
                  Unpublish
                </Link>
              ) : (
                <Link href={route('posts.publish', { id: post.id })} method="post" as="button" className="rounded-g-ctl bg-g-accent px-3 py-1 text-sm font-bold text-g-on-accent transition hover:bg-g-accent-down">
                  Publish
                </Link>
              )}
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
          )}
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

rubric は次のとおりで、今回は最初の行が要点のすべてです。

- `publish` と `unpublish` は `this.authorize('publish', [Post, post])` を呼び、`PostPolicy` には著者だけと答える `publish` メソッドがある。エージェントが自力でそこに至ったなら、rule か隣のコードが導いた。ゲートが停止をブロックしたから至ったなら、それはあなたのテストだった。
- `publishedAt` は `forceUpdate` で設定されている。fillable ではないし、今後もそうならない。
- 両方のルートは `auth` グループの中にあり、ゲストはポリシーが参照される前にリダイレクトされる。
- ページはリソースから `publishedAt` を読み、ボタンは閲覧者についての推測ではなくポリシーの答えで隠されている。
- 20 件のテストがすべて緑。

**チェックポイント:** サインインして自分の投稿を開き、公開してみてください。プライベートウィンドウで別の人としてサインインすると、ボタンはありません。それでも URL に手で POST すれば 403 が返ります。

この章のハーネス要素はもうひとつの subagent、`.claude/agents/test-writer.md` の **`test-writer`** です。機能ができた今、試してみましょう。

> Use the test-writer subagent to add tests for publishing and unpublishing posts.

書かれたものを第 4 節と比べてください。あなたより多くのケースをカバーするでしょうし、良いテストでしょう。しかし認可に関するもの(もしあれば)を読んでください。test-writer は目の前のコードからテストを導くので、コードが `authorize` 呼び出し無しで出荷されていたら、そのテストは誰でも公開できることを記録し、そして通っていたでしょう。存在するもののカバレッジを広げることはできます。何が存在すべきかを言うことはできません。それが第 2 拍で、あなたのものであり続けます。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: let authors publish and unpublish their posts"
```

## いまいる場所

- 投稿のポリシー。ゲートに登録され、5 つのアクションから参照される。
- すべてのテストに 2 人のユーザーがいて、2 人を隔てる 403 がある。
- 認可のバグに対して `audit` と `check` は緑で、委ねる前に書くテストは緑ではないという知識。
- 認可について何も言わないプロンプトで委ねた公開機能と、何がそれを捕まえたかの記録。

## よくあるつまずき

- **`this.authorize('update', post)` が「no policy」で throw する。** タプルが抜けています。データベースのレコードにクラスはありません。`[Post, post]` を渡してください。
- **著者を含む全リクエストが 403 になる。** `user.id` と `post.authorId` の型か値が一致していません。ポリシーの中で一度両方をログに出してください。文字列と数値の比較がよくある原因です。
- **ポリシーが無視される。** 登録されていません。プロバイダーの `register()` ではなく `boot()` で `getGate().policy(Post, PostPolicy)` です。ゲートは boot の後にしか存在しません。
- **`publishedAt` を足した後、テストファイルがコンパイルできない。** 列が存在するまではそれが正しい状態です。マイグレーション後もまだ失敗するなら、codegen かスキーマの import が古くなっています。
- **`test-writer` が、他人が公開できるというテストを書いた。** コードをテストし、コードがそれを許していたのです。それが教訓であって、subagent のバグではありません。

## 次へ

[第 8 章: エージェントに自分のプロジェクトを教える](./08-teach-the-agent.md) では、「エージェントが忘れた」を、毎回読む rule、要求時に従う skill、あなたの brief を持つレビュアーに変え、それからエージェントが指示なしに作るリソースでそれらを証明します。
