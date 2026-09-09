# 第 15 章: プロトタイプファースト

ここまでの 14 章は、ブログをバックエンドから作ってきました。テーブル、モデル、コントローラー、そしてやっとページ。何を作るか分かっているなら、その順序で正しい。しかしほとんどの機能は、誰にも分かっていないうちに始まります。文書として書かれた仕様は議論の的になり、顧客がクリックできる仕様は訂正されます。この章では次の機能を逆順で作ります。まず画面を、シードデータの上で、サーバー無しの静的ファイルとしてホストします。顧客が「これで」と言ってから、同じコードでバックエンドを作ります。

作る機能はサイトのお知らせです。著者が投稿し、編集し、取り下げられる、ピン留めできる通知。クリックできるプロトタイプを出荷し、その裏にバックエンドを入れて、デモに使ったページが手を加えないまま出荷されるページになるのを確かめます。

**この章で学ぶこと:**

- `guren add prototype` が配線するものと、そのどれもが本番バンドルに届かない理由
- fixture がブラウザ内で Inertia の visit すべてに、コントローラーと同じページの `Props` に型付けされて答える仕組み
- `bun run build:prototype` の出力と、静的ホスト側に要るもの
- ルートがまだ `prototype` ハンドラーに乗っている間、同じ fixture が `bun run dev` の描画をどう支えるか
- 昇格が何をするのかと、そのとき触らないファイル

## 1. プロトタイプモードを導入する

```bash run
bunx guren add prototype
```

ファイルをひとつ書き、3 つにパッチを当てます:

```bash run
git status --short
```

- `resources/js/prototype/index.ts` が **fixture** です。`state` と `routes` が空の `definePrototype({ … })` 呼び出しと、index ページが受け取る props の形をした `paginate()` ヘルパー。
- `resources/js/app.tsx` は `startInertiaClient()` に `prototype` を渡すようになり、`import.meta.env.GUREN_PROTOTYPE` で守られています。Vite はこれを `--mode prototype` ではリテラルの `true`、それ以外ではリテラルの `false` として定義するので、この分岐と fixture の import は `bun run build` ではデッドコードになります。
- `src/app.ts` は `createApp()` に `prototype: () => import('../resources/js/prototype/index.js')` を渡すようになりました。サーバーはルートが求めたときだけこれを読み込みます。
- `package.json` に `dev:prototype` と `build:prototype` が増え、`resources/js/vite-env.d.ts` が環境変数を宣言しています。

それ以外は何も変わっていません。アプリは以前とまったく同じようにビルドでき、テストでき、動きます。

## 2. 画面を生成する

```bash run
bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean" --prototype
```

`--prototype` は、機能のうち顧客に見える半分だけを書きます。`resources/js/pages/announcements/` の下の 4 つのページコンポーネント、バリデーター、ページが描画する `AnnouncementData` をエクスポートする `resources/js/types/Announcement.ts`、そしてこの機能が持つルートごとにひとつ、fixture に追記される 7 つのエントリ。モデルも、マイグレーションも、Resource も、コントローラーも作りません。登録すべきルートは出力されますが、それはすぐあとで手で書きます。

fixture の `pages.announcements.*` とルート名が存在するよう、マニフェストを再生成します:

```bash run
bunx guren codegen
```

## 3. ルートを登録する

fixture はルート名をキーにしているので、何かが答えるより先にルートが存在している必要があります。コントローラーの代わりに `prototype` ハンドラーで登録します。お知らせは読者のためのものなので、一覧とページは公開にします。お知らせを変更するルートはすべて、ほかの著者専用ルートと一緒に `auth` グループに置きます。

