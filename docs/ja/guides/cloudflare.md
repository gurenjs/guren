# Cloudflare Workers へのデプロイ

`@guren/plugin-cloudflare` を使うと、Guren を Cloudflare Workers 上で動かせます。データベースには D1 を使います。このガイドでは、まっさらなアカウントからデプロイが終わるまでをひと通り説明します。

Workers は、常駐するサーバーとは性質の違うランタイムです。ファイルシステムがなく、リクエストの間でメモリを共有せず、CPU 時間はミリ秒単位で制限されています。このガイドの大半は、その違いのためにアプリの設定をどこで変える必要があるかの説明です。

## インストール

```bash
bunx guren plugin @guren/plugin-cloudflare
bun add @guren/plugin-cloudflare
```

プラグインを入れると `cloudflare:build` コマンドが登録され、最初のビルドで `wrangler.jsonc` が生成されます。

## ビルドとデプロイ

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

`cloudflare:build` はアプリの `build` スクリプトを実行したあと、ワーカーのエントリポイント、静的アセット、1 つのディレクトリにまとめたマイグレーションを収めた `.cloudflare/` ディレクトリを組み立てます。古いワーカーを誤ってデプロイしないように、2 つの手順を 1 つのスクリプトにまとめておいてください。

```json
{
  "scripts": {
    "cloudflare:build": "bun run build && bunx guren cloudflare:build --skip-app-build",
    "deploy:cloudflare": "bun run cloudflare:build && bunx wrangler deploy"
  }
}
```

> [!IMPORTANT]
> `.cloudflare/` は生成物です。`.gitignore` に追加し、デプロイの前に毎回作り直してください。ほかのどこからも参照されないので、中身が古くなっていても気づかないまま古いコードをデプロイしてしまいます。

アプリをビルドする前に、`guren doctor` と同じデプロイランタイムのチェックが走ります。セッションや OAuth state をプロセスのメモリに置いている、[Bun でしか読めないパスワードハッシャー](/docs/guides/authentication#パスワードハッシャー)を選んでいる、プロバイダをファイルシステムから探している、のどれかに当てはまると警告が出ます(ビルド自体は止まりません)。いずれもローカルでは動くのに Workers では動かないものです。警告は Vite の出力のあとではなく、まだ読んでいるうちに目に入る位置に出ます。

ビルドは、トップレベルか、いずれかの `env.<name>` ブロックで `"keep_names": false` を設定した `wrangler.jsonc` も受け付けません。Guren は、デプロイをまたいで残るレコードにクラス名を書き込むからです。キューに入れたジョブとイベント、保存した通知は、`static jobName`・`static eventName`・`type` ゲッターで名前を固定していなければ、クラス名をキーにして保存されます。[永続エージェント](./durable-agents.md)もクラス名で探されます。wrangler は、`keep_names` で無効にしない限り esbuild の `keepNames` を有効にしてバンドルするので、`"minify": true` を指定するだけならこれらの名前は保たれます。`keep_names` を無効にすると、minify したときにすべてのクラス名が変わります。minify しなくても、同じ名前のトップレベルクラスが 2 つあると 2 つ目の名前が変わります（`OrderShipped2`）。そうなると、前回のデプロイで書き込んだレコードを解決できなくなります。

## データベース（D1）

データベースを作り、その ID を `wrangler.jsonc` に書き込みます。

```bash
bunx wrangler d1 create my-app
```

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-app",
      "database_id": "<wrangler が出力した ID>",
      "migrations_dir": ".cloudflare/d1-migrations"
    }
  ]
}
```

`config/database.ts` で、ランタイムに応じてドライバを切り替えます。D1 は SQLite 互換なので、スキーマは SQLite のダイアレクトで書き、開発中はローカルの SQLite ファイルを使います。

```typescript
// config/database.ts
import { createD1Database, createSqliteDatabase, defineDatabaseConfig } from '@guren/core'
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'
import env from './env.js'

interface WorkersEnv {
  DB: unknown
}

const database = isWorkersRuntime()
  ? createD1Database({
      binding: () => getWorkersEnv<WorkersEnv>().DB,
      migrationsFolder: new URL('../db/migrations', import.meta.url),
    })
  : createSqliteDatabase({
      migrationsFolder: new URL('../db/migrations', import.meta.url),
      seedersFolder: new URL('../db/seeders', import.meta.url),
      // `context` はアプリの検証済み環境変数。`guren db:*` はアプリの外で動くので、スキーマを自分で解析する
      filename: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).SQLITE_DATABASE_PATH,
    })

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database

