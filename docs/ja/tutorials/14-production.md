# 第 14 章: 本番

13 章かけて作ってきたブログは、まだ一度も手元のマシンの外で動いていません。この章で本番に出すところまで進めます。扱うのは、再起動しても消えないセッションストア、第三者がパスワードを総当たりできる速さの制限、設定しなくても有効になる本番向けの切り替え、そしてまだ準備が足りない点の一覧です。

この章ではエージェントに任せる部分がありません。残っているのはこのアプリをどう運用するかの判断で、そこは人が決めるしかないからです。

**この章で学ぶこと:**

- アプリのどのストアがメモリ上にあり、そのうちどれがバグにあたるのか
- レート制限を置く場所と、2 つのリミッターが 1 つの上限を共有してしまう間違い
- `NODE_ENV=production` で自動的に変わることと、別途対応が要ること
- 第 1 章で生成された CI のファイルが、これまで何を実行していたか
- このアプリ向けのチェックリスト(この章では直せない項目も含む)

## 1. プロセスのメモリにある 2 つのストア

サインインしてから開発サーバーを再起動し、ページをリロードしてみてください。サインアウトされているはずです。セッションは第 5 章からずっと `Map` の中に保存されていました。開発者が 1 人で使うぶんには問題ありませんが、それ以外の場面では不具合になります。デプロイするたびに全員がサインアウトされ、コンテナを 2 つにすると、どちらに振り分けられたかでサインイン状態が変わってしまいます。

データベースはもともとプロセスが終わっても残るので、セッションもそこに保存します。セッション用のテーブルを作り、そのカラム名をストアが前提とする名前に合わせます。

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

テーブルが増えたので ER のビューが古くなり、このままだと第 13 章で入れたゲートに指摘されます。誰かに気付かれる前に、変更と一緒に生成し直しておきます。

```bash run
bunx guren spec:generate
```

次はアプリへの組み込みです。このファイルを開いたついでに、もう 1 つ設定を足します。パスワードを受け付けるアプリで、誰かが毎分 1000 回も試せる状態は避けるべきです。

```ts file=src/app.ts
// Every zod schema built after this import parses through a compiled fast
// path. Keep it the first import so it runs before any module that defines
// schemas. It honors z.config({ jitless: true }) for CSP-restricted runtimes
// and never throws — unsupported schemas keep the regular parser. One caveat:
// on invalid input, refinements/transforms can run twice (fast path, then
// fallback), so keep .refine()/.transform() free of side effects.
import 'zod/compile'
import { createApp } from '@guren/core'
import { DatabaseSessionStore, createRateLimitMiddleware } from '@guren/core'
import AuthProvider from '../app/Providers/AuthProvider.js'
import database from '../config/database.js'
import env from '../config/env.js'
import http from '../config/http.js'
import { registerWebRoutes } from '../routes/web.js'
import { sessions } from '../db/schema.js'
import storage from '../config/storage.js'
import AttachmentsProvider from '../app/Providers/AttachmentsProvider.js'
import { EventServiceProvider as CoreEventServiceProvider } from '@guren/core'
import EventProvider from '../app/Providers/EventProvider.js'
import queue from '../config/queue.js'
import JobsProvider from '../app/Providers/JobsProvider.js'
import mail from '../config/mail.js'

const app = createApp({
  // Rendered into every server-rendered document. Replace public/favicon.svg
  // with your own artwork, or add more tags here (Open Graph, apple-touch-icon).
  inertia: {
    document: {
      head: '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    },
  },
  env,
  config: [database, http, storage, queue, mail],
  routes: registerWebRoutes,
  providers: [AuthProvider, AttachmentsProvider, CoreEventServiceProvider, EventProvider, JobsProvider],
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

どちらもメモリに関わる変更ですが、性質は異なります。

セッションストアは移す必要がありました。メモリ上のセッションは再起動で消えてしまい、プロセスが 2 つあれば内容が食い違うからです。

一方、レートリミッターのストアはメモリ上のままにしています。`createRateLimitMiddleware` は既定でメモリ上のカウンターを使うので、上限はプロセスごとに数えられます。コンテナが 1 つならこれで正しく動きますが、2 つ動かすと、それぞれが上限いっぱいまで許可してしまいます。その場合は Redis のストアに差し替えるだけで済み、ほかの変更は要りません。

プロセスが 1 つでも気を付けるべきなのは `keyPrefix` です。既定のストアは全リミッターで共有する 1 つのマップです。そのためプレフィックスを分けないと 2 つのリミッターが同じカウンターを消費し合い、ブログに 5 回アクセスしただけでサインインページがロックされてしまいます。

もう 1 つ、注意して読んでほしいのが `trustProxy` の行です。オフの場合、リミッターはソケットのアドレスをキーにします。前段にロードバランサーがあるとそのアドレスになるため、訪問者全員が同じカウンターを共有してしまいます。オンの場合は `X-Forwarded-For` などのヘッダーを読みます。ただしこれらはどのクライアントでも送れるので、プロキシがヘッダーを上書きしてくれる構成でしか安全に使えません。どちらの環境でも正しい設定というものは無いため、既定値に任せず、環境に合わせて判断する必要があります。

```bash run
bun test
```

テストはすべて通ります。テストで作られるセッションも、いまはテーブルに保存されています。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "feat: database sessions and rate limiting"
```