```ts file=routes/web.ts
import { Router, prototype, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostImageParamSchema,
  PostPayloadSchema,
  PublishPayloadSchema,
  PublishResponseSchema,
} from '../app/Http/Validators/PostValidator.js'
import {
  CommentDeletedSchema,
  CommentIdParamSchema,
  CommentPayloadSchema,
  CommentResponseSchema,
} from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { AnnouncementIdParamSchema, AnnouncementPayloadSchema } from '../app/Http/Validators/AnnouncementValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

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
    auth
      .post('/posts/:id/publish', {
        bind: { id: Post },
        name: 'posts.publish',
        params: PostIdParamSchema,
        body: PublishPayloadSchema,
        output: PublishResponseSchema,
      }, [PostController, 'publish'])
      .agent({ description: 'Publish a draft post. Only the post\'s author may call it.' })
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth
      .post('/posts/:id/comments', {
        bind: { id: Post },
        name: 'comments.store',
        params: PostIdParamSchema,
        body: CommentPayloadSchema,
        output: CommentResponseSchema,
      }, [CommentController, 'store'])
      .agent({ description: 'Add a comment to a post, as the calling user.' })
    auth
      .delete('/comments/:id', {
        bind: { id: Comment },
        name: 'comments.destroy',
        params: CommentIdParamSchema,
        output: CommentDeletedSchema,
      }, [CommentController, 'destroy'])
      .agent({ description: 'Delete one comment. Only its author may call it.' })
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])

    // Announcements, still on the prototype fixture: no controller exists yet.
    auth.get('/announcements/create', prototype).name('announcements.create')
    auth.get('/announcements/:id/edit', { name: 'announcements.edit', params: AnnouncementIdParamSchema }, prototype)
    auth.post('/announcements', { name: 'announcements.store', body: AnnouncementPayloadSchema }, prototype)
    auth.put('/announcements/:id', { name: 'announcements.update', params: AnnouncementIdParamSchema, body: AnnouncementPayloadSchema }, prototype)
    auth.delete('/announcements/:id', { name: 'announcements.destroy', params: AnnouncementIdParamSchema }, prototype)
  })

  router
    .get('/posts', { name: 'posts.index', query: ListPostsQuerySchema, resource: { data: [PostResource] } }, [PostController, 'index'])
    .agent({ description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])
  router.get('/announcements', prototype).name('announcements.index')
  router.get('/announcements/:id', { name: 'announcements.show', params: AnnouncementIdParamSchema }, prototype)

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

二度読む価値があるところが 2 つあります。ひとつ、`prototype` は契約オプションの有無にかかわらず、どちらのルートの形でもコントローラーのタプルが来る場所に置きます。もうひとつ、契約が本物だという点です。`/announcements/:id` に `params: AnnouncementIdParamSchema` があると、`/announcements/abc` は fixture に届く前にサーバーで 422 になります。コントローラーを置いたときとまったく同じです。fixture はルートの契約を受け継ぐのであって、置き換えるわけではありません。

```bash run
bunx guren codegen
```

## 4. デモを本物らしくする

`make:feature --prototype` は fixture に `Sample title 1` をシードしました。顧客はシードデータを製品として読むので、プロトタイプの中で手で書く価値があるのはここ、画面が何を言うかです。ファイルの残りはジェネレーターが書いたものです。ここで見ておきたいのは各エントリの形で、あとで書くコントローラーからデータベースを引いた形になっています。

```ts file=resources/js/prototype/index.ts
/**
 * The prototype fixture (RFC 0021). Under `vite --mode prototype` it answers
 * every Inertia visit in the browser, so `dist/prototype/` runs on a static
 * host with no server; on the server, routes registered with the `prototype`
 * handler answer from it until a controller replaces them. Each entry is keyed
 * by route name, typed from the route manifest and the page's Props, so a
 * renamed route or a changed Props interface fails the typecheck here.
 * `bunx guren make:feature <Entity> --prototype` appends entries.
 */
import { apiRoutes, definePrototype } from '@guren/inertia-client/prototype'
import type { ApiRoutes } from '@/.guren/api-client.gen'
import { routeManifest } from '@/.guren/routes.gen'
import type { AnnouncementData } from '@/resources/js/types/Announcement'
import { pages } from '@/.guren/pages.gen'

const PER_PAGE = 10

