# 第 8 章: エージェントに自分のプロジェクトを教える

第 7 章では認可に一言も触れないプロンプトを送り、その抜けを捕まえたのが何かを確かめました。捕まえたのは自分で書いたテストだけでした。この章では、そこまで際どい状況を繰り返さないようにします。書くのは、エージェントがコントローラーを開くたびに読む rule、所有物のあるリソースを作るときに従う手順、そしてこの点だけを検査するレビュアーの brief です。そのあとは、コードと同じやり方でハーネス自体をテストします。どれにも触れずにエージェントへリソースを任せ、指示なしで正しく作れるかを確かめます。

ここまではハーネスを使う側でした。この章では自分でハーネスを書きます。

**この章で学ぶこと:**

- rule、skill、subagent のそれぞれの役割と、唯一の違いである*働くタイミング*
- エージェントが従える形で、それぞれをどう書くか
- `guren guidelines` が自力で導き出す範囲と、自分で書くべき残りの部分
- `agent:sync` が自分のファイルに触れずにフレームワークのファイルを最新に保つ仕組み
- ハーネスのテストの仕方

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. フレームワークがすでに知っていること

rule を書く前に、教えられなくてもコードから Guren が導出できるものを見ておきます。

```bash run
bunx guren guidelines -o .claude/rules/project-guidelines.md
```

ファイルを開いてください。モデルとそのリレーションシップ、バリデーター、ポリシー(`PostPolicy` を見つけています)、`audit` が強制するセキュリティルール、新機能の手順が並んでいます。すべてアプリを読んで得た内容なので、再生成すれば古くなりません。そして、**このファイルに載っていることを自分で書く必要はありません。** 自分の rule は、コードからは読み取れないもののために使います。

`.claude/rules/` はハーネスが名前で管理するディレクトリです。`agent:sync` はフレームワークが同梱する 6 ファイルを更新し、それ以外のファイルには触れません。`project-guidelines.md` と、これから書くファイルは自分のものです。

## 2. rule

コードから読み取れないのは、`PostPolicy` が存在する*理由*と、所有者を持つレコードにはすべてポリシーが要るという約束です。`.claude/rules/ownership.md` を作ります。

```md file=.claude/rules/ownership.md
---
description: Owned records — a record with an owner column is changed only through a policy, and every such action has an owner test and an other-user test
globs:
  - "app/Http/Controllers/**"
  - "app/Policies/**"
  - "routes/**"
  - "tests/**"
---

# Owned records

A record that belongs to a user carries the owner's id (`authorId` on posts, `userId` on any new table). For every such model:

1. **A policy exists** in `app/Policies/<Model>Policy.ts` and is registered in `app/Providers/AuthProvider.ts` with `this.container.make('gate').policy(Model, ModelPolicy)`. Its `update` and `delete` (and any other mutating ability) return `user !== null && user.id === record.<ownerColumn>`.
2. **Every action that changes a record** calls `await this.authorize('<ability>', [Model, record])` before doing anything else. Authentication (`requireAuthenticated`, `this.auth.userOrFail()`) is not authorization; a route inside the `auth` group still needs the policy call.
3. **The owner is set by the server**, never by the request: `Model.forceCreate({ ...validated, userId: user.id })` with `user` from `this.auth.userOrFail()`. The owner column is never in `fillable`.
4. **Every mutating action has two tests**: the owner succeeds, and another signed-in user gets `assertForbidden()`. A guest test (`assertRedirect('/login')`) covers the wall, not the door; write both.

`guren audit` verifies authentication only and stays green when a policy call is missing. The tests in rule 4 are the only check that sees it. Write them before the action.
```

仕組みを決めているのは frontmatter です。`globs` はこの rule を適用するファイルを名指しします。エージェントがコントローラー、ポリシー、ルート、テストを編集するときには rule がコンテキストに読み込まれ、ページを編集するときには読み込まれません。本文は、それを読んで行動する相手に向けて書きます。番号付きで、1 項目に義務ひとつ、書くべき呼び出しそのもの、そして最後の行に理由。audit が助けにならない*理由*を知っているエージェントは、緑の audit を許可だとは受け取りにくくなります。

## 3. skill