export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
```

`config/env.ts` に `SQLITE_DATABASE_PATH: Env.string().default('./data/guren.db')` を宣言し、`database` を `createApp({ config })` に加えてください。リゾルバについては [設定ガイド](./configuration.md#データベース接続) で詳しく説明しています。`getWorkersEnv` と `isWorkersRuntime` は `@guren/plugin-cloudflare/env` から import してください。パッケージのルートにはビルド用のツールも入っていて、それはワーカーのバンドルには要らないからです。

バインディングは値ではなく、値を返す関数として渡します。バインディングはリクエストが届いて初めて存在するので、読み取るのを後回しにする必要があります。

### マイグレーションの適用

Workers 上のアプリは自分でマイグレーションを実行しないので、マイグレーションはアプリの外から適用します。

```bash
bunx guren cloudflare:build          # .cloudflare/d1-migrations を再生成
bunx wrangler d1 migrations apply my-app --remote
```

> [!WARNING]
> 必ず先にビルドしてください。`migrations_dir` は生成ディレクトリの中を指しているので、ビルドする前は空です。`wrangler` は空のフォルダを見つけると「適用するマイグレーションはありません」と報告し、**エラーにならずに正常終了します**。ビルド前に適用すると、失敗しているのに成功したように見えます。

ワーカーが自分でシードを実行することもありません。`defineDatabaseConfig` がシードするのは、`seedOnBoot` が true で、しかもデータベースがマイグレーションありと報告したときだけです。`cloudflare:build` は `NODE_ENV` を `production` に固定しますし、D1 のハンドルには調べるファイルシステムがないので、マイグレーションなしと報告します。ローカルの `bun run dev` では SQLite 側が使われ、マイグレーションがあればブート時にシードします。

## セッションと OAuth state はデータベースに保存する

これは好みで選べることではありません。リクエストはそのたびに別の isolate に届く可能性があり、isolate 同士で共有できるのはデータベースだけだからです。メモリの実装のままでもローカルでは動いているように見えますが、本番ではセッションが毎回消えてしまいます。

```typescript
// config/session.ts
import { defineSessionConfig } from '@guren/core'
import { sessions } from '../db/schema.js'

export default defineSessionConfig((env) => ({
  default: env.SESSION_DRIVER,
  stores: {
    database: { driver: 'database', table: sessions },
  },
}))
```

`config/env.ts` には `SESSION_DRIVER: Env.string().default('database')` を宣言しておきます。こうすれば、デプロイ先で何も設定しなくてもデータベースのストアが使われます。

OAuth も同じです。認可画面へのリダイレクトと、そこから戻ってくるコールバックは別々の isolate に届くのが普通なので、2 つを結びつける state は共有できる場所に置かなければなりません。

```typescript
// config/oauth.ts
import { DatabaseOAuthStateStore, defineOAuthConfig } from '@guren/core'
import { oauthStates } from '../db/schema.js'

export default defineOAuthConfig(() => ({
  // `providers` は OAuth ガイドのとおり
  stateStore: new DatabaseOAuthStateStore(oauthStates),
}))
```

2 つの定義は、それを使うセッションミドルウェアの設定と一緒に `createApp()` に並べます。

```typescript
// src/app.ts
import { createApp } from '@guren/core'
import database from '../config/database.js'
import env from '../config/env.js'
import oauth from '../config/oauth.js'
import session from '../config/session.js'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  env,
  config: [database, session, oauth],
  auth: {
    autoSession: true,
    sessionOptions: { cookieSecure: true },
  },
  routes: registerWebRoutes,
})
```

セッションと OAuth state のストアをサービスプロバイダで設定しているアプリも、そのまま動きます。[サービスプロバイダを使うアプリ](./configuration.md#サービスプロバイダを使うアプリ) を参照してください。

どちらのストアにもテーブルが必要です。`sessions` は `bunx guren add session` で生成でき、`oauth_states` のカラムは [Stateストレージ](./oauth.md#stateストレージ) に載っています。`bunx guren make:auth --oauth` を使えば、両方のテーブルの生成と両方のストアの組み込みがまとめて済みます。

## ストレージ（R2）

Workers にはファイルシステムがないので、`local` ストレージドライバは動きません。代わりに `R2Driver` を使うと、Cloudflare R2 のバケットをバケットバインディング経由で、`StorageManager` の同じ API から扱えます。用意する資格情報はなく、AWS SDK もバンドルに入りません。

バケットを作ってバインドします。

```bash
bunx wrangler r2 bucket create my-app-media
```

```jsonc
// wrangler.jsonc
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "my-app-media" }
]
```

次に、`config/storage.ts` で `media` を既定のディスクにします。

```typescript
// config/storage.ts
import { defineStorageConfig } from '@guren/core'