## 2. 本番モード

先に `bun run dev` を止めてください(実行中のターミナルで Ctrl-C)。前の章で起動した開発サーバーが、3333 番ポートを使ったままになっています。開発サーバーはポートが埋まっていると次の空きポートに移りますが、本番のサーバーは移らずにそのまま終了します。

```bash run stop-background
# Ctrl-C in the terminal running bun run dev
```

クライアントのアセットをビルドし、本番のサーバーと同じ方法でアプリを起動します。

```bash run
bun run build
```

```bash run background
bun run preview
```

`preview` の中身は `NODE_ENV=production bun bin/serve.ts` です。この変数 1 つで、本来なら覚えておいて手で設定しなければならない 6 つの項目が切り替わります。

- **セッションと CSRF の cookie に `Secure` が付き**、HTTPS 経由でしか送られなくなります。
- **HSTS** ヘッダーが有効期間 1 年で送られます。
- **スタックトレースが表示されなくなります。** 処理されなかったエラーは、開発時に返っていた例外名とスタックトレース入りの JSON ではなく、ただの 500 のページになります。
- **開発用のエンドポイントはマウントされません。** エディターが接続する MCP エンドポイントも docs ビューアーも、`NODE_ENV !== 'production'` とそれぞれ専用の環境変数フラグの*両方*を満たしたときだけ有効になります。本番では、変数を設定してもどちらも有効にできません。
- **アセットは `public/assets/` から配信されます。** Vite ではなく、ビルドが書き出したマニフェストを使います。
- **ポートが埋まっていても別のポートに移りません。** 開発中はポートが使用中ならサーバーが次のポートを試しますが、本番では起動に失敗します。黙って別のポートで起動したサーバーには、ロードバランサーが接続できないからです。

もう 1 つ、意外なところも変わります。起動時のバナーが消え、本番では `[guren] Listening on http://0.0.0.0:3333` の 1 行しか出力されません。リクエストに応答するかどうかは、アプリに問い合わせて確かめます。

```bash manual
curl -s localhost:3333/health
{"status":"ok"}
```

このルートは第 1 章から `routes/web.ts` にあり、このあと生成する `fly.toml` もヘルスチェックの宛先にこのルートを指定します。また、`config/http.ts` がホスト認可の対象から外している唯一のパスでもあります。これは見た目以上に重要です。本番のアプリは `APP_URL` に指定したホスト宛てのリクエストにしか応答しませんが、IP アドレスで問い合わせてくるロードバランサーはそのホストを名乗りません。ほかのリクエストをすべて拒否しているサーバーでも、ヘルスチェックだけは通す必要があります。

**チェックポイント:** `localhost:3333` でブログを開いてサインインし、サーバーを再起動してください。セッションがテーブルの行として保存されているので、サインインしたままになっています。

## 3. 第 1 章からある CI

第 1 章でワークフローのファイルが生成されていますが、その後は開いていないはずです。ここで中身を確認します。

```bash run
cat .github/workflows/ci.yml
```

ジョブが 1 つあり、実行するコマンドも `bunx guren gate --deps` の 1 つだけです。毎章の最後に実行してきたゲートに `--deps` を付けたもので、このフラグでレジストリの情報をもとにした依存関係の脆弱性スキャンが加わります。ほかに設定するものはなく、13 章にわたってローカルで実行してこなかった処理も含まれていません。