rule は何が成り立っていなければならないかを述べます。skill はそこへ至る手順を述べ、タスクがその description に合致したときにエージェントが手に取ります。`.claude/skills/owned-resource/SKILL.md` を作ります。

```md file=.claude/skills/owned-resource/SKILL.md
---
name: owned-resource
description: Add a resource that belongs to the user who created it (a blogroll link, a comment, a bookmark) with its policy, owner column, and owner/other-user tests. Use when asked for something a signed-in user "owns", "creates", or "manages", or for CRUD on a per-user record.
---

# Owned resource

Follow these steps in order. Do not skip the tests; the audit cannot see a missing policy call.

1. Scaffold the resource, then its policy: `bunx guren add resource <Name> --fields "<fields>"` and `bunx guren make:policy <Name>`.
2. Add the owner column to the table in `db/schema.ts`: `userId: integer('user_id').notNull().references(() => users.id)`. Then `bun run db:make create_<names>` and `bun run db:migrate`. Never `db:reset` to get there.
3. In `app/Models/<Name>.ts`, list only the request fields in `fillable`; never the owner column.
4. In the controller: `store` sets the owner with `forceCreate({ ...data, userId: user.id })` where `user` is `await this.auth.userOrFail<UserRecord>()`; `edit`, `update` and `destroy` resolve the record with route model binding and call `await this.authorize('update' | 'delete', [<Name>, record])` first.
5. Register the policy in `app/Providers/AuthProvider.ts`: `this.container.make('gate').policy(<Name>, <Name>Policy)`.
6. Routes: `index` and `show` public; `create`, `store`, `edit`, `update`, `destroy` inside `router.middleware('auth').group(...)`, with `bind: { id: <Name> }` on the record routes.
7. Tests in `tests/<Name>Controller.test.ts`: the owner can store and update; another user gets 403 on update and destroy; a guest is redirected to `/login` from the form and from store.
8. `bun run codegen`, `bun test`, `bunx guren gate`.
```

注目すべき点が 2 つあります。`description` はエージェントが要求と照合する部分なので、反応してほしい要求の形を、人が実際に使う言葉で並べています。もうひとつ、手順 2 には第 6 章のマイグレーションの規律が、手順 4 には `forceCreate` のルールが埋め込まれています。エージェントはどちらも覚えておく必要がなく、リストに従うだけで済みます。

## 4. レビュアー

subagent は、独自の brief とコンテキストを持ち、メインのエージェントから呼び出されるエージェントです。`code-review` の brief は汎用ですが、こちらはこのプロジェクト専用です。`.claude/agents/ownership-review.md` を作ります。

```md file=.claude/agents/ownership-review.md
---
name: ownership-review
description: Reviews uncommitted changes for the owned-records rule — every mutation of an owned record goes through a policy, the owner is set server-side, and the owner/other-user tests exist. Use after any change to a controller, policy, route, or test.
tools: Read, Grep, Glob, Bash
---

# Ownership review

You review one thing: whether the changes in `git diff` (staged and unstaged) respect `.claude/rules/ownership.md`. Read that rule first.

For every controller action in the diff that creates, updates or deletes a record:

1. Does the model have an owner column? If so, is there `await this.authorize(..., [Model, record])` before the write? Name the file and line if it is missing.
2. Is the owner set from `this.auth.userOrFail()` with `forceCreate`, and absent from `fillable`?
3. Is the policy registered in `app/Providers/AuthProvider.ts`?
4. Do `tests/<Name>Controller.test.ts` contain, for that action, an owner test and an `assertForbidden()` test for another user?

Report only findings, as a list of `file:line — what is missing`. If there are none, say so in one line. Do not fix anything; the main agent does that.
```

成果物が 3 つ、働くタイミングも 3 つです。**rule** は合致するファイルが開かれるたびに、誰も頼まなくても働きます。**skill** はタスクが description に合致したときに働き、rule を手順に変えます。**subagent** は呼び出されたときに、狭い brief を持つ第二の読み手として働きます。エージェントに正しくやってほしいことの大半はこの 3 つのどれかに収まるので、どれに収めるかを見極めるのが仕事の大半です。

フレームワークのファイルが今もフレームワークの管理下にあることを確かめます。

