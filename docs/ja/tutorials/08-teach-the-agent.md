# 第 8 章: エージェントにプロジェクトを教える

第 7 章では、認可に一言も触れないプロンプトを送り、その抜けに何が気づくかを確かめました。気づいたのは、読者が自分で書いたテストだけでした。この章では、あそこまで際どい状況を二度と起こさないようにします。用意するのは 3 つで、エージェントがコントローラーを開くたびに読むルール、所有者のいるリソースを作るときに従う手順、そしてこの点だけを確認するレビュアーの指示書です。そのあと、コードをテストするのと同じ考え方でハーネスをテストします。この 3 つには触れずにエージェントへリソースを任せ、指示がなくても正しく作れるかを確かめます。

ここまではハーネスを使う側でしたが、この章では自分でハーネスを書きます。

**この章で学ぶこと:**

- ルール、スキル、サブエージェントのそれぞれの役割と、3 つを分けている唯一の違いである*働くタイミング*
- エージェントが従える形でそれぞれを書く方法
- `guren guidelines` が自動で導き出せる範囲と、自分で書くべき残りの部分
- `agent:sync` が読者のファイルには触れずに、フレームワークのファイルだけを最新に保つ仕組み
- ハーネスをテストする方法

開発サーバーが動いていなければ起動します。

```bash run background
bun run dev
```

## 1. フレームワークが最初から知っていること

ルールを書く前に、何も教えなくても Guren がコードから読み取れる内容を確認しておきます。

```bash run
bunx guren guidelines -o .claude/rules/project-guidelines.md
```

ファイルを開くと、モデルとそのリレーションシップ、バリデーター、ポリシー(`PostPolicy` も見つかっています)、`audit` が強制するセキュリティルール、新しい機能を追加する手順が並んでいます。どれもアプリを読んで得た内容なので、再生成すれば常に最新の状態になります。もう 1 つ言えるのは、**このファイルに載っていることは自分で書かなくてよい**ということです。自分で書くルールは、コードからは読み取れないことのために使います。

`.claude/rules/` は、ハーネスがファイル名で管理するディレクトリです。`agent:sync` はフレームワークが同梱する 6 つのファイルを更新し、それ以外のファイルには触れません。`project-guidelines.md` と、これから書くファイルは読者のものです。

## 2. ルール

コードから読み取れないのは、`PostPolicy` が*なぜ*あるのか、そして所有者のいるレコードにはすべてポリシーが必要だという約束です。これを書くために、`.claude/rules/ownership.md` を作ります。