毎章ゲートを実行してきたのは、まさにこのためです。章の完了を判定するコマンドが、そのままプルリクエストをマージできるかの判定にも使われるので、「完了」の基準が 2 つの場面で食い違うことはありません。

ブランチを push して、CI が実行されるのを確認してください。ローカルでは通るのに `--deps` で失敗する場合は、依存パッケージのどれかにセキュリティアドバイザリが公開されています。`bun audit` が挙げるパッケージ名を確認し、フラグを外すのではなく、そのパッケージのバージョンを上げてください。

## 4. いまの状態を確かめるチェックリスト

次の表は、いま手元にあるアプリの実際の状態です。対応済みの項目もあれば、1 行の変更で済む項目や、外部サービスのアカウントが必要な項目もあります。

| 項目 | 現在の状態 | 本番で必要な対応 |
|---|---|---|
| セッション | 第 1 節からデータベースに保存 | 対応済み |
| レート制限 | メモリ上でプロセスごとに集計 | コンテナが 1 つなら十分。複数なら `RedisRateLimitStore` |
| cookie、HSTS、エラーページ | `NODE_ENV=production` で自動的に有効 | 対応済み |
| `APP_KEY` | コミットされない `.env` にある | プラットフォームのシークレットとして設定する。設定しないとコンテナは鍵なしで起動する |
| `APP_URL` | `.env` の `http://localhost:3333`。`NODE_ENV=production` では `localhost` 宛てにしか応答せず、`127.0.0.1:3333` へのリクエストは 403 になる | 公開 URL を設定する。本番では必須なので、未設定だとアプリが起動しない |
| アップロード | コンテナ内の `local` ディスクに保存 | S3 か R2 のディスクに移す。移さないとデプロイのたびに消える |
| キュー | `sync`: ジョブはリクエストの処理中に実行される | Redis か SQS のドライバーを使い、`guren queue:work` を別プロセスで動かす |
| メール | `log`: サーバーの出力に書き出されるだけ | 実際に送信するトランスポートと、その認証情報 |
| データベース | SQLite のファイル 1 つ | マシンが 1 台なら十分。複数台で動かすなら Postgres |
| エージェントのツール | テストからしか呼べない | 第 12 章の MCP プラグインとトークンストア |

このうち 2 つは、表の 1 行で済ませず、はっきり注意しておくべき項目です。

**Dockerfile は `storage/` をコピーしません。** Dockerfile は第 1 章で、アプリにアップロード機能を入れる前に生成したものなので、当時あったディレクトリしか含まれていません。このままビルドしたコンテナは添付ファイルのディスクが空の状態で起動するため、デプロイのたびにカバー画像がすべて、何の警告もなく消えます。コピー対象のディレクトリに `storage` を加えてボリュームをマウントするか、ディスクをオブジェクトストレージに移してください。この章としては後者をおすすめします。

**`guren doctor` はこれらのどれについても警告しません。** 本番向けストアのチェックは、サーバーレス用のデプロイプラグインを検出したときにしか実行されません。そのため Docker や Fly にデプロイする場合は、セッションがメモリ上にあっても `pass`(合格)と報告されます。このチェックは、確かめたい内容より狭い範囲しか見ていないということです。

残る 2 つのデプロイ先向けに、設定ファイルを生成します。それぞれ何を前提にしているかを読んでおいてください。

```bash run
bunx guren deploy --target all --app my-blog --force
```

第 1 章の `Dockerfile` に加えて、`fly.toml` と `railway.json` が生成されます。`--force` を付けているのは、`Dockerfile` がすでにあるからです。付けないと、手を加えたかもしれないファイルを上書きしないようにコマンドが止まります。このコマンドはプラットフォームとは一切通信せず、ファイルを生成するだけです。アカウントが必要になるのは `fly deploy` や `railway up` を実行するときです。

Docker が入っていれば、イメージを手元で動かすこともできます。コンテナが公開する 3333 番ポートを preview が使っているので、先に `bun run preview` を止めてください。

```bash run stop-background
# Ctrl-C in the terminal running bun run preview
```