```bash run
bunx guren agent:sync --dry-run
```

更新対象(最新のハーネスなら何もありません)を報告し、自分で書いた 3 ファイルには触れません。これが名前による claim のルールです。sync が所有するのは同梱する名前だけで、`ownership.md`、`owned-resource`、`ownership-review` はその中に含まれません。

まだ使っていないハーネスの部品がもうひとつあります。`.mcp.json` は、`bun run dev` がマウントする開発用 MCP エンドポイントをエージェントに知らせるファイルです。これを通じてエージェントは、シェルに出る代わりに `guren_check`、`guren_get_context`、`guren_entity_context`、`guren_gate` をツールとして呼び、`guren_make_feature` でジェネレーターを走らせられます。このコースはどれもそれに依存していませんが、トランスクリプトに `bunx guren check` ではなく `guren_check` が出てきたら、これが理由です。

```bash run
git add -A
git commit -m "chore: add the ownership rule, skill, and reviewer to the harness"
```

## 5. リソースと、ハーネスを仕様化する

作るのはブログロール、サインイン済みユーザーが追加して所有するリンクです。テストはリソースの振る舞いを述べ、1 件だけはハーネスが何を生み出していなければならないかを述べます。

```ts file=tests/LinkController.test.ts
import { beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { Link } from '../app/Models/Link.js'
import { User, type UserRecord } from '../app/Models/User.js'

describe('LinkController', () => {
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

  it('has a policy', async () => {
    expect(await Bun.file('app/Policies/LinkPolicy.ts').exists()).toBe(true)
  })

  it('lists links', async () => {
    await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    const response = await http.get('/links').assertOk()
    await response.assertBodyContains('https://guren.dev')
  })

  it('sends a guest to the login page instead of the form', async () => {
    await http.get('/links/create').assertRedirect('/login')
  })

  it('stores a link owned by the signed-in user', async () => {
    await asAda.post('/links', { title: 'Bun', url: 'https://bun.sh' }).assertRedirect()

    const link = await Link.where('title', 'Bun').first()
    expect(link).not.toBeNull()
    expect(link?.userId).toBe(ada.id)
  })

  it('updates a link for its owner', async () => {
    const link = await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    await asAda.put(`/links/${link.id}`, { title: 'Guren docs', url: 'https://guren.dev/docs' }).assertRedirect()

    expect((await Link.findOrFail(link.id)).title).toBe('Guren docs')
  })

  it('refuses to update a link for anyone else', async () => {
    const link = await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    await asGrace.put(`/links/${link.id}`, { title: 'Hijacked', url: 'https://example.com' }).assertForbidden()

    expect((await Link.findOrFail(link.id)).title).toBe('Guren')
  })

  it('refuses to delete a link for anyone else', async () => {
    const link = await Link.forceCreate({ title: 'Guren', url: 'https://guren.dev', userId: ada.id })

    await asGrace.delete(`/links/${link.id}`).assertForbidden()

    expect(await Link.find(link.id)).not.toBeNull()
  })
})
```

```bash run expect-fail
bun test
```

`Link` モデルが無いため、ファイル全体が読み込めません。これで十分に赤です。

## 6. 何も言わずに委ねる

プロンプトは意図的に素っ気なくします。

> Add a blogroll: a Link resource with a title and a URL that a signed-in user creates and owns. Full CRUD at `/links`. `tests/LinkController.test.ts` describes it; make it pass.

ポリシーにも、所有者の列にも、テストにも触れていません。エージェントが動き出す前に、何がプロンプトを読むのかを確認してください。「creates and owns」は `owned-resource` スキルの description に合致するはずです。合致すれば、トランスクリプトには `SKILL.md` を読んでリストを上から順に進める様子が残ります。コントローラーを開けば、glob によって `ownership.md` が読み込まれます。完了と言われたら、こう頼んでください。

> Use the ownership-review subagent to review the uncommitted changes.

返ってきたリストを読みます。見分けるべき結果は次のとおりです。

