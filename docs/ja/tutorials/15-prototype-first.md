# 第 15 章: プロトタイプファースト

ここまでの 14 章では、テーブル、モデル、コントローラーと作ってから最後にページを作る、バックエンドから順の進め方でブログを作ってきました。何を作るかが決まっているなら、この順序で問題ありません。しかし多くの機能は、何を作るのか誰にもはっきりしないうちに始まります。文書で書いた仕様には議論が起きがちですが、顧客が実際にクリックできる仕様なら具体的な修正が返ってきます。この章では、次の機能を逆の順序で作ります。まず画面をシードデータで作り、サーバー無しの静的ファイルとしてホストします。顧客の了承が得られてから、同じコードのままバックエンドを作ります。

作る機能はサイトのお知らせです。著者が投稿、編集、取り下げでき、ピン留めもできる通知です。クリックできるプロトタイプを公開したあとでバックエンドを実装し、デモで見せたページが一切手を加えずにそのまま本番のページになることを確かめます。

**この章で学ぶこと:**

- `guren add prototype` が組み込むものと、そのどれも本番のバンドルに含まれない理由
- fixture がブラウザ内ですべての Inertia の visit に応答する仕組みと、コントローラーと同じページの `Props` で型付けされる点
- `bun run build:prototype` が出力するものと、静的ホスト側で必要な設定
- ルートが `prototype` ハンドラーのままの間、同じ fixture で `bun run dev` の画面も描画される仕組み
- 昇格で何が変わり、どのファイルには手を付けないのか

## 1. プロトタイプモードを導入する

```bash run
bunx guren add prototype
```

このコマンドは新しいファイルを 1 つ作り、既存の 4 つのファイルを書き換えます。

```bash run
git status --short
```

- `resources/js/prototype/index.ts` が **fixture** です。`state` と `routes` が空の `definePrototype({ … })` の呼び出しと、index ページが受け取る props と同じ形を返す `paginate()` ヘルパーが入っています。
- `resources/js/app.tsx` では、`startInertiaClient()` に `prototype` を渡すようになりました。この部分は `import.meta.env.GUREN_PROTOTYPE` の条件分岐の中にあります。Vite はこの値を `--mode prototype` のときはリテラルの `true`、それ以外ではリテラルの `false` に置き換えるので、`bun run build` ではこの分岐も fixture の import もデッドコードとして取り除かれます。
- `src/app.ts` では、`createApp()` に `prototype: () => import('../resources/js/prototype/index.js')` を渡すようになりました。サーバーがこれを読み込むのは、ルートが必要としたときだけです。
- `package.json` に `dev:prototype` と `build:prototype` が加わり、`resources/js/vite-env.d.ts` にこの環境変数の宣言が入りました。

ほかには何も変わっていません。アプリはこれまでとまったく同じようにビルド、テスト、実行できます。

## 2. 画面を生成する

```bash run
bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean" --prototype
```

`--prototype` を付けると、機能のうち顧客の目に見える部分だけが生成されます。生成されるのは、`resources/js/pages/announcements/` の下の 4 つのページコンポーネント、バリデーター、ページが描画する `AnnouncementData` をエクスポートする `resources/js/types/Announcement.ts`、そして fixture に追記される 7 つのエントリ(この機能のルート 1 つにつき 1 つ)です。モデル、マイグレーション、Resource、コントローラーは作りません。登録すべきルートは画面に表示されますが、ルートはこのあと手で書きます。

fixture が参照する `pages.announcements.*` とルート名が使えるよう、マニフェストを再生成します。

```bash run
bunx guren codegen
```

## 3. ルートを登録する