```bash manual
docker build -t my-blog .
docker run --rm -p 3333:3333 -e APP_KEY="$APP_KEY" -e APP_URL=http://localhost:3333 my-blog
```

## 5. ハーネスを最新に保つ

フレームワークは更新されていき、第 1 章でインストールしたハーネスにも新しい版が出ます。アップグレードしたら、実際にファイルを書き換える前に、何が変わるかを確認します。

```bash run
bunx guren agent:sync --dry-run
```

新しく書くファイル、置き換えるファイル、管理対象のディレクトリにあってもうハーネスに含まれないファイルが報告されます。手で書いたファイルには手を付けません。第 8 章で書いたルールやスキルはアプリ側のもので、sync が管理するのは sync 自身が配布したファイルだけです。

アップグレード自体はレジストリへのアクセスが必要なので、この章で実行する手順には含めていません。

```bash manual
bunx guren upgrade --install
bunx guren agent:sync
bunx guren codegen --force
bun run typecheck
bunx guren gate
```

`upgrade` は `@guren/*` のバージョンをすべて揃え、ORM と一致させる必要がある Drizzle の固定バージョンも合わせたうえで、そのリリース向けの codemod を適用します。最後に、上の 3 つのコマンドを次の手順として表示します。ゲートはアップグレードの前ではなく、後に実行してください。

```bash run
bunx guren gate
```

```bash run
git add -A
git commit -m "chore: deploy recipes for fly and railway"
```

## ここまでの状態

ユーザー、投稿、コメント、タグ、アップロード、メール、エージェントのツールに加えて、コードと食い違うことのないドキュメントまで備えたブログができました。本番モードで動き、データはプロセスが終わっても残るデータベースに保存されます。変更はすべて、ローカルでも CI でも同じ 6 つのステージを実行するゲートを通ります。

そして、アプリ以上に大事な開発の進め方も身に付きました。どの章も同じ 4 つの段取りで進めています。新しい概念を、理解できるまで手で組み立てる。次に作るものを示す、失敗するテストを書く。その部分を、確認項目と、毎回同じ結果になるフォールバックを添えてエージェントに渡す。うまくいったかどうかは `guren gate` で判定する。このうちゲートとハーネスはフレームワークが受け持ちます。読者が担うのは最初の 2 つで、こちらはタイピングが速くなっても楽にはなりません。

## よくあるつまずき

- **`db:migrate` が `table sessions already exists` で失敗する。** 第 6 章の `add auth` の比較を、開発サーバーを動かしたまま試した場合に起きます。そのときのリロードで `add auth` 自身の `sessions` マイグレーションが適用され、その後の `git clean` ではフォルダだけが消えてテーブルが残りました。`bun run db:status` を実行すると、そのマイグレーションは `orphaned`(孤立)と表示されます。`bun run db:reset` を実行すれば、この章の分も含めて手元のマイグレーションからデータベースを作り直せます。ただし、その際に行はすべて削除されます。
- **デプロイ後に全員がサインアウトされている。** セッションストアがまだメモリ上にあるか、新しいコンテナの `APP_KEY` が以前と違っています。それぞれ第 1 節と第 4 節で扱っています。
- **レートリミッターが関係のないリクエストをブロックする。** 2 つのリミッターがカウンターを共有しています。それぞれに別の `keyPrefix` を指定してください。
- **訪問者全員が 1 つのレート制限を共有している。** ソケットのアドレスをキーにしていて、前段にプロキシがあります。`trustProxy` を設定してください。ただし、プロキシがクライアントから来たヘッダーを上書きする構成の場合に限ります。
- **`bun run preview` が `Listening on` の 1 行しか出力せず、バナーが出ない。** これは正しい動作です。バナーは開発時だけのものなので、アプリが応答するかどうかは `/health` で確かめてください。
- **`bun run preview` が `Failed to start server. Is port 3333 in use?` で失敗する。** たいていは `bun run dev` がまだ動いています。本番では次のポートに移らないので、もう一方のサーバーを止めるか、`PORT` を設定してください。
- **preview でアセットが 404 になる。** 最後の変更のあとに `bun run build` を実行していないため、マニフェストが無いか古くなっています。
- **CI が `--deps` のときだけ失敗する。** 依存パッケージのどれかにアドバイザリが出ています。フラグを外さずに、そのパッケージのバージョンを上げてください。