- **skill が発火し、ポリシー呼び出しがあり、テストがある。** ハーネスが仕事をしました。第 7 章では同じ抜けを、手で書いたテストだけが捕まえていました。今回は rule と skill が先に届き、テストは救出ではなく確認に回りました。
- **skill は発火しなかったが、rule が働いた。** エージェントは自分のやり方でリソースを作りましたが、コントローラーを書いた時点で rule がコンテキストにあったので、`authorize` の呼び出しは足されました。skill の `description` を、自分のプロンプトが使った言葉に書き直してください。調整するのはそこです。
- **どちらも起きなかった。** レビュアーのリストが空でないか、403 のテストが赤です。今回もテストが捕まえました。コードより先にハーネスを直してください。3 つのうちどれがエージェントに届かなかったのか、その理由は何か。これは rule ファイル側のバグで、モデルのバグではありません。

**手元にエージェントが無い場合は、** 2 つのジェネレーターが大半を片づけます。所有者の列と配線だけは手で書きます。

```bash run fallback
bunx guren add resource Link --fields "title:string,url:string"
```

```bash run fallback
bunx guren make:policy Link
```

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

export const links = sqliteTable('links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make create_links
```

```bash run fallback
bun run db:migrate
```

```ts file=app/Models/Link.ts fallback
import { defineModel } from '@guren/core'
import { links } from '../../db/schema.js'

export type LinkRecord = typeof links.$inferSelect
export type NewLinkRecord = typeof links.$inferInsert

export class Link extends defineModel(links, { fillable: ['title', 'url'] }) {
}
```

```ts file=app/Http/Controllers/LinkController.ts fallback
import { Controller, paginate, type PaginatedPageProps } from '@guren/core'
import { pages } from '@/.guren/pages.gen'
import { Link } from '../../Models/Link.js'
import type { UserRecord } from '../../Models/User.js'
import { LinkResource, type LinkResourceData } from '../Resources/LinkResource.js'
import { LinkPayloadSchema, ListLinksQuerySchema } from '../Validators/LinkValidator.js'

type LinksIndexProps = PaginatedPageProps<LinkResourceData>

export default class LinkController extends Controller {
  async index(): Promise<Response> {
    const { page } = this.validateQuery(ListLinksQuerySchema)
    const result = await Link.paginate({ page, perPage: 10, orderBy: ['id', 'desc'] })
    const paginator = paginate(result, { path: this.request.path ?? '/links' })

    return this.inertia(pages.links.Index, {
      data: result.data.map((link) => new LinkResource(link).toJSON()),
      pagination: {
        meta: paginator.meta(),
        links: paginator.links(),
      },
    } satisfies LinksIndexProps)
  }

  async show(): Promise<Response> {
    const link = this.model(Link)

    return this.inertia(pages.links.Show, {
      link: new LinkResource(link).toJSON(),
    })
  }

  async create(): Promise<Response> {
    return this.inertia(pages.links.New, {})
  }

  async store(): Promise<Response> {
    const user = await this.auth.userOrFail<UserRecord>()
    const data = await this.validateBody(LinkPayloadSchema)
    const link = await Link.forceCreate({ ...data, userId: user.id })
    return this.redirect(`/links/${link.id}`)
  }

  async edit(): Promise<Response> {
    const link = this.model(Link)
    await this.authorize('update', [Link, link])

    return this.inertia(pages.links.Edit, {
      link: new LinkResource(link).toJSON(),
      errors: {},
    })
  }

  async update(): Promise<Response> {
    const link = this.model(Link)
    await this.authorize('update', [Link, link])
    const data = await this.validateBody(LinkPayloadSchema)
    await Link.update({ id: link.id }, data)
    return this.redirect(`/links/${link.id}`)
  }

  async destroy(): Promise<Response> {
    const link = this.model(Link)
    await this.authorize('delete', [Link, link])
    await Link.delete({ id: link.id })
    return this.redirect('/links')
  }
}
```

```ts file=app/Providers/AuthProvider.ts fallback
import { ServiceProvider, shareInertiaProps, AUTH_CONTEXT_KEY } from '@guren/core'
import type { AuthContext, AuthManager } from '@guren/core'
import { User } from '../Models/User.js'
import { Post } from '../Models/Post.js'
import { Link } from '../Models/Link.js'
import { PostPolicy } from '../Policies/PostPolicy.js'
import { LinkPolicy } from '../Policies/LinkPolicy.js'

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
    const gate = this.container.make('gate')
    gate.policy(Post, PostPolicy)
    gate.policy(Link, LinkPolicy)

    shareInertiaProps(async (ctx) => {
      const auth = ctx.get(AUTH_CONTEXT_KEY) as AuthContext | undefined
      return { auth: { user: await auth?.user() } }
    }, this.container)
  }
}
```

```ts file=routes/web.ts fallback
import { Router, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Link } from '../app/Models/Link.js'
import { PostPayloadSchema } from '../app/Http/Validators/PostValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
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
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
  })

  router.get('/posts', [PostController, 'index']).name('posts.index')
  router.get('/posts/:id', { bind: { id: Post }, name: 'posts.show' }, [PostController, 'show'])
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