```md file=.claude/rules/ownership.md
---
paths:
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

ルールがいつ読み込まれるかは frontmatter で決まります。`paths` には、このルールを適用するファイルを指定します。Claude Code がルールの frontmatter から読むキーは `paths` だけです。この指定により、エージェントがコントローラー、ポリシー、ルート、テストを編集するときにはルールがコンテキストに読み込まれ、ページを編集するときには読み込まれません。本文は、これを読んで実際に手を動かす相手に向けて書きます。番号を振り、1 項目に義務を 1 つだけ書き、呼ぶべきメソッドをそのまま示し、最後の行に理由を添えます。audit では*なぜ*見つけられないのかを知っているエージェントは、audit が通ったことを「問題なし」の意味に取りにくくなります。ルールが読み込まれる条件は、Claude Code のドキュメントの[パス固有のルール](https://code.claude.com/docs/ja/memory#path-specific-rules)で説明されています。

## 3. スキル

ルールには、何が成り立っていなければならないかを書きます。スキルには、そこへたどり着くまでの手順を書きます。エージェントは、タスクがスキルの description に合致したときにそのスキルを使います([Claude Code: スキル](https://code.claude.com/docs/ja/skills))。`.claude/skills/owned-resource/SKILL.md` を作ります。

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

ここで見てほしい点が 2 つあります。1 つは `description` です。エージェントは依頼内容をここと照らし合わせるので、スキルを使ってほしい依頼の形を、人が実際に使う言葉で並べています。もう 1 つは、手順 2 に第 6 章のマイグレーションの決まりごとを、手順 4 に `forceCreate` のルールを組み込んでいる点です。エージェントはどちらも覚えておく必要がなく、リストに沿って進めるだけで済みます。

## 4. レビュアー

サブエージェントは、独自の指示書とコンテキストを持ち、メインのエージェントから呼び出されるエージェントです([Claude Code: サブエージェント](https://code.claude.com/docs/ja/sub-agents))。既存の `code-review` は汎用の指示書を持っていますが、ここで作るのはこのプロジェクト専用のレビュアーです。`.claude/agents/ownership-review.md` を作ります。

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

3 つのファイルは、それぞれ働くタイミングが違います。**ルール**は、対象のファイルが開かれるたびに、誰にも頼まれなくても働きます。**スキル**は、タスクが description に合致したときに働き、ルールを具体的な手順にします。**サブエージェント**は、呼び出されたときに、範囲を絞った指示書を持つもう 1 人の読み手として働きます。エージェントに正しくこなしてほしいことは、たいていこの 3 つのどれかに収まります。どれに収めるかを見極めることが、この作業の大半を占めます。

フレームワークのファイルが、今もフレームワークの管理下にあることを確かめます。

```bash run
bunx guren agent:sync --dry-run
```

出力には更新対象のファイルが並びます(ハーネスが最新なら何も出ません)。いま書いた 3 つのファイルは一度も出てきません。「Skipped 3 existing file(s): .claude/settings.json, .mcp.json, CLAUDE.md」と表示される 3 つのファイルは、それとは別のものです。これらは雛形が書き出したファイルで、読者が編集してよいものなので、sync はファイルが存在しないときにしか書き込みません。これがファイル名で持ち主を決めるルールです。sync が管理するのはフレームワークが同梱するファイル名だけで、`ownership.md`、`owned-resource`、`ownership-review` はそこに含まれません。

ハーネスには、まだ使っていない部品がもう 1 つあります。`.mcp.json` は、`bun run dev` がマウントする開発用の MCP エンドポイントをエージェントに教えるファイルです。これがあると、エージェントはシェルでコマンドを実行する代わりに、`guren_check`、`guren_get_context`、`guren_entity_context`、`guren_gate` をツールとして呼び出せます。`guren_make_feature` でジェネレーターを実行することもできます。このコースでは MCP に頼る場面はありませんが、トランスクリプトに `bunx guren check` ではなく `guren_check` が出てきたら、この仕組みを使っています。

```bash run
git add -A
git commit -m "chore: add the ownership rule, skill, and reviewer to the harness"
```

## 5. リソースとハーネスのテストを先に書く

作るのはブログロールです。サインインしたユーザーがリンクを追加し、そのリンクはそのユーザーの所有物になります。テストのほとんどはリソースの振る舞いを確かめるもので、1 件だけ、ハーネスがきちんと働いた結果としてできているはずのものを確かめます。

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

`Link` モデルがないので、ファイル全体が読み込めずに失敗します。失敗するテストとしてはこれで十分です。

## 6. 最低限の指示でエージェントに任せる

エージェントに次のプロンプトを送ります。わざと必要最低限のことしか書いていません。

```text
Add a blogroll: a Link resource with a title and a URL that a signed-in user creates and owns. Full CRUD at `/links`. `tests/LinkController.test.ts` describes it; make it pass.
```

ポリシーにも、所有者の列にも、テストにも触れていません。エージェントが動き出す前に、このプロンプトに何が反応するかを見ておいてください。「creates and owns」は `owned-resource` スキルの description に合致するはずです。合致すれば、エージェントが `SKILL.md` を読み、リストを上から順に進めていく様子がトランスクリプトに残ります。コントローラーを開いた時点で、`paths` の glob に一致して `ownership.md` も読み込まれます。エージェントが作業を終えたと言ったら、続けて次のプロンプトを送ります。

```text
Use the ownership-review subagent to review the uncommitted changes.
```

返ってきたリストを読み、結果が次のどれに当たるかを見分けます。

- **スキルが使われ、ポリシーの呼び出しもテストもそろっている。** ハーネスが役目を果たしました。第 7 章では、同じ抜けに気づけたのは手で書いたテストだけでした。今回はルールとスキルが先に効いたので、テストは失敗を食い止める役ではなく、確認する役で済みました。
- **スキルは使われなかったが、ルールは効いた。** エージェントは自己流でリソースを作りましたが、コントローラーを書く時点でルールがコンテキストに入っていたので、`authorize` の呼び出しは追加されています。この場合は、スキルの `description` を、読者のプロンプトで使った言葉に合わせて書き直してください。調整すべきなのはそこです。
- **どちらも効かなかった。** レビュアーのリストが空でないか、403 のテストが失敗しています。今回も、最後に気づいたのはテストでした。コードを直す前にハーネスを直してください。3 つのうちどれがエージェントに届かなかったのか、それはなぜかを調べます。これはモデルではなく、ルールファイル側のバグです。

**手元にエージェントがない場合は、** 大半を 2 つのジェネレーターに任せられます。所有者の列と配線だけは手で書きます。

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

`make:policy` が生成するポリシーは、最初から `user.id` と `userId` を比較しているので、そのまま使えます。`add resource` が `resources/js/pages/links/` に生成した 4 つのページも、手を入れる必要はありません。

```bash run
bun run codegen
```

```bash run
bun test
```

確認項目は、ルールをそのまま当てはめたものです。

- `LinkPolicy` が存在して登録されており、`edit`、`update`、`destroy` が `[Link, link]` を渡して `authorize` を呼んでいる。
- `store` は `forceCreate` を使い、`userId` をセッションのユーザーから設定している。`fillable` は `title` と `url` だけ。
- レコードを扱うルートには `bind` があり、変更系のルートは `auth` グループの中にある。
- `links` テーブルはマイグレーションで作られていて、途中でデータベースをリセットしていない。
- 7 件のテストがすべて通り、`ownership-review` サブエージェントのリストが空になっている。

**チェックポイント:** [http://localhost:3333/links](http://localhost:3333/links) を開き、リンクを 1 つ追加してください。別のユーザーとしてサインインすると、そのリンクは編集できません。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: add the blogroll"
```

