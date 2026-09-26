# 第 7 章: 認可と、ゲートが見逃すもの

第 6 章では、投稿を変更するにはサインインが必要という壁を作りました。ただ、扉はまだありません。サインインさえしていれば、誰でも他人の投稿を編集したり削除したりできます。これが**認証**(誰であるか)と**認可**(何を許されているか)の違いです。この章では、認可をポリシーとして手で組みます。そのうえで、ほかの章ではやらないことをあえて試します。認可には一言も触れずにエージェントへ機能を任せ、認可が抜けたときにどの安全装置が気づくのかを確かめます。

**この章で学ぶこと:**

- ポリシーの役割と登録の仕方、`this.authorize()` がポリシーをどう使うか
- 誰でも呼べるルートがあっても `guren audit` と `guren check` が通ってしまう理由と、それがテストの書き方に与える意味
- 仕様を決めるテストと、カバレッジを広げる test-writer の違い
- ハーネスの 2 つ目のサブエージェント `test-writer` の用途と、その限界

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. 編集を著者に限るテストを先に書く

ユーザーを 2 人に増やし、テストを 3 つ追加します。Grace が Ada の投稿に対してできるのは読むことだけ、という仕様です。`tests/PostController.test.ts` を次の内容に置き換えてください。

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

3 件のテストが失敗します。サインイン済みの Grace は壁の内側にいるので、Ada の投稿を編集も削除もでき、アプリはそれを何の疑いもなく受け付けてしまいました。

## 2. ポリシー

Guren では、認可のルールを**ポリシー**に書きます。ポリシーはモデルごとに 1 つのクラスで、ability ごとに 1 つのメソッドを持ち、各メソッドはユーザーとレコードを受け取って true か false を返します。まず骨組みを生成します。

```bash run
bunx guren make:policy Post
```

生成された骨組みは所有者の列を `userId` と想定していますが、このアプリでは `authorId` です。`app/Policies/PostPolicy.ts` を次の内容に置き換えてください。

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

どのメソッドも、ユーザー(ゲストなら `null`)を受け取って可否を判断します。ここには HTTP に関わるコードが一切ないので、コンソールコマンドやキューのジョブから呼んでも同じ答えが返ります。ルールをクラスにまとめておく理由はここにあり、「編集できるのは著者だけ」というルールを 1 か所に書けば、どこからでも問い合わせられます。

ポリシーは、対応するモデルと結びつけて登録します。登録は、認証まわりの設定と同じ `AuthProvider` で行います。

```ts file=app/Providers/AuthProvider.ts
import { ServiceProvider, shareInertiaProps, AUTH_CONTEXT_KEY } from '@guren/core'
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
    this.container.make('gate').policy(Post, PostPolicy)

    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}
```

あとはコントローラーからポリシーに問い合わせるだけです。3 つのアクションに 1 行ずつ追加します。

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

`this.authorize('update', [Post, post])` は、`Post` に登録されたポリシーを探して、現在のユーザーとレコードを引数にその `update` を呼び、答えが false なら 403 の例外を投げます。レコードをタプルで渡しているのには理由があります。データベースから読み込んだレコードはクラスを持たない素のオブジェクトなので、ゲートがポリシーを見つけられるよう、モデルクラスを一緒に渡す必要があります。

```bash run
bun test
```

今度はすべて通ります。Grace は編集フォーム、更新、削除のどれでも 403 を受け取り、Ada は受け取りません。

## 3. ゲートが見逃すもの

次に audit を実行します。

```bash run
bunx guren audit
```

`bunx guren audit --json` で見ると、投稿のルートはすべて「Protected by an authentication guard」と判定されていて、ポリシーを書く前とまったく同じ結果です。`bunx guren check` も、ポリシーの前後で変わらず通ります。どちらのツールも、ついさっきまで Grace が Ada の投稿を編集できたことには気づいていません。そもそも、そこを調べていないからです。`audit` が確かめるのは、変更系のルートが*何らかの*ユーザーを要求しているかどうかで、`check` が確かめるのは配線に矛盾がないかどうかです。*この*ユーザーが*この*レコードに触れてよいかはアプリケーション固有のルールなので、教えない限り静的なツールには判断できません。

ここから 3 つのことが言えます。この先の章はすべて、この 3 点を前提に進みます。

1. **ゲートが通っても、アプリが安全とは限りません。** ゲートが通ったというのは、ゲートが検査できる項目をすべて満たしたというだけです。
2. **リポジトリの中でこのルールを知っているのは、403 を確かめるテストだけです。** このテストは、第 1 節でポリシーを作る前に書きました。「Grace が Ada の投稿を編集できる」という事実を、テストの失敗として表に出したのはこのテストです。
3. **先に失敗するテストを書く 2 つ目の段取りは、このためにあります。** 変更を任せる前に書くテストは、エージェントがしたことの記録ではありません。読者の意図どおりかどうかを確かめられる唯一の安全装置で、エージェントや audit、check がルールを理解しているかどうかに関係なく働きます。