`make:policy` は `user.id` と `userId` を比較するポリシーをすでに書いているので、そのままで通ります。`add resource` が `resources/js/pages/links/` に書いた 4 つのページも、手を入れずに使えます。

```bash run
bun run codegen
```

```bash run
bun test
```

rubric は、rule をそのまま当てはめたものです。

- `LinkPolicy` が存在して登録されており、`edit`、`update`、`destroy` が `[Link, link]` で `authorize` を呼んでいる。
- `store` は `forceCreate` でセッションから `userId` を設定している。`fillable` は `title` と `url`。
- レコードのルートは `bind` を持ち、変更系は `auth` グループの中にある。
- マイグレーションが `links` を作り、何もデータベースをリセットしていない。
- 7 件のテストが緑で、`ownership-review` subagent のリストは空。

**チェックポイント:** [http://localhost:3333/links](http://localhost:3333/links)。リンクをひとつ追加してください。別のユーザーとしてサインインすると、編集はできません。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the blogroll"
```

## いまいる場所

- エージェントがコントローラー、ポリシー、ルート、テストを編集するたびに読む rule。所有物のあるリソースのために従う skill。1 段落の brief を持つレビュアー。
- フレームワークから見える内容を述べた生成済みのガイドラインファイル。だから自分の rule は、見えない部分だけを述べればよい。
- 素っ気ないプロンプトでエージェントが作ったリソースと、ハーネスのどの部分がそれを正しくしたかの証拠。
- このコースがずっと育ててきた習慣: エージェントが何かを間違えたら、コードを直す前にハーネスを直す。

## よくあるつまずき

- **skill が一向に発火しない。** `description` に要求が使った言葉が含まれていません。description はプロンプトと照合されます。実装者の語彙ではなく、依頼者の語彙で書いてください。
- **rule がページにも読み込まれる。** `app/**` のような glob は rule の主題より広すぎます。義務が当てはまるファイルに glob を絞ってください。広いままだと、rule はエージェントが読み飛ばすノイズになります。
- **`agent:sync` が自分の rule を上書きした。** sync は同梱する名前にしか触れません。自分のファイルが置き換えられたなら、その名前がフレームワークのファイルと衝突しています。改名してください。
- **`has a policy` のテストは通るのに 403 のテストが失敗する。** ポリシーファイルは存在しますが、誰も呼んでいません。`ownership-review` が見つけるよう brief されているのは、まさにこの隙間です。走らせてください。
- **レビュアーが diff に無いファイルの指摘を報告する。** brief には `git diff` と書いてあります。アプリ全体を読んでいるなら brief を締め直してください。subagent はファイルに書かれたとおりのことだけを行います。

## 演習

1. このアプリにあって、どのチェックも強制していない約束事について、rule をもう 1 つ書いてください。候補のひとつは「すべてのページコンポーネントは `Props` インターフェースを宣言する」です。第 13 章の `spec:generate` がこれを読むからです。20 行以内に収め、どのコマンドからも見えない理由を rule 本文に書いてください。
2. `bunx guren agent:sync --dry-run` を走らせてください。置き換えられるのはどのファイルで、触られないのはどれですか。その境界が、フレームワークのハーネスとあなたのハーネスの境界です。

## 次へ

[第 9 章: リレーションシップ](./09-relationships.md) では、手作りの著者検索を `belongsTo` と `hasMany` に置き換え、コメントを追加し、多対多のタグをエージェントに委ねます。
