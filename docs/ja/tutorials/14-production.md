# 第 14 章: 本番

13 章ぶん進んで、このブログはまだ一度もあなたのマシンから出ていません。この章が残りを運びます。再起動を生き延びるセッションストア、見知らぬ誰かがパスワードを推測できる速さの上限、ただで手に入る本番用のスイッチ、そしてまだ準備できていないものの正直な一覧です。

ここにはエージェントに渡すスライスがありません。残っているのはあなた自身のアプリについての判断であり、判断とは、この仕事のうち委ねられない部分だからです。

**この章で学ぶこと:**

- アプリのどのストアがメモリ上にあるのか、そしてそのうちのどれがバグなのか
- レート制限をどこに置くのか、そして 2 つのリミッターにひとつの予算を分け合わせてしまう間違い
- `NODE_ENV=production` が何を変えてくれて、何をあなたに残すのか
- 第 1 章で渡された CI のファイルが、ずっと何を実行してきたのか
- このアプリのためのチェックリスト。この章では直せない部分も含めて

## 1. このプロセスの中で暮らしている 2 つのストア

サインインして、開発サーバーを再起動して、リロードします。サインアウトしています。セッションは第 5 章からずっと `Map` の中にありました。開発者ひとりならそれで構いませんが、それ以外のすべてには間違っています。デプロイのたびに全員をまとめてサインアウトさせ、2 つ目のコンテナをコイン投げにしてしまうからです。

データベースはすでにプロセスより長生きするので、そちらに置きます。セッションにはテーブルが要り、そしてカラム名がストアの契約です。

```ts file=db/schema.ts
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
```

```bash run
bun run db:make create_sessions
```

```bash run
bun run db:migrate
```

テーブルが増えたということは ER のビューが古くなったということで、第 13 章のゲートがまさにそう言おうとしています。誰かが気づいてからではなく、変更と一緒に生成し直してください。

```bash run
bunx guren spec:generate
```

では配線です。ついでに、このファイルにいるうちにもうひとつ。パスワードを受け取るアプリが、誰かに毎分 1000 回それを試させてよいはずがありません。

```ts file=src/app.ts
// Every zod schema built after this import parses through a compiled fast
// path. Keep it the first import so it runs before any module that defines
// schemas. It honors z.config({ jitless: true }) for CSP-restricted runtimes
// and never throws — unsupported schemas keep the regular parser. One caveat:
// on invalid input, refinements/transforms can run twice (fast path, then
// fallback), so keep .refine()/.transform() free of side effects.
import 'zod/compile'
import { createApp } from '@guren/core'
import { DatabaseSessionStore, createRateLimitMiddleware, setInertiaDocument } from '@guren/core'
import DatabaseProvider from '../app/Providers/DatabaseProvider.js'
import AuthProvider from '../app/Providers/AuthProvider.js'
import { registerWebRoutes } from '../routes/web.js'
import { sessions } from '../db/schema.js'
import { StorageServiceProvider as CoreStorageServiceProvider } from '@guren/core'
import StorageProvider from '../app/Providers/StorageProvider.js'
import AttachmentsProvider from '../app/Providers/AttachmentsProvider.js'
import { EventServiceProvider as CoreEventServiceProvider } from '@guren/core'
import EventProvider from '../app/Providers/EventProvider.js'
import { QueueServiceProvider as CoreQueueServiceProvider } from '@guren/core'
import QueueProvider from '../app/Providers/QueueProvider.js'
import { MailServiceProvider as CoreMailServiceProvider } from '@guren/core'
import MailProvider from '../app/Providers/MailProvider.js'

// Rendered into every server-rendered document. Replace public/favicon.svg
// with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
setInertiaDocument({
  head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
})

// The Host header is client-controlled, so production should answer only to the
// host this app is deployed as, which APP_URL carries.
//
// Read at module scope, where not every platform has populated process.env yet
// (the Cloudflare worker imports this module before wrangler `vars` land). A
// missing value therefore warns and leaves the check off, rather than throwing
// and stopping the app from booting at all. Emailed links do not depend on this
// — app/Auth/AppUrl.ts resolves those per request and fails closed there.
function hostAuthorization() {
  const exclude = ['/health']

  if (process.env.NODE_ENV !== 'production') {
    return { allowedHosts: ['localhost:*', '127.0.0.1:*'], exclude }
  }

  const appUrl = process.env.APP_URL?.trim()
  if (!appUrl) {
    console.warn('[app] APP_URL is not set — host authorization is disabled. Set it to the public base URL of this app.')
    return false
  }

  // `hostname:*` rather than the bare host: the hostname is the security
  // boundary, and a proxy may or may not include the default port in `Host`.
  return { allowedHosts: [`${new URL(appUrl).hostname}:*`], exclude }
}

const app = createApp({
  routes: registerWebRoutes,
  providers: [DatabaseProvider, AuthProvider, CoreStorageServiceProvider, StorageProvider, AttachmentsProvider, CoreEventServiceProvider, EventProvider, CoreQueueServiceProvider, QueueProvider, CoreMailServiceProvider, MailProvider],
  auth: {
    sessionOptions: {
      // Sessions in the database, not in this process: a restart, a second
      // container, or a deploy would otherwise sign everybody out.
      store: new DatabaseSessionStore(sessions),
    },
  },
  // Translations live in lang/<locale>/*.json. Add locales to `supported`
  // and the request locale is detected from ?locale=, a locale cookie, or
  // Accept-Language. `guren codegen` types the keys for t()/useTranslation().
  i18n: { supported: ['en'] },
  hostAuthorization: hostAuthorization(),
})

// One shared counter per prefix, so the two limiters cannot spend each other's
// budget: the default store is a single module-level map keyed by prefix.
app.use('*', createRateLimitMiddleware({
  limit: 300,
  windowMs: 60_000,
  keyPrefix: 'rl:web:',
  trustProxy: process.env.NODE_ENV === 'production',
  skip: (ctx) => ctx.req.path === '/health',
}))

app.use('/login', createRateLimitMiddleware({
  limit: 5,
  windowMs: 15 * 60_000,
  keyPrefix: 'rl:login:',
  trustProxy: process.env.NODE_ENV === 'production',
  message: 'Too many sign-in attempts. Try again in a few minutes.',
}))

export default app
```