ここでコミットし、3 つ目の点をエージェントで試してみます。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: let only the author edit or delete a post"
```

## 4. 公開機能のテストを先に書く

投稿を下書きのままにしておけるようにします。追加するテストは 3 つで、著者は公開と非公開を切り替えられる、他のユーザーは切り替えられない、ゲストはサインインページへ送られる、という内容です。テストファイルを次の内容に置き換えてください。

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

3 件とも 404 で失敗します。どちらのルートもまだないからです。`publishedAt` もまだ列として存在しないので、typecheck にかければこのファイルはエラーになります。`bun test` は typecheck をしないため、ゲートでは両方を実行しています。この状態で問題ありません。テストは仕様そのもので、その仕様にはスキーマも含まれます。

## 5. 認可に触れずにエージェントに任せる

エージェントに次のプロンプトを送ります。送る前に一度読んでみてください。誰が公開できるかについては、何も書いていません。

```text
Add publishing to posts. Give the `posts` table a nullable `publishedAt` text column with a new migration. `POST /posts/:id/publish`, named `posts.publish`, sets it to the current time; `POST /posts/:id/unpublish`, named `posts.unpublish`, clears it; both redirect back to the post. The post page shows "Draft" or "Published" with the date, and a button for whichever action applies. Add `publishedAt` to `PostResource`. `tests/PostController.test.ts` describes it; make it pass.
```

送ったら、次のどちらになるかを見守ってください。

- **エージェントが `authorize` の呼び出しと、ポリシーの `publish` ability を追加する。** 何かがエージェントをそう導いたはずです。候補は、コントローラーを開いたときに読み込まれた `controllers-http.md` のルール、新しいアクションのすぐ隣にある既存の 2 つの `authorize` 呼び出し、「refuses to let anyone else publish」という名前のテストのどれかです。望ましい結果なので、どれが効いたのかを控えておいてください。第 8 章では、これを偶然に任せない方法を扱います。
- **エージェントが認可を忘れる。** `PostToolUse` hook が `guren check` を実行しますが、結果は成功です。Stop hook が `guren gate` を実行すると、audit も通ります。そのあとテストの段階で「refuses to let anyone else publish a post」の 1 件が失敗し、ターンの終了が止められます。エージェントはその失敗を読んで `authorize` の呼び出しを追加します。この流れになるのは、第 4 節でテストを書いておいたからにほかなりません。

どちらになったとしても、この節で押さえてほしいのは後者のほうです。そこでは、テスト以外のハーネスがすべて成功を返しています。

**手元にエージェントがない場合は、** まずスキーマに列を 1 つ追加します。

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

ポリシーに ability を 1 つ追加します。ルールは編集と同じです。

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

`show` では、いま見ている人に対するポリシーの答えも `canManage` として渡しています。こうしておくと、押しても 403 になるだけの人にはページ側でボタンを隠せます。ボタンを隠すのはあくまで親切のためで、ルールそのものは各アクションの `authorize` 呼び出しが決めています。

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

確認項目は次のとおりです。今回は 1 項目めがこの章の要点そのものです。

- `publish` と `unpublish` が `this.authorize('publish', [Post, post])` を呼び、`PostPolicy` に著者にだけ true を返す `publish` メソッドがある。エージェントが自分でここにたどり着いたのなら、導いたのはルールか隣のコードです。ゲートにターンの終了を止められてたどり着いたのなら、導いたのは読者が書いたテストです。
- `publishedAt` は `forceUpdate` で設定している。fillable には含めず、今後も含めない。
- どちらのルートも `auth` グループの中にあり、ゲストはポリシーに問い合わせる前にリダイレクトされる。
- ページは `publishedAt` をリソースから読み、ボタンを隠すかどうかは閲覧者についての推測ではなくポリシーの答えで決めている。
- 20 件のテストがすべて通る。

**チェックポイント:** サインインして自分の投稿を開き、公開してみてください。プライベートウィンドウで別のユーザーとしてサインインすると、ボタンは表示されません。それでもその URL に手で POST すれば、403 が返ってきます。

この章で使うハーネスの仕組みは、もう 1 つのサブエージェント **`test-writer`** (`.claude/agents/test-writer.md`) です。機能ができあがったので、試してみます。エージェントに次のプロンプトを送ります。

```text
Use the test-writer subagent to add tests for publishing and unpublishing posts.
```

書かれたテストを第 4 節のテストと比べてください。読者が書いたものより多くのケースを扱っていて、テストとしての出来もよいはずです。ただ、認可に関するテストがあれば、そこはよく読んでください。test-writer は目の前のコードからテストを組み立てます。もし `authorize` の呼び出しがないままコードが出荷されていたら、誰でも公開できるという状態をそのままテストに書き、そのテストは通っていたはずです。test-writer は、いまあるコードのカバレッジを広げることはできても、本来どうあるべきかは判断できません。それを決めるのはテストを先に書く 2 つ目の段取りで、ここはこれからも読者が受け持ちます。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: let authors publish and unpublish their posts"
```