export default defineStorageConfig(() => ({ default: 'media' }))
```

ストレージの設定で指定できるドライバは、組み込みの `local`・`s3`・`memory` だけです。そのため、ディスク自体はプロバイダの `register()` の中で、バインド済みのマネージャに登録します。Workers 上では R2 を、それ以外ではローカルのファイルシステムを使います。ランタイムの判定は、`config/database.ts` が D1 の切り替えに使っているものと同じです。

```typescript
// app/Providers/MediaDiskProvider.ts
import { ServiceProvider, LocalStorageDriver } from '@guren/core'
import { R2Driver } from '@guren/plugin-cloudflare'
import { getWorkersEnv, isWorkersRuntime } from '@guren/plugin-cloudflare/env'

interface Env {
  MEDIA: unknown
}

export default class MediaDiskProvider extends ServiceProvider {
  register(): void {
    this.container.make('storage').registerDisk('media', () =>
      isWorkersRuntime()
        ? new R2Driver({
            binding: () => getWorkersEnv<Env>().MEDIA,
            publicUrl: 'https://media.example.com',
          })
        : new LocalStorageDriver({ root: './storage/app/public', url: '/storage' }),
    )
  }
}
```

`storage` を `createApp({ config })` に、`MediaDiskProvider` を `providers` に加えてください。

`binding` も値ではなく、値を返す関数です。バインディングは最初のリクエストと一緒に届くので、D1 のバインディングと同じく読み取りを後回しにする必要があります。これで、[ストレージガイド](./storage.md)にある `storage.disk('media').put(...)` / `get(...)` / `files(...)` がそのまま動きます。`bun run dev` ではディスクに、`wrangler dev` と本番では R2 に書き込みます。

R2 は S3 と仕組みが違うため、次の 3 点で挙動が異なります。

- **`url()` を使うには `publicUrl` が必要です。** ダッシュボードでバケットにカスタムドメインを割り当て（r2.dev のサブドメインはレート制限があり、開発向けです）、そのドメインを `publicUrl` に渡してください。R2 には公開 URL を組み立てる規則がないので、設定しないと `url()` は例外を投げます。
- **`temporaryUrl()` には S3 の資格情報が必要です。** バインディングでは URL に署名できません。`presign: { accountId, bucket, accessKeyId, secretAccessKey }`（R2 の API トークン）を渡すか、非公開のファイルはアプリの認証付きルートを通して配信してください。`presign` がないと、`temporaryUrl()` はこの対処法を示して例外を投げます。
- **可視性はオブジェクトごとではなく、バケットごとに決まります。** バケットは公開（カスタムドメイン / r2.dev）か非公開のどちらかで、オブジェクトごとの ACL はありません。ドライバはバケットの `visibility`（`publicUrl` があれば既定は `'public'`）を返します。`put({ visibility })` や `setVisibility()` で逆の値を指定されたときは、対応できたふりをせずに例外を投げます。

Workers には読み取れるローカルファイルがないので、`putFile()` も例外を投げます。バイト列は自分で読み込み（`await file.arrayBuffer()`）、`put()` を呼んでください。一度きりの一括投入なら、手元のマシンから `bunx wrangler r2 object put my-app-media/<key> --file <path>` を実行するほうが簡単です。

Bun のプロセス（スクリプトや、Workers 以外へのデプロイ）から同じバケットを使う場合は、S3 互換のエンドポイントと S3 ドライバを使います。`endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com'`、`region: 'auto'`、R2 の API トークンを組み合わせます。詳しくは[ストレージガイド](./storage.md#s3互換サービス)を参照してください。

### Workers でのアタッチメント

[アタッチメントレイヤー](./attachments.md)は Workers でも動きます。ただし Workers には画像デコーダがないため、画像の処理だけはリクエストの中で行わず、キューのワーカーに任せます。