どちらの変更もメモリについてのものですが、同じ種類の変更ではありません。

セッションストアは移す必要がありました。メモリ上のセッションとは、再起動が壊してしまうセッションであり、2 つのプロセスが合意できないセッションだからです。

レートリミッターのストアは、そうではありません。`createRateLimitMiddleware` は既定でメモリ上のカウンターを使い、これはプロセスごとの予算です。コンテナがひとつなら正しく、2 つ動かした瞬間に間違いになります。それぞれが満額の許容量を与えてしまうからです。その場合は Redis のストアに差し替えればよく、ほかは何も変わりません。プロセスがひとつでも効いてくるのは `keyPrefix` のほうです。既定のストアはすべてのリミッターが共有するひとつのマップなので、別々のプレフィックスを持たない 2 つのリミッターは互いの予算を使い合い、ブログへの 5 リクエストでサインインページがロックされてしまいます。

もう 1 行、2 度読む価値があるのが `trustProxy` です。オフなら、リミッターはソケットのアドレスをキーにします。ロードバランサーがあればそれはロードバランサーのアドレスなので、訪問者全員がひとつのバケツを共有します。オンなら `X-Forwarded-For` とその仲間たちを読みますが、これはどのクライアントでも送れるので、それらを上書きするプロキシの背後でしか安全ではありません。どちらの場所でも正しいという設定は無く、だからこれは既定値ではなく決定なのです。

```bash run
bun test
```