## ここまでの状態

- 投稿のポリシーができ、ゲートに登録されて 5 つのアクションから使われています。
- どのテストにも 2 人のユーザーが登場し、他人の操作は 403 で拒否されます。
- 認可のバグがあっても `audit` と `check` は通ってしまい、任せる前に書いたテストだけが失敗して気づかせてくれることを確認しました。
- 認可に触れないプロンプトで公開機能をエージェントに任せ、その抜けを何が見つけたかを記録しました。

## よくあるつまずき

- **`this.authorize('update', post)` が「no policy」で例外を投げる。** タプルになっていません。データベースから読んだレコードはクラスを持たないので、`[Post, post]` の形で渡してください。
- **著者本人のリクエストまで 403 になる。** `user.id` と `post.authorId` の型か値が一致していません。ポリシーの中で両方を一度ログに出してみてください。文字列と数値を比べていることがよくある原因です。
- **ポリシーが無視される。** 登録されていません。`this.container.make('gate').policy(Post, PostPolicy)` は、プロバイダーの `register()` ではなく `boot()` で呼びます。ゲートは登録処理の中で束縛されるので、`boot()` より前に `make('gate')` を呼ぶと例外になります。
- **`publishedAt` を追加したあと、テストファイルがコンパイルできない。** 列ができるまではそれで正しい状態です。マイグレーションのあとも失敗するなら、codegen の結果かスキーマの import が古くなっています。
- **`test-writer` が、他人でも公開できるというテストを書いた。** サブエージェントの不具合ではありません。コードが実際に他人の公開を許していて、テストはその動きをそのまま確かめただけです。

## 演習

1. `update` から `await this.authorize('update', [Post, post])` の行を削除し、`bun test` を実行してください。失敗したテストの数を数えたら、行を元に戻します。その数がこのポリシーの価値で、`guren audit` では得られなかった数字です。
2. `this.can()` は真偽値を返し、`this.authorize()` は例外を投げます。ページでは前者を、アクションでは後者を使っています。この 2 つの答えが食い違ったら、閲覧者の画面には何が表示されますか。また、レコードを守っているのはどちらですか。

<details>
<summary>演習 1: ヒントと答えの例</summary>

`tests/PostController.test.ts` の中から、作者でない人が `update` を送るテストを探してください。

この章のテストだけなら、失敗するのは「refuses to update a post for anyone else」の 1 件です。行を消すと、Grace の `PUT` は 403 にならずに実行されてリダイレクトされ、タイトルが変わります。作者自身の更新を含め、ほかのテストはすべて通ります。ポリシーが拒否していたのは作者以外の人だけだからです。第 5 節の test-writer が更新のテストを追加していれば、数はそれより増えることがあります。`guren audit` もまったく黙っているわけではありません。`app/Policies/PostPolicy.ts` があれば、`Post` を使う更新系のアクションに認可の呼び出しがないことを警告します。ただしこの警告は参考情報なのでゲートは成功のままで、誰が通れてしまうのかまでは教えてくれません。それを示すのが、失敗したテストです。

</details>

<details>
<summary>演習 2: ヒントと答えの例</summary>

それぞれがどの ability を尋ねているかを見てください。`show` の `canManage` は `this.can('update', …)` ですが、それで表示されるボタンが実行するのは `destroy`、`publish`、`unpublish` で、これらが尋ねるのは `delete` と `publish` です。

ページが許可してアクションが拒否すると、閲覧者にはボタンが見え、押すとリクエストが 403 で返ってきます。ページが拒否してアクションが許可すると、ボタンは隠れますが、手で送ったリクエストは通ってしまいます。今は `PostPolicy` の `update`、`delete`、`publish` が同じ答えを返すので、2 つは食い違いません。`delete` だけを変えると、Delete ボタンがこのどちらかの形で実際と違う表示をするようになります。レコードを守っているのは、アクションの中の `this.authorize()` です。ページに何が表示されていたかに関係なく、すべてのリクエストで実行されます。`this.can()` が決めるのは、何を描画するかだけです。

</details>

## 次へ

[第 8 章: エージェントにプロジェクトを教える](./08-teach-the-agent.md) では、「エージェントが忘れた」という事態を防ぐ仕組みを作ります。毎回読まれるルール、依頼に合わせて従うスキル、読者の指示書を持つレビュアーの 3 つです。そのうえで、エージェントが指示なしで作るリソースを使って、その効果を確かめます。