## 演習

1. `APP_URL` を設定しないまま `bun run preview` を起動し、アプリが知らないホスト名を `Host` ヘッダーに入れてホームページにリクエストしてください。次に `APP_URL` を設定して、同じリクエストを送ってください。それぞれ何が起きますか。また、うっかりそのまま本番に出してしまうとしたら、どちらのほうがまだましですか。
2. 第 1 章の `Dockerfile` は `storage/` をコピーしません。本文で挙げた 2 つの対処のどちらかを選んで適用し、選んだ理由を 1 段落の ADR に書いてください。どちらを選んだ場合も、代わりに何を諦めたのかを書き添えてください。

<details>
<summary>演習 1: ヒントと答えの例</summary>

実行する前に、`config/env.ts` の `APP_URL` と `config/http.ts` の `hostAuthorization` を読んでください。値を未設定にするには、`.env` のその行をコメントアウトします。送るリクエストは次のとおりです。

```bash
curl -i -H 'Host: attacker.example' http://localhost:3333/
```

`APP_URL` が未設定だと(空の値も未設定として扱われます)、読むべき応答がそもそも返りません。`config/env.ts` が `APP_URL: Env.url().requiredInProduction()` と宣言しているので、`NODE_ENV=production` では起動が止まり、`APP_URL` が必須なのに設定されていないというエラーが出ます。`curl` は接続できません。ホストの認可をオフにする `config/http.ts` の `false` の分岐に、到達しないというコメントが付いているのはこのためです。`APP_URL=http://localhost:3333` を設定すると、アプリはどのポートでも `localhost` にだけ応答します。知らない `Host` には 403 が返り、`-H 'Host: localhost:3333'` を付けた同じリクエストにはページが返ります。どちらも安全側に倒れる挙動で、うっかり本番に出すならこちらです。避けたいのは、どんな `Host` にも応答するアプリです。そのヘッダーはクライアントが送ってきた値にすぎないからです。

</details>

<details>
<summary>演習 2: ヒントと答えの例</summary>

イメージに入るディレクトリは、`Dockerfile` の本番ステージにある `COPY --from=builder` の行と、builder ステージの `mkdir -p` の行で決まります。オブジェクトストレージは `config/storage.ts` のディスクで、`config/attachments.ts` の `disk` がそれを指します。

ボリュームを使う場合: builder の `mkdir -p` に `storage` を足し、`COPY --from=builder /app/storage ./storage` の行を加えます。そのうえで `/app/storage` に永続ボリュームをマウントします(`fly.toml` の `[mounts]` セクション、手元なら `docker run -v blog-storage:/app/storage`)。諦めるのは、複数台のマシンで動かすことです。ファイルが 1 つのボリュームにしかないからです。バックアップも自分の仕事になり、`bunx guren deploy --force` で `Dockerfile` を作り直すと追加した行は消えます。

オブジェクトストレージを使う場合: [ストレージのガイド](../guides/storage.md) のとおりに `s3` ディスクを追加し、そのキーを `config/env.ts` で宣言します。`disk` をそのディスクに向け、`disks` で `'private'` にします。諦めるのは、アカウントなしで動く構成です。バケット、プラットフォームのシークレットに置く認証情報、そして請求が必要になります。切り替える前に保存したカバー画像は `local` に残ります。添付ファイルの各行が自分のディスクを記録しているからです。

どちらを選んでも、ファイルは `bunx guren make:adr` で作れます。段落には、選ばなかったほうの案とその理由を書きます。どちらの選択にも十分な理由があります。

</details>

## おわりに

これでこのコースは終わりです。アプリも、その開発を支えたハーネス(ルール、スキル、サブエージェントの指示書、チェック、ゲート)も、ここからは読者自身のものです。次の機能も、これまでと同じやり方で加えていってください。どこかで間違えても、ほかの誰かが気付くより先にテストが教えてくれます。

## 逆の順序でもう 1 つ作る

[第 15 章: プロトタイプファースト](./15-prototype-first.md)はエピローグです。最後にもう 1 つ、今度はバックエンドを後回しにして機能を作ります。まず画面を作り、サーバー無しの静的ファイルとしてホストして顧客に触ってもらいます。顧客の了承が得られたら、同じコードのままバックエンドを作ります。