/** The `PaginatedPageProps` shape an index page expects, over an in-memory list. */
export function paginate<T>(items: T[], pageNumber: number, path: string) {
  const total = items.length
  const lastPage = Math.max(1, Math.ceil(total / PER_PAGE))
  const currentPage = Math.min(Math.max(1, pageNumber || 1), lastPage)
  const start = (currentPage - 1) * PER_PAGE
  const urlFor = (n: number) => (n === 1 ? path : `${path}?page=${n}`)

  return {
    data: items.slice(start, start + PER_PAGE),
    pagination: {
      meta: {
        currentPage,
        lastPage,
        perPage: PER_PAGE,
        total,
        from: total === 0 ? null : start + 1,
        to: total === 0 ? null : Math.min(start + PER_PAGE, total),
      },
      links: {
        first: urlFor(1),
        last: urlFor(lastPage),
        prev: currentPage > 1 ? urlFor(currentPage - 1) : null,
        next: currentPage < lastPage ? urlFor(currentPage + 1) : null,
        pages: Array.from({ length: lastPage }, (_, index) => ({
          page: index + 1,
          url: urlFor(index + 1),
          active: index + 1 === currentPage,
        })),
      },
    },
  }
}

export default definePrototype({
  manifest: routeManifest,
  api: apiRoutes<ApiRoutes>(),

  // Props every page carries under its own. The demo author keeps guarded
  // screens reachable in the walkthrough; set `user: null` to walk it as a guest.
  shared: {
    auth: { user: { id: 1, name: 'Ada', email: 'ada@example.com' } },
  },

  // Seed data, persisted in the tab's sessionStorage; `?prototype.reset=1` on
  // any URL starts over. `make:feature --prototype` adds a collection per entity.
  state: () => ({
    announcements: [
      {
        id: 1,
        title: 'Comments are open',
        body: 'Sign in to leave a comment on any published post. Authors get an email when you do.',
        pinned: true,
      },
      {
        id: 2,
        title: 'Maintenance on Sunday',
        body: 'The blog will be read-only from 02:00 to 02:30 UTC while the database moves.',
        pinned: false,
      },
      {
        id: 3,
        title: 'New: cover images',
        body: 'Posts can carry a cover image and a gallery. Open any post you own and look for the upload field.',
        pinned: false,
      },
    ] as AnnouncementData[],
    nextAnnouncementId: 4,
  }),

  // One entry per route name: `({ state, params, query, body, page, redirect,
  // errors, notFound }) => ...`. A named GET route with no entry opens the
  // 404 dialog in the prototype; `bunx guren check --prototype` lists them.
  routes: {
    // Announcement: generated by make:feature --prototype
    'announcements.index': ({ state, query, page }) =>
      page(pages.announcements.Index, paginate(state.announcements, Number(query.page ?? 1), '/announcements')),
    'announcements.create': ({ page }) => page(pages.announcements.New, {}),
    'announcements.show': ({ state, params, page, notFound }) => {
      const announcement = state.announcements.find((item) => item.id === Number(params.id))
      return announcement ? page(pages.announcements.Show, { announcement }) : notFound()
    },
    'announcements.edit': ({ state, params, page, notFound }) => {
      const announcement = state.announcements.find((item) => item.id === Number(params.id))
      return announcement ? page(pages.announcements.Edit, { announcement }) : notFound()
    },
    'announcements.store': ({ state, body, redirect }) => {
      const announcement: AnnouncementData = { id: state.nextAnnouncementId++, title: body.title, body: body.body, pinned: body.pinned }
      state.announcements.unshift(announcement)
      return redirect('announcements.show', { id: announcement.id })
    },
    'announcements.update': ({ state, params, body, redirect, notFound }) => {
      const announcement = state.announcements.find((item) => item.id === Number(params.id))
      if (!announcement) return notFound()
      Object.assign(announcement, { title: body.title, body: body.body, pinned: body.pinned })
      return redirect('announcements.show', { id: announcement.id })
    },
    'announcements.destroy': ({ state, params, redirect }) => {
      state.announcements = state.announcements.filter((item) => item.id !== Number(params.id))
      return redirect('announcements.index')
    },
  },
})
```

エントリをひとつ、見慣れたコントローラーのパターンと見比べてください。`'announcements.show'` はルートのパスから型付けされた `params` と、上のファクトリから型付けされた `state` を受け取り、`page(pages.announcements.Show, { announcement })` を返します。`announcement` はページの `Props` を満たす必要があります。コントローラーの `show()` は `this.validateParams()` を読み、`findOrFail()` を呼び、同じ `Props` に対して検査された `this.inertia(pages.announcements.Show, { announcement })` を返します。どちらも同じ生成コードによって同じ契約に縛られていて、違うのはデータの出どころだけです。`'announcements.store'` はルートの `body` スキーマから型付けされた `body` を受け取り(コントローラーで `this.validateBody()` が型付けするのと同じです)、`redirect('announcements.show', …)` で答えます。こちらはルートマニフェストに対して検査されますが、`this.redirect()` は検査されません。

fixture が型付けの根拠にするものは、すべて `.guren/` から来ます。ルートを改名しても、ページの `Props` を変えても、fixture はコントローラーが落ちるのと同じ `bun run typecheck` で落ちます。

## 5. チェックし、ビルドし、歩く

```bash run
bunx guren check --prototype
```

このスイートは、型検査器には見えない配線を確認します。すべての `prototype` ルートに名前と fixture のエントリがあること、すべてのエントリが存在するルートを名指ししていること、メソッドとパスを共有するルートが 2 つ無いこと(ブラウザのマッチャーが区別できません)、そして `createApp()` がローダーを持っていること。さらに、エントリの無い名前付き GET ルートを助言として一覧します。`home`、`about`、`posts.index` などはこのプロトタイプからは到達できません。ひとつの機能のプロトタイプならそれで正しく、お知らせページからそれらへのリンクは 404 ダイアログを開きます。この警告は、ブログ全体を歩けるようにしたいときに何を足せばよいかの一覧でもあります。

サーバー側も同じ fixture から答えます。7 つのルートが fixture に乗り、裏にコントローラーが無くても、既存のテストはそのまま通ります:

```bash run
bun test
```

では顧客が受け取る成果物をビルドします:

```bash run
bun run build:prototype
```

```bash run
ls dist/prototype
```

`index.html` がシェルで、プロトタイプは見つけられるべきものではないので `<meta name="robots" content="noindex, nofollow">` が入っています。`404.html` はそのコピーで、未知のパスにこのファイルを返すホスト(GitHub Pages)向けです。`_redirects` は `/* /index.html 200` と書かれていて、これを読むホスト(Cloudflare Pages、Netlify)向けです。その横にハッシュ付きのバンドルが fixture ごと並び、`public/` の下のものはすべてコピーされます。例外は `public/assets/` で、これは通常ビルド自身の出力です。このディレクトリを好きな静的ホストにアップロードし、未知のパスには `index.html` で答えるよう設定して、リンクを送ってください。サーバーも、データベースも、動かし続けるものもありません。ホストごとの一覧と、`/repo/` の下のプロジェクトページ向けのサブパスの注意は[プロトタイプファーストガイド](../guides/prototype-first.md#出荷する)にあります。

送る前に自分で歩くには:

```bash manual
bun run dev:prototype
```

動くのは Vite だけです。`bun run dev` が動いていれば止めるか、Vite に別のポートを与えてください。`/announcements` を開き、ひとつ投稿し、編集し、削除して、リロードしてみてください。状態はタブの `sessionStorage` にあるので、リロードしても操作は残り、新しいタブはシードから始まります。どの URL でも `?prototype.reset=1` を付けて開けばやり直せます。顧客の前でリセットできないデモは、繰り返せないデモです。

歩いていると 2 つのことにぶつかりますが、どちらもバグではありません。**ログインページは描画されるがフォームはどこにも行かない**: fixture に届くのは Inertia の visit だけで、ネイティブのフォーム送信、素の `<a href>`、`window.location` は静的ホストのフォールバックに当たります。そして **保護された画面がサインイン無しで開く**: ブラウザではミドルウェアが走らず、fixture の `shared.auth` が Ada はサインイン済みだと言っているからです。そこを `user: null` にすれば、ゲストとしてプロトタイプを歩けます。

バックログは CLI からも見えます。`guren context` はまだ fixture 上にあるルートを一覧します。「次の画面を実装して」と頼まれたエージェントが読むべきはこれです:

```bash run
bunx guren context | grep -A 8 'Prototype backlog'
```

```bash run
git add -A
git commit -m "feat: prototype the announcements feature"
```

`dist/` は無視されるので、コミットされるのは fixture、ページ、バリデーター、型、ルート、配線です。これがプロトタイプのすべてで、使い捨てではなく機能の始まりです。

## 6. バックエンドを指定する

顧客はクリックして回り、「これで」と言いました。次はバックエンドですが、その前に「完了」の意味を告げるテストを書きます。大事なアサーションはひとつ、プロトタイプには通せないものです。一覧はデータベースから来なければなりません。

```ts file=tests/AnnouncementController.test.ts
import { beforeAll, beforeEach, describe, it } from 'bun:test'
import { TestApp } from '@guren/testing'
import app from '../src/app.js'
import { resetDatabase } from '../config/database.js'
import { User } from '../app/Models/User.js'

describe('AnnouncementController', () => {
  let http: TestApp
  let asAda: TestApp

  beforeAll(async () => {
    http = await TestApp.fromApp(app)
  })

  beforeEach(async () => {
    await resetDatabase()
    const ada = await User.create({ name: 'Ada', email: 'ada@example.com', password: 'correct horse battery' })
    asAda = await http.actingAs(ada).withCsrf()
  })

  it('lists announcements from the database, not the fixture', async () => {
    await http
      .withHeader('X-Inertia', 'true')
      .get('/announcements')
      .assertInertia('announcements/Index', { data: [] })
  })

  it('rejects an empty title before anything is stored', async () => {
    await asAda
      .post('/announcements', { title: '', body: 'Sunday 02:00 UTC', pinned: false })
      .assertStatus(422)
  })

  it('stores an announcement for a signed-in author and shows it', async () => {
    await asAda
      .post('/announcements', { title: 'Maintenance on Sunday', body: 'Sunday 02:00 UTC', pinned: true })
      .assertRedirect()

    const response = await http.withHeader('X-Inertia', 'true').get('/announcements').assertOk()
    await response.assertBodyContains('Maintenance on Sunday')
  })

  it('sends a guest to the login page instead of the form', async () => {
    await http.get('/announcements/create').assertRedirect('/login')
  })
})
```

```bash run expect-fail
bun test tests/AnnouncementController.test.ts
```

赤がひとつ、緑が 3 つ。注目すべきは緑のほうです。422 が緑なのは、ルートの契約が fixture より先に強制されるからで、これから書くコントローラーと同じようにサーバー上で強制されます。保存して一覧が緑なのは、fixture がどちらにも、サーバーがプロセスのために保持している状態オブジェクトから答えるからです。ゲストのリダイレクトが緑なのは、裏で何が答えようとルートのミドルウェアが走るからです。赤いのは空の一覧だけです。fixture には 3 件のお知らせがあり、データベースには 1 件もありません。このテストが、プロトタイプと機能の境界線です。

## 7. 昇格を委任する

バックエンドをエージェントに渡します:

> Promote the announcements feature from its prototype to a real backend. Add an `announcements` table to `db/schema.ts` (title, body, `pinned` as a boolean defaulting to false, `createdAt`), generate and run the migration with `bun run db:make create_announcements` and `bun run db:migrate`, then run `bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean"` to write the model, Resource and controller. Replace each `prototype` handler for the `announcements.*` routes in `routes/web.ts` with the matching `[AnnouncementController, 'action']`, keeping the public/auth split as it is. Do not modify the page components, the validator or `resources/js/prototype/index.ts`. Regenerate the spec views with `bunx guren spec:generate`. `tests/AnnouncementController.test.ts` must pass.

rubric:

- **`db/schema.ts`** に 4 つの列を持つ `announcements` テーブルが増え、それ以外は変わっていない。`db/migrations/` の下にマイグレーションが生成され、適用されている。
- **`app/Models/Announcement.ts`**、**`app/Http/Resources/AnnouncementResource.ts`**、**`app/Http/Controllers/AnnouncementController.ts`** が存在する。Resource の `toArray()` は、ページが組み立てられた型 `AnnouncementData` を返す。顧客が見た形が、そのままシリアライザーの契約になっている。
- **`routes/web.ts`** に `announcements.*` の `prototype` ハンドラーが残っておらず、`index` と `show` は公開のまま、残りは `auth` グループのまま、`params` と `body` のスキーマは変わっていない。
- **`resources/js/pages/announcements/`**、**`app/Http/Validators/AnnouncementValidator.ts`**、**`resources/js/prototype/index.ts`** に触れていない。`git diff --stat` で確認する。ページこそがこの演習の要点で、fixture は `build:prototype` に答え続ける。
- **`docs/spec/`** が再生成され、`check --spec` が緑。
- **`bunx guren check --prototype`** が fixture 上のルートをひとつも挙げない。

エージェント無しで進めるときのフォールバックです。まずテーブル:

```ts file=db/schema.ts fallback
import { index, integer, primaryKey, sqliteTable, text } from '@guren/orm/drizzle/sqlite'
import type { AttachmentVariantRecord } from '@guren/core'

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

export const comments = sqliteTable('comments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
  postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
  authorId: integer('author_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
})

export const postTags = sqliteTable(
  'post_tags',
  {
    postId: integer('post_id').notNull().references(() => posts.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.postId, table.tagId] })],
)

export const links = sqliteTable('links', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  userId: integer('user_id').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})

export const attachments = sqliteTable('attachments', {
  id: text('id').primaryKey(),
  attachableType: text('attachable_type').notNull(),
  attachableId: text('attachable_id').notNull(),
  collection: text('collection').notNull().default('default'),
  disk: text('disk').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  size: integer('size').notNull(),
  width: integer('width'),
  height: integer('height'),
  variants: text('variants', { mode: 'json' }).$type<Record<string, AttachmentVariantRecord>>(),
  placeholder: text('placeholder'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, (t) => [index('attachments_attachable_idx').on(t.attachableType, t.attachableId, t.collection)])

/**
 * Column property names are the store's contract: `id`, `data`, `expiresAt`.
 * `mode: 'json'` matches DatabaseSessionStore's default, which hands the object
 * to the column rather than serializing it first.
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
})

export const announcements = sqliteTable('announcements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull(),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull().$defaultFn(() => new Date().toISOString()),
})
```

```bash run fallback
bun run db:make create_announcements
```

```bash run fallback
bun run db:migrate
```

次に、第 2 節と同じコマンドをフラグ無しで実行します。`announcements.*` のルートが `prototype` ハンドラーに乗っているアプリでは、このコマンドは自分が昇格していることを知っています。モデル、Resource、コントローラーを書き、すでにあるページとバリデーターはそのまま残し、ハンドラーの置き換えを出力します。

```bash run fallback
bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean"
```

置き換えを適用します。第 3 節のファイルから、7 つのルートの `prototype` をコントローラーに替え、そのコントローラーを import しただけのものです:

```ts file=routes/web.ts fallback
import { Router, registerAttachmentRoutes, requireAuthenticated, requireGuest } from '@guren/core'
import HomeController from '../app/Http/Controllers/HomeController.js'
import AboutController from '../app/Http/Controllers/AboutController.js'
import ContactController from '../app/Http/Controllers/ContactController.js'
import PostController from '../app/Http/Controllers/PostController.js'
import CommentController from '../app/Http/Controllers/CommentController.js'
import LinkController from '../app/Http/Controllers/LinkController.js'
import AnnouncementController from '../app/Http/Controllers/AnnouncementController.js'
import RegisterController from '../app/Http/Controllers/Auth/RegisterController.js'
import LoginController from '../app/Http/Controllers/Auth/LoginController.js'
import ProfileController from '../app/Http/Controllers/ProfileController.js'
import { Post } from '../app/Models/Post.js'
import { Comment } from '../app/Models/Comment.js'
import { Link } from '../app/Models/Link.js'
import { PostResource } from '../app/Http/Resources/PostResource.js'
import { CommentResource } from '../app/Http/Resources/CommentResource.js'
import {
  ListPostsQuerySchema,
  PostIdParamSchema,
  PostImageParamSchema,
  PostPayloadSchema,
  PublishPayloadSchema,
  PublishResponseSchema,
} from '../app/Http/Validators/PostValidator.js'
import {
  CommentDeletedSchema,
  CommentIdParamSchema,
  CommentPayloadSchema,
  CommentResponseSchema,
} from '../app/Http/Validators/CommentValidator.js'
import { LinkPayloadSchema } from '../app/Http/Validators/LinkValidator.js'
import { AnnouncementIdParamSchema, AnnouncementPayloadSchema } from '../app/Http/Validators/AnnouncementValidator.js'
import { RegisterSchema } from '../app/Http/Validators/RegisterValidator.js'
import { LoginSchema } from '../app/Http/Validators/LoginValidator.js'

export function registerWebRoutes(baseRouter: Router): void {
  // The signed delivery route for private attachments (config/attachments.ts).
  registerAttachmentRoutes(baseRouter)

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
    auth
      .post('/posts/:id/publish', {
        bind: { id: Post },
        name: 'posts.publish',
        params: PostIdParamSchema,
        body: PublishPayloadSchema,
        output: PublishResponseSchema,
      }, [PostController, 'publish'])
      .agent({ description: 'Publish a draft post. Only the post\'s author may call it.' })
    auth.post('/posts/:id/unpublish', { bind: { id: Post }, name: 'posts.unpublish' }, [PostController, 'unpublish'])
    auth.post('/posts/:id/cover', { bind: { id: Post }, name: 'posts.cover' }, [PostController, 'cover'])
    auth.delete('/posts/:id/images/:attachment', { bind: { id: Post }, name: 'posts.images.destroy', params: PostImageParamSchema }, [PostController, 'destroyImage'])
    auth
      .post('/posts/:id/comments', {
        bind: { id: Post },
        name: 'comments.store',
        params: PostIdParamSchema,
        body: CommentPayloadSchema,
        output: CommentResponseSchema,
      }, [CommentController, 'store'])
      .agent({ description: 'Add a comment to a post, as the calling user.' })
    auth
      .delete('/comments/:id', {
        bind: { id: Comment },
        name: 'comments.destroy',
        params: CommentIdParamSchema,
        output: CommentDeletedSchema,
      }, [CommentController, 'destroy'])
      .agent({ description: 'Delete one comment. Only its author may call it.' })
    auth.get('/links/create', [LinkController, 'create']).name('links.create')
    auth.get('/links/:id/edit', { bind: { id: Link }, name: 'links.edit' }, [LinkController, 'edit'])
    auth.post('/links', { name: 'links.store', body: LinkPayloadSchema }, [LinkController, 'store'])
    auth.put('/links/:id', { bind: { id: Link }, name: 'links.update', body: LinkPayloadSchema }, [LinkController, 'update'])
    auth.delete('/links/:id', { bind: { id: Link }, name: 'links.destroy' }, [LinkController, 'destroy'])
    auth.get('/announcements/create', [AnnouncementController, 'create']).name('announcements.create')
    auth.get('/announcements/:id/edit', { name: 'announcements.edit', params: AnnouncementIdParamSchema }, [AnnouncementController, 'edit'])
    auth.post('/announcements', { name: 'announcements.store', body: AnnouncementPayloadSchema }, [AnnouncementController, 'store'])
    auth.put('/announcements/:id', { name: 'announcements.update', params: AnnouncementIdParamSchema, body: AnnouncementPayloadSchema }, [AnnouncementController, 'update'])
    auth.delete('/announcements/:id', { name: 'announcements.destroy', params: AnnouncementIdParamSchema }, [AnnouncementController, 'destroy'])
  })

  router
    .get('/posts', { name: 'posts.index', query: ListPostsQuerySchema, resource: { data: [PostResource] } }, [PostController, 'index'])
    .agent({ description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])
  router.get('/announcements', [AnnouncementController, 'index']).name('announcements.index')
  router.get('/announcements/:id', { name: 'announcements.show', params: AnnouncementIdParamSchema }, [AnnouncementController, 'show'])

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

```bash run fallback
bunx guren codegen
```

スキーマが変わったので `docs/spec/` の ER ビューは古くなっています。第 13 章では、これをゲートにしました:

```bash run fallback
bunx guren spec:generate
```

## 8. 検証する

```bash run
bun test tests/AnnouncementController.test.ts
```

4 つとも緑。赤だったものは、いま空のテーブルを読んでいます。すでに緑だった 3 つは変わっていません。契約もミドルウェアもリダイレクトも、もともと fixture のものではなかったからです。

```bash run
bunx guren check --prototype
```

fixture 上のルートは無いのでバックログは空で、`guren context` はもう出力しません:

```bash run expect-fail
bunx guren context | grep 'Prototype backlog'
```

rubric の 4 点目のための `git diff --stat`、それからゲート:

```bash run
git diff --stat -- resources/js/pages app/Http/Validators/AnnouncementValidator.ts resources/js/prototype
```

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: announcements backed by the database"
```

fixture はまだそこにあり、`bun run build:prototype` もまだ動きます。顧客のリンクは同じ画面を描画し続け、それはいまやサーバーが描画するのと同じ画面です。次の機能が来たら、そのファイルから始めてください。fixture が用済みになったら、`bunx guren add prototype --remove` が 2 つのローダーの配線を外し、ファイル自体は削除できるよう残します。

## ここまでで

- バックエンドが存在する前に機能を静的ファイルとして出荷し、サーバーを動かさずに歩きました。
- fixture のエントリが何かが分かりました。同じルートマニフェストとページの `Props` に型付けされた、データベース抜きのコントローラーアクションです。
- サーバーが同じ fixture から、ルートの契約とミドルウェアを手前に置いたまま答えるのを見ました。そして本番の boot がそれを拒否することも。
- プロトタイプをバックエンドに昇格させ、ページ、バリデーター、fixture が触られずに残るのを見ました。昇格が変えるのはデータの出どころで、顧客が見たものは何も変わらないからです。

## よくあるつまずき

- **fixture の中で `pages.announcements.Index` が存在しない。** `make:feature --prototype` がページを書いてから codegen が走っていません。`bunx guren codegen`。`build:prototype` も最初にこれを走らせます。
- **boot が、fixture にエントリの無いルートを名指しして失敗する。** ルートが `prototype` ハンドラーに乗っていて、fixture にその名前のキーがありません。エントリを足すか、ルートにコントローラーを付けてください。`check --prototype` は boot せずに同じことを報告します。
- **プロトタイプのリンクが Inertia のエラーダイアログを開く。** 遷移先が fixture にエントリの無い名前付き GET ルートで、`check --prototype` が到達不能として挙げていたものです。エントリを足すか、デザインされた 404 のために `definePrototype()` に `notFoundPage` を渡してください。
- **リロードすると顧客の編集が消えている。** 新しいタブを開いたか、ホストがフルページロードで答えたうえに状態が `persist: false` になっています。既定の `'session'` は同じタブのリロードを生き延び、`'local'` はタブをまたいで生き延びます。
- **`bun run preview` が起動を拒否する。** ルートがまだ `prototype` ハンドラーに乗っていて、`NODE_ENV=production` はプロセス共有の状態を拒否します。昇格させるか、サーバーの代わりに `dist/prototype/` を出荷してください。`bunx guren doctor` がルートを名指しします。
- **昇格のあと `check --spec` が赤い。** スキーマにテーブルが増えたのに ER ビューが再生成されていません。`bunx guren spec:generate`。

## 演習

1. fixture の `shared.auth.user` は Ada です。ブランチ上でこれを `null` にして `bun run dev:prototype` を実行し、`/announcements/create` を開いてください。描画されます。サーバーならそうならない理由と、プロトタイプにこれを正直に言わせるには fixture のどこにゲストのチェックを置けばよいのかを述べてください。
2. ブランチ上で、`definePrototype()` に自分のページを指す `notFoundPage` を足し、プロトタイプで `/announcements/99` を開いてください。次にそのページコンポーネントを削除して `bun run typecheck` を実行してください。何が捕まえましたか。同じ間違いをコントローラーでしたら、同じ場所で捕まったでしょうか。

## 終わり、もう一度

これがコース最後の機能で、逆順で作りました。月曜に顧客がクリックできるリンクを渡し、水曜にその裏のバックエンドを入れ、その間に顧客が見たものは何ひとつ書き直していません。[プロトタイプファーストガイド](../guides/prototype-first.md)には、この章が省いた部分があります。ホストごとの設定、サブパスでのビルド、favicon のためのシェルの差し替え、そしてブラウザのランタイムが再現しないものの一覧です。