- **同期的なチェックは Worker の中でそのまま走ります。** バイト数の超過(413)、`maxPixels` を超えるヘッダの寸法(422)、HEIC のシグネチャ(415)、`image: 'require'` のコレクションに渡された画像以外のファイル(422)は、どれもリクエストの中で拒否されます。これらは純粋な JavaScript で書かれていて、デコーダを必要としません。
- **`queued: true` でアタッチします。** Worker はオリジナルを保存し、宣言したバリアントを `pending` として記録して、Redis を使うキュー(`RedisQueueDriver`。キューガイドで Workers に必要としているストアと同じもの)に `GenerateVariantsJob` をディスパッチします。ジョブが終わるまで、バリアントの URL はオリジナルにフォールバックします。
- **ワーカーは Bun で動かします。** 別プロセスの Bun(`Bun.Image` あり)がキューを処理し、後回しにしたフルデコード、HEIC の変換(有効にしたコレクションのみ)、バリアントの生成を行います。ジョブは `configureAttachments()` が登録するので、アプリの config を読み込んで起動するワーカーなら、ほかに何も組み込まなくても処理できます。
- **private なアタッチメントは、署名配信ルートを使えばバインディングだけで配信できます。** `configureAttachments()` でディスクを private と宣言し、ルートを有効にしてください: `disks: { media: 'private' }, delivery: {}`（宣言していないディスクは **public** として扱われ、`publicUrl` を設定したバケットも既定で public です）。さらにルート登録関数で `registerAttachmentRoutes(router)` をマウントすると、private なアタッチメントの URL はパス相対の署名付き URL になり、ルートが `get().body` を Worker 経由でストリーム配信します。`presign` の資格情報は要りません。`presign` を設定すると、ドライバが `capabilities.presignedGet` を宣言するので、同じルートが有効期間の短い presigned URL への 302 リダイレクトで応答するようになります。R2 に固有の注意点として、R2 の S3 API は `response-content-*` によるヘッダの上書きを無視するので、リダイレクト先ではオブジェクトに保存済みのメタデータで配信されます。presign に対応した R2 ディスクで `Content-Disposition: attachment` を必ず付けたいアプリは、`serve: 'proxy'` を使ってください。public なアタッチメントはこれまでどおりバケットのカスタムドメインから配信されるので、Worker の CPU は使いません。

ヘッダの内容と中身が食い違うバイト列だけは、同期的なチェックでは見つけられず、受け付けたあとでワーカーが見つけます。`image: 'require'` のコレクションではジョブがそのアタッチメントをパージし、それ以外では中身を解釈しないファイルとして残ります。

## シークレット

`APP_KEY` は必須です。セッションと CSRF の署名に使うもので、設定されていないとワーカーは起動時に例外を投げ、リクエストを 1 件も処理しないまま止まります。

```bash
bun -e "console.log('base64:'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))" | bunx wrangler secret put APP_KEY
```