緑です。そしてテストが作るセッションは、いまやテーブルを通ります。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: database sessions and rate limiting"
```

## 2. 本番モード

クライアントのアセットをビルドして、それからサーバーがするようにアプリを動かします。

```bash run
bun run build
```

```bash run background
bun run preview
```

`preview` は `NODE_ENV=production bun bin/serve.ts` です。この変数ひとつが、そうでなければあなたが覚えておかなければならない 6 つのことを変えます。

- **セッションと CSRF の cookie に `Secure` が付き**、HTTPS の上でしか運ばれなくなります。
- **HSTS** が 1 年ぶん送られます。
- **スタックトレースが止まります。** 処理されなかったエラーは、第 2 章からずっと読んできたデバッグページではなく、素の 500 になります。
- **開発用のエンドポイントはマウントを拒みます。** あなたのエディターが話しかける MCP エンドポイントも docs ビューアーも、`NODE_ENV !== 'production'` と、それぞれ自前の環境変数フラグの*両方*で門番されています。どちらも、変数を設定して本番で有効にすることはできません。
- **アセットは `public/assets/` から来ます。** Vite からではなく、ビルドが書いたマニフェストとともに。
- **ポートが歩きません。** 開発中はポートが埋まっているとサーバーが次のポートを試しますが、本番では代わりに失敗します。黙って移動するサーバーとは、ロードバランサーが見つけられないサーバーだからです。

もうひとつ変わるものがあり、これは驚くはずです。バナーが消えます。本番の起動は何ひとつ出力しません。代わりにアプリに尋ねてください。

```bash manual
curl -s localhost:3333/health
{"status":"ok"}
```

このルートは第 1 章からずっと `routes/web.ts` にあり、これから生成する `fly.toml` はヘルスチェックをそこに向けます。そして `hostAuthorization()` が除外している唯一のパスでもあります。これは見た目より重要です。本番のアプリは `APP_URL` が指すホストにしか応答せず、IP で叩きに来るロードバランサーはそのホストではありません。ヘルスチェックは、他の全員を拒んでいるサーバーに届く必要があります。

**チェックポイント:** `localhost:3333` でブログを開き、サインインして、サーバーを再起動してください。サインインしたままです。セッションがいまや行だからです。

## 3. すでに持っていた CI

第 1 章はワークフローのファイルを雛形生成し、あなたはそれ以来それを見ていません。いま読んでください。

```bash run
cat .github/workflows/ci.yml
```

ジョブがひとつ、コマンドがひとつ。`bunx guren gate --deps` です。これはあなたが毎章の終わりに実行してきたのと同じゲートに、`--deps` が付いたものです。このフラグは、レジストリに対する依存関係の脆弱性スキャンを足します。ほかに設定するものは何も無く、13 章ぶんローカルで実行してこなかったものも何ひとつありません。

この儀式の意味は、まるごとそこにあります。章が終わったと告げるコマンドが、プルリクエストがマージできるかどうかを決めるコマンドなので、この 2 つが「完了」の意味について食い違うことは決してありません。

ブランチを push して、動くところを見てください。`--deps` で赤くてローカルでは緑なら、依存関係のどれかに公開されたアドバイザリがあります。`bun audit` が挙げる名前を読んで、フラグを外すのではなくその依存関係を上げてください。

## 4. 正直なチェックリスト

以下はすべて、いまあなたが持っているアプリについて本当のことです。すでに済んでいる行もあれば、1 行で済む行も、どこかのアカウントが要る行もあります。

| 項目 | いまどうなっているか | 本番が求めるもの |
|---|---|---|
| セッション | 第 1 節以降、データベースの中 | 済み |
| レート制限 | メモリ上、プロセスごと | コンテナがひとつなら十分。複数なら `RedisRateLimitStore` |
| cookie、HSTS、エラーページ | `NODE_ENV=production` のもとで自動 | 済み |
| `APP_KEY` | `.env` の中。これはコミットされない | プラットフォームのシークレットとして設定する。さもないとコンテナは鍵を持たずに起動する |
| `APP_URL` | 未設定 | 設定する。さもないとホスト認可はオフのままで、警告が出る |
| アップロード | コンテナの中の `local` ディスク上 | S3 か R2 のディスク。さもないとデプロイのたびに失われる |
| キュー | `sync`: ジョブはリクエストの中で走る | Redis か SQS のドライバーと、2 つ目のプロセスとしての `guren queue:work` |
| メール | `log`: サーバーの出力に印字される | 本物のトランスポートと、その資格情報 |
| データベース | SQLite、ファイルひとつ | マシンがひとつなら十分。複数動かすなら Postgres |
| エージェントのツール | テストの中からしか届かない | 第 12 章の MCP プラグインと、トークンストア |

そのうちの 2 行は、行ではなく警告に値します。

**Dockerfile は `storage/` をコピーしません。** 第 1 章がこれを生成したのはアプリにアップロードが入る前で、そこには当時知っていたディレクトリだけが並んでいます。そこからビルドしたコンテナは空の添付ファイルディスクで起動するので、デプロイのたびにカバー画像がひとつ残らず黙って失われます。`storage` をコピー対象のディレクトリに足してその上にボリュームをマウントするか、ディスクをオブジェクトストレージへ移してください。この章があなたに返す答えは後者です。

**`guren doctor` は、このどれについても警告しません。** 本番ストアのチェックが走るのはサーバーレスのデプロイプラグインを検出したときだけなので、Docker や Fly へのデプロイでは、セッションがメモリ上にあるまま pass を報告します。このチェックは嘘をついているのではありません。あなたが尋ねているものより狭い問いに答えているだけです。

残る 2 つのターゲット向けのデプロイのレシピです。それぞれが何を前提にしているのかを読めるように。

```bash run
bunx guren deploy --target all --app my-blog --force
```

第 1 章の `Dockerfile` に `fly.toml` と `railway.json` が加わります。`--force` があるのは、そのファイルがすでに存在するからです。これが無いと、コマンドはあなたが編集したかもしれないものを上書きせずに止まります。ここにプラットフォームと話すものはひとつもありません。これらはファイルであって、アカウントが要るのは `fly deploy` や `railway up` のほうです。

```bash manual
docker build -t my-blog .
docker run --rm -p 3333:3333 -e APP_KEY="$APP_KEY" -e APP_URL=http://localhost:3333 my-blog
```

## 5. ハーネスを最新に保つ

フレームワークは動いていきますし、第 1 章でそれがインストールしたハーネスも同じです。アップグレードのあとは、変わってしまう前に、何が変わるのかを尋ねてください。

```bash run
bunx guren agent:sync --dry-run
```

何を書き、何を置き換え、管理下のディレクトリの中で何がもうハーネスの一部ではなくなったのかを報告します。あなた自身が書いたファイルには決して触れません。第 8 章であなたが書いた rule や skill はあなたのものであり、sync が自分のものだと主張するのは、自分が配ったものだけです。

アップグレードそのものはレジストリを必要とするので、この章のスクリプトには入っていません。

```bash manual
bunx guren upgrade --install
bunx guren agent:sync
bunx guren codegen --force
bun run typecheck
bunx guren gate
```

`upgrade` は `@guren/*` のバージョンをすべて揃え、ORM のものと一致していなければならない Drizzle のピンも揃え、そのリリース向けの codemod を適用し、上の 3 つのコマンドを自分の次の手順として印字します。ゲートは前ではなく、あとで実行してください。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "chore: deploy recipes for fly and railway"
```

## いまいる場所

あなたの手元には、ユーザー、投稿、コメント、タグ、アップロード、メール、エージェントのツール、そしてドリフトできないドキュメントを備えたブログがあります。それは本番モードで、自分より長生きするデータベースを相手に動いており、ローカルでも CI でも同じ 6 つのステージを実行するゲートの背後にあります。

それ以上に、あなたには仕事のやり方が手に入りました。ここのどの章も、同じ 4 つの手順でした。新しい考えを、理解できるまで手で組む。次に来るものを告げる、失敗するテストを書く。そのスライスを、rubric と決定的なフォールバックとともにエージェントへ渡す。そして、それがうまくいったかどうかを `guren gate` に決めさせる。このうちフレームワークの担当はゲートとハーネスです。あなたの担当は最初の 2 手順で、そしてこれは、タイピングが速くなっても楽にはならないほうです。

## よくあるつまずき

- **デプロイのあとで全員がサインアウトしている。** セッションストアがまだメモリ上にあるか、新しいコンテナが別の `APP_KEY` を持っています。どちらも第 1 節と第 4 節にあります。
- **レートリミッターが間違ったものをブロックする。** 2 つのリミッターがカウンターを共有しています。それぞれに別々の `keyPrefix` を与えてください。
- **訪問者全員がひとつのレート制限のバケツを共有している。** キーがソケットのアドレスで、前段にプロキシがいます。`trustProxy` を設定してください。ただし、そのプロキシがクライアントのヘッダーを上書きする場合に限ります。
- **`bun run preview` が何も出力しない。** それで正しいのです。バナーは開発時のものです。起動しているかどうかは `/health` に尋ねてください。
- **`bun run preview` がポートの使用中で失敗する。** 本番は次のポートへ歩きません。ポートを空けるか、`PORT` を設定してください。
- **preview でアセットが 404 になる。** 最後の変更のあとに `bun run build` が走っていません。マニフェストが無いか、古くなっています。
- **CI が `--deps` でだけ赤い。** 依存関係のどれかにアドバイザリがあります。フラグを外すのではなく、それを上げてください。

## おわりに

これでコースは終わりです。このアプリはもうあなたのものですし、それを作るのを助けたハーネスも同じです。rule、skill、subagent の brief、チェック、そしてゲート。次の機能は、最後の機能を足したのと同じやり方で足してください。そして間違えたなら、ほかの誰かより先にテストがそう言ってくれます。