## ここまでの状態

- エージェントがコントローラー、ポリシー、ルート、テストを編集するたびに読むルールができました。所有者のいるリソースを作るときに従うスキルと、1 段落の指示書を持つレビュアーもあります。
- フレームワークから見える内容は生成したガイドラインファイルに書かれているので、読者のルールにはフレームワークから見えない部分だけを書けば済みます。
- 最低限のプロンプトでエージェントがリソースを作り、ハーネスのどの部分が正しい実装につながったかも確かめました。
- このコースで育ててきた習慣が身につきました。エージェントが何かを間違えたら、コードを直す前にハーネスを直します。

## よくあるつまずき

- **スキルがまったく使われない。** `description` に、依頼で使った言葉が含まれていません。description はプロンプトと照らし合わされるので、実装する側ではなく依頼する側の言葉で書いてください。
- **ページを編集するときにもルールが読み込まれる。** `app/**` のようなパターンは、ルールが扱う範囲より広すぎます。義務が当てはまるファイルだけに `paths` を絞ってください。範囲が広いままだと、ルールはエージェントが読み流すだけのノイズになります。
- **ルールがすべてのセッションで読み込まれる。** frontmatter で、`paths` 以外のキー(`globs` や `applyTo`)を使って範囲を指定しています。Claude Code はそれ以外のキーをエラーを出さずに無視し、`paths` のないルールはセッションの起動時に読み込みます。
- **`agent:sync` に自分のルールを上書きされた。** sync が触れるのは、フレームワークが同梱するファイル名だけです。自分のファイルが置き換えられたなら、そのファイル名がフレームワークのファイルと重なっています。名前を変えてください。
- **`has a policy` のテストは通るのに、403 のテストが失敗する。** ポリシーのファイルはあっても、どこからも呼ばれていません。`ownership-review` の指示書は、まさにこの抜けを見つけるために書いたものです。実行してみてください。
- **diff に含まれないファイルについてまでレビュアーが指摘してくる。** 指示書には `git diff` を読むよう書いてあります。アプリ全体を読んでいるようなら、指示書で範囲を絞り直してください。サブエージェントは、ファイルに書かれたとおりのことしかしません。

## 演習

1. このアプリで守っているのに、どのチェックも強制していない約束事を 1 つ選び、ルールをもう 1 つ書いてください。たとえば「すべてのページコンポーネントは `Props` インターフェースを宣言する」が候補になります。第 13 章の `spec:generate` がこれを読むからです。20 行以内に収め、どのコマンドからも見えない理由をルール本文に書いてください。
2. `bunx guren agent:sync --dry-run` を実行してください。置き換えられるのはどのファイルで、触れられないのはどのファイルですか。その 2 つを分ける線が、フレームワークのハーネスと読者のハーネスの境目です。

## 次へ

[第 9 章: リレーションシップ](./09-relationships.md) では、手作りの著者検索を `belongsTo` と `hasMany` に置き換え、コメント機能を追加します。そのあと、多対多のタグ付けをエージェントに任せます。