アプリが読むほかの値（OAuth の認証情報、API キーなど）も同じ方法で設定し、それぞれを `config/env.ts` で宣言します。vars とシークレットはワーカーのエントリポイントの `env` に渡され、`process.env` に入っているとは限りません。`@guren/plugin-cloudflare` がアプリのブート前にこの `env` をバインドし、スキーマはそこから値を読むので、アプリのコードはローカルと同じように検証済みの値を使えます（[設定](./configuration.md#cloudflare-workers)）。`wrangler.jsonc` の `vars` には、秘密ではない値だけを書いてください。

## 無料プランの制限

アプリの設計を左右する制限が 2 つあります。

| 制限 | 値 | 意味 |
|---|---|---|
| ワーカーサイズ | 非圧縮で 64 MiB（全プラン共通） | 生成するコンテンツはバンドルに入れず、Static Assets、KV、R2 に置く |
| リクエストあたりの CPU | 10 ミリ秒 | 重い処理はビルド時か保存時に回す |

Cloudflare は 2026-09-04 に圧縮後のサイズの上限（無料 3 MB、有料 10 MB）を撤廃し、いまは非圧縮のバンドルサイズだけを検査しています。アプリのサイズは `bunx guren cloudflare:size`（または `cloudflare:build --report-size`）で測れます。wrangler のドライランを実行し、パッケージごとの内訳を大きい順に表示するので、いつの間にかバンドルが膨らんでいたときの原因がそこで分かります。この数字には表れない制限もあり、起動時間（1 秒、`wrangler check startup`）とメモリ（isolate あたり 128 MB）がそれです。どちらも、大きなデータをバンドルすると消費されます。

この CPU 制限があるので、パスワードのハッシュ化は事実上できません。わざと遅くしてある処理を 10 ミリ秒に収めるのは無理だからです。無料プランでは、パスワードではなく OAuth で認証してください。OAuth のフローは[認証ガイド](./authentication.md)で説明しています。

この制限の下では、リクエスト時の処理を減らす設計が有利です。Markdown の変換は読み取り時ではなく保存時に行い、静的なコンテンツはビルド時にレンダリングしておきます。それでも処理時間がどうしても足りない場合は、有料プランにすると CPU の制限が緩和されます。

## 可観測性

Workers は、既定ではログを保持しません。そのままだと、本番で問題が起きたときに原因を追うのが非常に難しくなります。

```jsonc
{
  "observability": {
    "enabled": true
  }
}
```

問題を再現しながらリアルタイムで出力を見たいときは、`bunx wrangler tail` も併せて使ってください。

## ローカル開発

`wrangler dev` は、ローカルの D1 を相手に本物のランタイムを動かします。Bun の開発サーバーでは見つけられないランタイムの違いを拾えるので、デプロイ前に一度は試しておく価値があります。

```bash
bunx wrangler d1 migrations apply my-app --local
bunx wrangler dev
```

ローカル用のシークレットは `.dev.vars` に置きます（`.gitignore` への追加も忘れずに）。

```
APP_KEY=base64:...
```

日々の開発では、通常の `bun run dev` のほうが速く回せます。`wrangler dev` は、デプロイの直前や、本番でだけ挙動が違うときに使ってください。

## 静的アセット

`public/` の下のファイルはすべて `.cloudflare/assets/` にステージングされ、Workers Static Assets から配信されます。Static Assets はワーカーが動くより**前**に応答するので、ビルドが次の 2 点に対処します。

- ステージングしたファイルと同じ場所に `_headers` を生成し、ブラウザがドキュメントとして描画する形式 (`.html`、`.htm`、`.svg`、`.xhtml`、`.xml`) に `Content-Disposition: attachment` と `X-Content-Type-Options: nosniff` を付けます。フレームワークがローカルで `public/` に適用しているのと同じ方針ですが、ここではワーカーにそれを適用する機会がないためです。画像・スクリプト・スタイルシート・フォントは対象外です。`public/` に自分で `_headers` を置いている場合、そのファイルは残り、生成されたルールはその前に挿入されます。プラットフォームが読むルールは最大 100 件で、それを超えた分はエラーにならずに無視されるので、合わせて 100 件を超えるとビルドが警告を出します。また、照合は大文字と小文字を区別します。1 つのルールにスプラットは 1 つしか書けず、グロブでは回避できないため、`Logo.SVG` のようなファイルには専用のルールを生成します。拡張子を小文字で揃えているアプリなら、追加のルールは生成されません。
- `assets` バインディングに `"html_handling": "none"` を設定し、ステージングした `page.html` を `/page.html` でだけ配信します。プラットフォームの既定では `/page` でも応答するので、アプリにある同じ名前のルートを覆い隠してしまううえ、`_headers` のルールが照合するパスからファイルが外れてしまいます。ステージングしたファイルで応答できないリクエストはワーカーに渡り、アプリのページはそこから返されます。

`public/` の HTML を拡張子なしの URL で配信したい場合は、`wrangler.jsonc` に `"html_handling"` を自分で書いてください。値が書かれていれば、ビルドはそれに手を付けません。ただし、その分 `.html` のルールの効き目は弱くなります。

## 翻訳

Workers には `lang/` を読み込むファイルシステムがないので、ビルドが `lang/<locale>/*.json` をすべてワーカーに埋め込み、`createApp({ i18n })` はそこから翻訳を返します。JSON ファイルはいつもどおり編集し、ビルドし直してください。i18n の `path` オプションを指定しているアプリは対象外です。[サーバーレスとバンドルカタログ](./i18n.md#サーバーレスとバンドルカタログ)を参照してください。

## スケジュールタスク

生成されるワーカーは `fetch` と一緒に `scheduled` ハンドラも export するので、アプリが `createScheduler()` で登録したタスクは Cloudflare の cron トリガーから実行されます。Workers には scheduler を動かし続ける常駐プロセスがないため、`scheduler.start()` は実行されません。時間を進める役割はトリガーが受け持ちます。

用意するものは 2 つあります。1 つ目は、Bun サーバーのときとまったく同じ、タスクと、scheduler をバインドするプロバイダです。タスクを `app/Console/Kernel.ts` に宣言しておくと、`guren schedule:list` と `guren schedule:run` からも見えるようになります。必要なのはこのファイルに書くことだけで、書き方はこれらのコマンドが受け付ける 2 つの形のどちらでもかまいません（[CLIから見えるようにする](./scheduling.md#cliから見えるようにする)）。

```ts
// app/Console/Kernel.ts
import { Schedule, defaultContainer, type SessionManager } from '@guren/core'

export function scheduleTasksKernel(): Schedule {
  const schedule = new Schedule()

  // 解決はカーネルの構築時ではなくタスクの実行時です。`session` を束縛するのは
  // app.boot() で、cron のエントリポイントはそれを先に await します。
  schedule
    .call(() => defaultContainer().make<SessionManager>('session').pruneExpired())
    .hourly()
    .name('sessions:prune')

  return schedule
}
```

```ts
// app/Providers/SchedulingProvider.ts
import { ServiceProvider, createScheduler } from '@guren/core'
import { scheduleTasksKernel } from '../Console/Kernel.js'

export default class SchedulingProvider extends ServiceProvider {
  register(): void {
    this.container.singleton('scheduler', () => {
      // logger を渡さないと、例外を投げたタスクは捕捉されて捨てられます (後述)。
      const scheduler = createScheduler({ logger: console.log })
      for (const task of scheduleTasksKernel().buildTasks()) {
        scheduler.addTask(task)
      }
      return scheduler
    })
  }
}
```

2 つ目は、`wrangler.jsonc` に書くトリガーそのものです。トリガーはアプリにタスクがあってもなくても起動し、そのたびに課金されるので、ビルドはこれを生成しません。

```jsonc
{
  "triggers": { "crons": ["* * * * *"] }
}
```

トリガーが起動するたびに、その時刻に実行予定のタスクだけが実行されます。そのため、**トリガーの間隔がいちばん細かいタスクより粗いと、そのタスクは一度も実行されません**。たとえば `["0 * * * *"]` のトリガーと `.dailyAt('03:30')` のタスクでは、時刻が一致することがありません。トリガーをスケジュールの最小単位に合わせるか、トリガーが起動する時刻にだけタスクを組んでください。

Workers に固有の制約は次のとおりです。

- **`schedule.command()` は動きません。** `node:child_process` 経由でシェルに処理を渡しますが、Workers にはサブプロセスを実行する仕組みがありません。ビルドは通り、タスクを実行したときに失敗します。`schedule.call()` か `schedule.job()` を使い、処理を直接呼び出してください。上の例は、`sessions:prune` をプロセス内で実行する形で書いたものです。
- **`scheduler` のバインディングが見つからないと、トリガーは例外を投げます。** 何も掃除していないのに成功と報告することはありません。エラーメッセージに対処法が書かれていて、ほかのワーカーの例外と同じように `wrangler tail` に出ます。
- **タスク自身が投げた例外は、外に投げられません。** `runDueTasks()` はタスクごとに例外を捕まえて scheduler の `logger` に報告しますが、その既定値は何もしない関数です。そのため、D1 のエラーで定期処理が失敗しても成功として報告され、`wrangler tail` にも何も出ません。scheduler を作るときに `logger` を渡してください。
- **`preventOverlapping()` は、起動をまたいでは効きません。** これはタスクがメモリ上に持つフラグで、起動のたびに新しい isolate になる可能性があるためです。トリガーの間隔より時間のかかるタスクは、前回の実行と重なります。タスクを間隔より短く収めるか、isolate より長く残る場所にガードを置いてください。候補は D1 の行か、インスタンスごとの永続的な state と alarm によるスケジュールを持つ Durable Object です([永続エージェント](./durable-agents.md))。特定の identity を持たないアプリ全体の定期処理には cron トリガーが合います。一方、重なってはいけないジョブには identity があるので、Durable Object で表します。
- **`runOnOneServer()` には、isolate 間で共有する `SchedulerLock` が必要です。** 既定の `MemorySchedulerLock` は 1 つの isolate の中にしか存在しないので、ここでは何も守れません。スケジューラは警告を出したうえで、起動のたびにタスクを実行します。Workers には Redis がなく、KV には条件付きの書き込みがないので、`SchedulerLock` は一意キーへの D1 の INSERT か Durable Object を使って実装し、`createScheduler({ lock })` に渡してください。

`--mcp-oauth` を使ったワーカーでは、もう 1 つ掃除が走ります。タスクを実行する前に、前回の掃除から 1 時間たったかを毎回確かめ、たっていれば OAuth プロバイダの `purgeExpiredData` を呼びます。クライアントが削除されて取り残された付与記録（grant）には有効期限がなく、KV の TTL では消えないので、これを取り除けるのはこの掃除だけです。1 回の掃除では、まず付与記録を最大 15 件調べ、続く 2 回目の呼び出しで token を最大 15 件調べます。プロバイダは付与記録を調べる段階で予算を使い切るとそこで戻ってしまい、その後ろの token まで一度も届かないので、呼び出しを 2 回に分けています。どちらも毎回キー空間の先頭から調べます。プロバイダのカーソルは呼び出しをまたいで残らないため、その範囲より後ろのレコードには届きません。途中で打ち切られた場合は、その旨が `wrangler tail` に出ます。Free プランでは 1 回の起動で使えるサブリクエストが 50 までで、KV の読み取りもそこに数えられます。しかもこの予算はアプリ自身のタスクと分け合うので、件数をここまで小さくしています。ワーカーの側からは、どのプランで動いているかを判別できません。掃除が失敗してもログに出るだけで、その回は済んだものとして次の間隔まで待ち、アプリのタスクは止まりません。

この掃除にも、ほかと同じく `triggers.crons` のエントリが必要です。掃除のためだけにトリガーを追加する場合でも `scheduler` のバインドは必要で、ないと毎回の起動で、掃除のあとに上で説明した例外が投げられます。

## 永続エージェント

Workers は、アプリケーションが自分でホストするエージェントの基盤にもなります。Durable Object を使うと、長く動き続けるエージェントに、永続的な identity、永続的な state、alarm によるスケジュールを持たせられます。`@guren/plugin-agents` は、それらを、ルートですでに宣言しているエージェントツールの裏側に置きます。

アプリに `config/agents.ts` があると、`cloudflare:build` は次の 3 つを追加で行います。1 つ目は、登録されたクラスごとの名前付き export を生成ワーカーに追記することです。2 つ目は、コミット済みの `wrangler.jsonc` がそれぞれのクラスを SQLite をバックエンドにした Durable Object としてホストしているかの検証です。足りなければ、バインディングのないままデプロイすることはせず、追記すべき JSON をそのまま出力して失敗します。3 つ目は、`/agents/*` を、レジストリ自身の authorizer の後ろにすべて拒否する設定でマウントすることです。`durable_objects` と `migrations` のエントリは手で書かず、ビルドを実行してその出力を貼り付けてください。

デプロイしたエージェントの無料プランでの実測値、1 回の定期処理で使える D1 クエリの予算、そのほかエージェントの書き方全般は[永続エージェント](./durable-agents.md)にまとめてあります。

## 既存アプリの更新

`wrangler.jsonc` は最初に 1 度だけ生成され、それ以降は上書きされません。そのため、プラグインを更新する前に作ったアプリは、元の設定のまま残ります。古い設定を見つけると、ビルドが足りない項目を具体的に出力するので、それを追記してビルドし直してください。

ただし、`triggers.crons` だけは出力しません。アプリがスケジュールタスクを登録しているかどうかは、スケジュールカーネルを見つけて読み込めたビルドにしか分からず、ほかの書き方で宣言したタスクは「ない」と判断されてしまうからです。そのため、ビルドは推測で出力することはせず、何も言いません。タスクがあって Workers でも動かしたい場合は、トリガーを手で追記してください（[スケジュールタスク](#スケジュールタスク)）。

## デプロイ後

- Cloudflare のダッシュボードでワーカーに独自ドメインを割り当て、あわせて OAuth のコールバック URL も更新します。
- 監視とインシデント対応については[本番運用ランブック](./operations.md)を参照してください。