fixture はルート名をキーにしているので、応答を返す前にルートが登録されている必要があります。ここではコントローラーの代わりに `prototype` ハンドラーでルートを登録します。お知らせは読者に向けたものなので、一覧と詳細ページは公開します。お知らせを変更するルートは、ほかの著者専用ルートと一緒に `auth` グループに入れます。

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
      .agent({ toolName: 'posts_publish', description: 'Publish a draft post. Only the post\'s author may call it.' })
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
      .agent({ toolName: 'comments_store', description: 'Add a comment to a post, as the calling user.' })
    auth
      .delete('/comments/:id', {
        bind: { id: Comment },
        name: 'comments.destroy',
        params: CommentIdParamSchema,
        output: CommentDeletedSchema,
      }, [CommentController, 'destroy'])
      .agent({ toolName: 'comments_destroy', description: 'Delete one comment. Only its author may call it.' })
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
    .agent({ toolName: 'posts_index', description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ toolName: 'posts_show', description: 'Read one post by id, with its author, tags and comments.' })
  router.get('/links', [LinkController, 'index']).name('links.index')
  router.get('/links/:id', { bind: { id: Link }, name: 'links.show' }, [LinkController, 'show'])
  router.get('/announcements', prototype).name('announcements.index')
  router.get('/announcements/:id', { name: 'announcements.show', params: AnnouncementIdParamSchema }, prototype)

  // Health check endpoint for load balancers and uptime monitors
  router.get('/health', (c) => c.json({ status: 'ok' }))
}
```

ここで注目してほしい点が 2 つあります。1 つ目は、`prototype` を置く位置です。契約オプションがあってもなくても、どちらの書き方でもコントローラーのタプルを書く場所に置きます。2 つ目は、契約が実際に効くことです。`/announcements/:id` に `params: AnnouncementIdParamSchema` を指定しているので、`/announcements/abc` へのリクエストは fixture に届く前にサーバーで 422 になります。コントローラーを置いた場合とまったく同じ動きです。fixture はルートの契約を置き換えず、そのまま引き継ぎます。

```bash run
bunx guren codegen
```

## 4. デモを本物らしくする

`make:feature --prototype` は fixture のシードデータを `Sample title 1` にし、`add prototype` はサインイン中のユーザーを `Demo User` にしていました。顧客はシードデータを製品の中身として受け取るので、プロトタイプで手をかけるべきなのは、画面に表示する文言とサインインしているユーザーです。下のコードでは、`shared.auth.user` も Ada に変えています。それ以外の部分はジェネレーターが書いたままです。ここで押さえておきたいのは各エントリの形です。あとで書くコントローラーから、データベースの処理を除いた形になっています。

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

エントリを 1 つ選んで、見慣れたコントローラーの書き方と比べてみてください。`'announcements.show'` は、ルートのパスから型付けされた `params` と、上のファクトリから型付けされた `state` を受け取り、`page(pages.announcements.Show, { announcement })` を返します。この `announcement` はページの `Props` を満たしていなければなりません。コントローラーの `show()` なら、`this.validateParams()` で値を読み、`findOrFail()` を呼び、同じ `Props` で検査される `this.inertia(pages.announcements.Show, { announcement })` を返します。どちらも同じ生成コードによって同じ契約に縛られていて、違うのはデータをどこから取ってくるかだけです。

`'announcements.store'` は、ルートの `body` スキーマから型付けされた `body` を受け取ります。コントローラーで `this.validateBody()` が型を付けるのと同じです。応答は `redirect('announcements.show', …)` で返し、この呼び出しはルートマニフェストに照らして検査されます。コントローラーの `this.redirect()` では、この検査は行われません。

fixture の型の元になるものは、すべて `.guren/` にあります。そのため、ルート名を変えたりページの `Props` を変えたりすると、コントローラーと同じく fixture も `bun run typecheck` でエラーになります。

## 5. チェックとビルドをして、画面を触ってみる

```bash run
bunx guren check --prototype
```

このチェックでは、型検査では見つけられない組み込みの漏れを確認します。確認するのは、すべての `prototype` ルートに名前と fixture のエントリがあること、すべてのエントリが実在するルートを指していること、メソッドとパスが同じルートが 2 つ無いこと(ブラウザ側のマッチャーが区別できないため)、`createApp()` にローダーが渡されていることの 4 点です。

さらに、fixture にエントリの無い名前付き GET ルートを、参考扱いの警告として一覧します。`about`、`login`、`posts.index` などは、このプロトタイプからは開けません。ホームページが一覧に載っていないのは、単に `/` のルートに名前が付いていないからです。1 つの機能のプロトタイプとしてはこれで問題なく、お知らせページからこれらへのリンクをたどると 404 ダイアログが開きます。ブログ全体を操作できるプロトタイプにしたい場合は、この警告の一覧がそのまま追加すべきエントリの一覧になります。

サーバー側も同じ fixture を使って応答します。7 つのルートが fixture で応答していて、裏にコントローラーが無くても、既存のテストはそのまま通ります。

```bash run
bun test
```

続いて、顧客に渡す成果物をビルドします。

```bash run
bun run build:prototype
```

```bash run
ls dist/prototype
```

`index.html` はアプリの土台になるシェルです。プロトタイプは検索エンジンに載せるものではないので、`<meta name="robots" content="noindex, nofollow">` が入っています。`404.html` はその複製で、未知のパスにこのファイルを返すホスト(GitHub Pages)向けです。`_redirects` には `/* /index.html 200` と書かれていて、このファイルを読むホスト(Cloudflare Pages、Netlify)向けです。

その横には fixture を含むハッシュ付きのバンドルが並び、`public/` の下のファイルもすべてコピーされます。ただし `public/assets/` は通常のビルドの出力先なので除かれます。このディレクトリを好きな静的ホストにアップロードし、未知のパスには `index.html` を返すよう設定したら、リンクを顧客に送るだけです。サーバーもデータベースも要らず、動かし続けておくものもありません。ホストごとの設定の一覧と、`/repo/` の下にあるプロジェクトページでのサブパスの注意点は、[プロトタイプファーストガイド](../guides/prototype-first.md#出荷する)にまとめてあります。

送る前に手元で操作して確かめるには、次のコマンドを実行します。

```bash manual
bun run dev:prototype
```

起動するのは Vite だけです。`bun run dev` が動いていれば止めるか、Vite に別のポートを指定してください。`/announcements` を開き、お知らせを 1 つ投稿し、編集し、削除してから、ページをリロードしてみてください。状態はタブの `sessionStorage` に保存されるので、リロードしても操作の結果は残り、新しいタブを開くとシードデータから始まります。どの URL でも `?prototype.reset=1` を付けて開けば最初からやり直せます。顧客の前でデモを何度でも見せるには、このリセットが欠かせません。

操作していると 2 つの挙動に気付くはずですが、どちらもバグではありません。1 つは、**ログインページは表示されるのに、フォームを送信しても何も起きない**ことです。fixture が受け取るのは Inertia の visit だけで、ネイティブのフォーム送信、素の `<a href>`、`window.location` での移動は、静的ホストのフォールバックに届きます。もう 1 つは、**保護された画面がサインインせずに開ける**ことです。ブラウザではミドルウェアが動かず、fixture の `shared.auth` で Ada がサインイン済みになっているためです。ここを `user: null` にすれば、ゲストとしてプロトタイプを操作できます。

実装が残っている画面は CLI からも確認できます。`guren context` の **Prototype backlog** に、まだ fixture で応答しているルートが並びます。「次の画面を実装して」と頼まれたエージェントが読むべき一覧です。

```bash run
bunx guren context | grep -A 8 'Prototype backlog'
```

ルートが増えて `docs/spec/screens.md` の内容が変わったので、ゲートにかける前に spec のビューを再生成します。

```bash run
bunx guren spec:generate
```

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: prototype the announcements feature"
```

`dist/` は git の管理対象外なので、コミットされるのは fixture、ページ、バリデーター、型、ルート、組み込みのための変更と、`.guren/prototype/index.html` を含む `.guren/` 以下の再生成されたファイルです。プロトタイプはこれで全部です。捨てるためのものではなく、ここから機能を作っていきます。

## 6. バックエンドのテストを先に書く

顧客はひととおり触ってみて、了承してくれました。次はバックエンドですが、その前に何をもって完了とするかを示すテストを書きます。肝心なアサーションは、プロトタイプのままでは通らない 1 つ、「一覧はデータベースから取得されること」です。

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

1 つが失敗し、3 つが通ります。通ったテストのほうを見てください。422 のテストが通るのは、ルートの契約が fixture より先に適用されるからです。これから書くコントローラーのときと同じく、サーバー上で検証されます。保存してから一覧を見るテストが通るのは、サーバーがプロセス内に持つ状態オブジェクトを使って、fixture がどちらのリクエストにも応答するからです。ゲストのリダイレクトが通るのは、裏で何が応答するかに関係なく、ルートのミドルウェアが実行されるからです。

失敗するのは空の一覧を期待するテストだけです。fixture にはお知らせが 3 件ありますが、データベースには 1 件もありません。このテストが通るかどうかで、プロトタイプと実際の機能を区別できます。

## 7. 昇格をエージェントに任せる

バックエンドの実装はエージェントに任せます。エージェントに次のプロンプトを送ります。

```text
Promote the announcements feature from its prototype to a real backend. Add an `announcements` table to `db/schema.ts` (title, body, `pinned` as a boolean defaulting to false, `createdAt`), generate and run the migration with `bun run db:make create_announcements` and `bun run db:migrate`, then run `bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean"` to write the model, Resource and controller. Replace each `prototype` handler for the `announcements.*` routes in `routes/web.ts` with the matching `[AnnouncementController, 'action']`, keeping the public/auth split as it is. Do not modify the page components, the validator or `resources/js/prototype/index.ts`. Regenerate the spec views with `bunx guren spec:generate`. `tests/AnnouncementController.test.ts` must pass.
```

確認項目は次のとおりです。

- **`db/schema.ts`** に 4 つの列を持つ `announcements` テーブルが追加され、ほかは変わっていない。`db/migrations/` の下にマイグレーションが生成され、適用されている。
- **`app/Models/Announcement.ts`**、**`app/Http/Resources/AnnouncementResource.ts`**、**`app/Http/Controllers/AnnouncementController.ts`** がある。Resource の `toArray()` が返す `AnnouncementResourceData` は、ページが前提にしてきた `AnnouncementData` の別名になっている。これで顧客が見た形がそのままシリアライザーの契約になり、`codegen` はそれを `Data.Announcement` として出力する。
- **`routes/web.ts`** で、`announcements.*` の `prototype` ハンドラーがすべて置き換わっている。`index` と `show` は公開のまま、残りは `auth` グループのままで、`params` と `body` のスキーマも変わっていない。
- **`resources/js/pages/announcements/`**、**`app/Http/Validators/AnnouncementValidator.ts`**、**`resources/js/prototype/index.ts`** に変更が無い。`git diff --stat` で確認する。ページを変えずに済むことがこの演習の要点で、fixture は引き続き `build:prototype` の応答に使われる。
- **`docs/spec/`** が再生成され、`check --spec` が通る。
- **`bunx guren check --prototype`** が、fixture で応答しているルートを 1 つも挙げない。

エージェントを使わずに進める場合のフォールバックです。まずテーブルを追加します。

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

次に、第 2 節と同じコマンドをフラグ無しで実行します。`announcements.*` のルートが `prototype` ハンドラーのままのアプリでは、このコマンドは昇格として動きます。モデル、Resource、コントローラーを生成し、既存のページとバリデーターはそのまま残して、ハンドラーをどう置き換えるかを表示します。

```bash run fallback
bunx guren make:feature Announcement --fields "title:string,body:text,pinned:boolean"
```

表示された置き換えを適用します。第 3 節のファイルで、7 つのルートの `prototype` をコントローラーに替え、そのコントローラーを import しただけのものです。

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
      .agent({ toolName: 'posts_publish', description: 'Publish a draft post. Only the post\'s author may call it.' })
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
      .agent({ toolName: 'comments_store', description: 'Add a comment to a post, as the calling user.' })
    auth
      .delete('/comments/:id', {
        bind: { id: Comment },
        name: 'comments.destroy',
        params: CommentIdParamSchema,
        output: CommentDeletedSchema,
      }, [CommentController, 'destroy'])
      .agent({ toolName: 'comments_destroy', description: 'Delete one comment. Only its author may call it.' })
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
    .agent({ toolName: 'posts_index', description: 'List posts, newest first, ten to a page.' })
  router
    .get('/posts/:id', {
      name: 'posts.show',
      params: PostIdParamSchema,
      // Type-level only: nothing runs at request time. It tells codegen and the
      // agent surface what this route answers with, which is what keeps the
      // Inertia page working while the tool still advertises a shape.
      resource: { post: PostResource, comments: [CommentResource] },
    }, [PostController, 'show'])
    .agent({ toolName: 'posts_show', description: 'Read one post by id, with its author, tags and comments.' })
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

スキーマが変わったので、`docs/spec/` の ER ビューが古くなっています。第 13 章でゲートの検査対象にしたので、生成し直しておきます。

```bash run fallback
bunx guren spec:generate
```

## 8. 検証する

```bash run
bun test tests/AnnouncementController.test.ts
```

4 つとも通ります。失敗していたテストは、いまは空のテーブルを読んでいます。最初から通っていた 3 つの結果は変わりません。契約もミドルウェアもリダイレクトも、もともと fixture が担っていたものではないからです。

```bash run
bunx guren check --prototype
```

結果は `0 passed, 1 warnings` です。`prototype` ハンドラーのルートが無くなったので、確かめるべきローダーの組み込みもありません。1 件の警告は、第 5 節で見た「fixture にエントリの無い名前付きルート」の一覧で、内容は変わっていません。失敗が 0 件であれば問題ありません。

fixture で応答するルートが無くなったので、**Prototype backlog** も空になり、`guren context` はこの一覧をもう表示しません。

```bash run expect-fail
bunx guren context | grep 'Prototype backlog'
```

確認項目の 4 点目を `git diff --stat` で確かめてから、ゲートを実行します。

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

fixture は残っていて、`bun run build:prototype` も引き続き使えます。顧客に送ったリンクでは同じ画面が表示され続け、その画面はいまサーバーが描画する画面と同じものです。次の機能に取りかかるときも、このファイルから始めてください。fixture が不要になったら、`bunx guren add prototype --remove` を実行します。2 つのローダーの組み込みが外れ、ファイル自体は手で削除できるように残されます。

## ここまでの状態

- バックエンドを作る前に機能を静的ファイルとして公開し、サーバーを動かさずに操作しました。
- fixture のエントリの正体が分かりました。同じルートマニフェストとページの `Props` で型付けされた、データベースの処理を除いたコントローラーアクションです。
- サーバーがルートの契約とミドルウェアを通したうえで同じ fixture から応答すること、本番の boot ではそれが拒否されることを確かめました。
- プロトタイプをバックエンドに昇格させても、ページ、バリデーター、fixture が変わらないことを確かめました。昇格で変わるのはデータの取得元だけで、顧客が見たものは何も変わりません。

## よくあるつまずき

- **fixture の中で `pages.announcements.Index` が見つからない。** `make:feature --prototype` がページを生成したあとに codegen を実行していません。`bunx guren codegen` を実行してください。`build:prototype` も最初にこれを実行します。
- **boot が、fixture にエントリの無いルートを挙げて失敗する。** そのルートは `prototype` ハンドラーのままなのに、fixture にその名前のキーがありません。エントリを追加するか、ルートにコントローラーを割り当ててください。`check --prototype` を使えば、boot しなくても同じ問題を報告してくれます。
- **プロトタイプのリンクを開くと Inertia のエラーダイアログが出る。** 遷移先が fixture にエントリの無い名前付き GET ルートで、`check --prototype` が開けないルートとして挙げていたものです。エントリを追加するか、デザインした 404 ページを出すために `definePrototype()` に `notFoundPage` を渡してください。
- **リロードすると顧客が編集した内容が消えている。** 新しいタブを開いたか、ホストがページ全体を読み込み直し、しかも状態が `persist: false` になっています。既定の `'session'` なら同じタブでのリロード後も状態が残り、`'local'` ならタブをまたいでも残ります。
- **`bun run preview` が起動しない。** まだ `prototype` ハンドラーのルートがあり、`NODE_ENV=production` ではプロセス内で共有する状態が許可されないためです。ルートを昇格させるか、サーバーではなく `dist/prototype/` を公開してください。該当するルートは `bunx guren doctor` で確認できます。
- **昇格したあと `check --spec` が失敗する。** スキーマにテーブルが増えたのに、ER ビューを再生成していません。`bunx guren spec:generate` を実行してください。

## 演習

1. fixture の `shared.auth.user` は Ada になっています。ブランチを切ってこれを `null` にし、`bun run dev:prototype` を実行して `/announcements/create` を開いてください。ページは表示されます。サーバーなら表示されない理由と、プロトタイプでも同じ挙動にするには fixture のどこにゲストのチェックを入れればよいかを説明してください。
2. ブランチを切って、`definePrototype()` に自作のページを指す `notFoundPage` を追加し、プロトタイプで `/announcements/99` を開いてください。次に、そのページコンポーネントを削除して `bun run typecheck` を実行してください。何がこの誤りを検出しましたか。同じ誤りをコントローラーでした場合も、同じ段階で検出されたでしょうか。

## あらためて、おわりに

これがこのコースで作る最後の機能で、いつもとは逆の順序で作りました。月曜に顧客がクリックできるリンクを渡し、水曜にはその裏にバックエンドを実装し、その間に顧客が見た画面は一切書き直していません。この章で省いた内容は[プロトタイプファーストガイド](../guides/prototype-first.md)にあります。ホストごとの設定、サブパスでのビルド、favicon のためのシェルの差し替え、ブラウザのランタイムでは再現されない挙動の一覧などです。
