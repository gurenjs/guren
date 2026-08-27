# Cloudflare Workers へのデプロイ

Guren は `@guren/plugin-cloudflare` を通じて Cloudflare Workers 上で動作し、データベースには D1 を使います。このガイドでは、まっさらなアカウントからデプロイ完了までを一通り扱います。

Workers は常駐サーバーとは形の違うランタイムです。ファイルシステムがなく、リクエスト間でメモリを共有せず、CPU 時間はミリ秒単位で区切られています。このガイドの大部分は、その違いがアプリの設定に影響する数か所についての説明です。

## インストール

```bash
bunx guren plugin @guren/plugin-cloudflare
bun add @guren/plugin-cloudflare
```

プラグインは `cloudflare:build` コマンドを登録し、初回ビルド時に `wrangler.jsonc` を生成します。

## ビルドとデプロイ

```bash
bunx guren cloudflare:build
bunx wrangler deploy
```

`cloudflare:build` はアプリの `build` スクリプトを実行したあと、ワーカーのエントリポイント・静的アセット・平坦化したマイグレーションを含む `.cloudflare/` ディレクトリを組み立てます。古いワーカーをデプロイしてしまわないよう、両方を 1 つのスクリプトにまとめておきましょう。

```json
{
  "scripts": {
    "cloudflare:build": "bun run build && bunx guren cloudflare:build --skip-app-build",
    "deploy:cloudflare": "bun run cloudflare:build && bunx wrangler deploy"
  }
}
```

> [!IMPORTANT]
> `.cloudflare/` は生成物です。`.gitignore` に追加し、デプロイのたびに作り直してください。他のどこからも参照されないため、古いままだと気づかずに古いコードがデプロイされます。

## データベース（D1）

データベースを作成し、その ID を `wrangler.jsonc` に記録します。

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

ドライバはランタイムによって `config/database.ts` で切り替えます。D1 は SQLite 互換なので、スキーマは SQLite のダイアレクトで書き、開発時はローカルの SQLite ファイルを使います。

```typescript
import { createD1Database, createSqliteDatabase } from '@guren/core'
import { getWorkersEnv } from '@guren/plugin-cloudflare'

interface WorkersEnv {
  DB: unknown
}

export function isWorkersRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
}

const database = isWorkersRuntime()
  ? createD1Database({ binding: () => getWorkersEnv<WorkersEnv>().DB })
  : createSqliteDatabase({
      migrationsFolder: new URL('../db/migrations', import.meta.url),
      filename: () => process.env.SQLITE_DATABASE_PATH ?? './data/guren.db',
    })

export const { getDatabase, configureOrm, seedDatabase } = database
```

バインディングは値ではなく解決関数として渡します。バインディングはリクエストが届いて初めて存在するため、遅延して読み取る必要があります。

### マイグレーションの適用

マイグレーションはアプリの外側で適用します。Workers 上でアプリが自分でマイグレートすることはありません。

```bash
bunx guren cloudflare:build          # .cloudflare/d1-migrations を再生成
bunx wrangler d1 migrations apply my-app --remote
```

> [!WARNING]
> 先にビルドしてください。`migrations_dir` は生成ディレクトリの中を指しているため、空のフォルダを見つけた `wrangler` は「適用するマイグレーションはありません」と**エラーではなく正常終了で**報告します。ビルド前に適用してしまうと、失敗が成功のように見えます。

モデルの初期化では、ファイルシステムの確認を Workers 上では飛ばします（確認する対象が存在しないため）。

```typescript
export async function bootModels(): Promise<void> {
  await configureOrm()
  if (!isWorkersRuntime()) {
    await seedDatabase()
  }
}
```

## セッションと OAuth state はデータベースに保存する

これは好みの問題ではありません。各リクエストは別々の isolate に到達しうるうえ、isolate 同士はデータベース以外に何も共有しません。メモリ実装のままでもローカルでは動いているように見え、本番でセッションが毎回消えます。

```typescript
import { createApp, AuthServiceProvider, DatabaseSessionStore } from '@guren/core'
import { sessions } from '../db/schema.js'

const app = createApp({
  providers: [AuthServiceProvider],
  auth: {
    autoSession: true,
    sessionOptions: {
      store: new DatabaseSessionStore(sessions),
      cookieSecure: true,
    },
  },
})
```

OAuth も同様です。認可へのリダイレクトと、そこから戻ってくるコールバックは別の isolate に届くのが普通なので、両者を結びつける state は共有された場所に置く必要があります。

```typescript
import { createOAuthManager, DatabaseOAuthStateStore } from '@guren/core'
import { oauthStates } from '../db/schema.js'

const oauth = createOAuthManager({
  stateStore: new DatabaseOAuthStateStore(oauthStates),
})
```

どちらのストアもテーブルを必要とします。スキーマは[認証ガイド](./authentication.md)を参照してください。

## ストレージ（R2）

Workers にはファイルシステムが無いため、`local` ストレージドライバは動きません。`R2Driver` は Cloudflare R2 バケットをバケットバインディング経由で `StorageManager` の同じ API の背後に置きます。用意する資格情報は無く、AWS SDK もバンドルに入りません。

バケットを作ってバインドします:

```bash
bunx wrangler r2 bucket create my-app-media
```

```jsonc
// wrangler.jsonc
"r2_buckets": [
  { "binding": "MEDIA", "bucket_name": "my-app-media" }
]
```

次に、Workers 上では R2、それ以外ではローカルファイルシステムを使うディスクを登録します。`config/database.ts` が D1 に使っているのと同じランタイム判定です:

```typescript
// app/Providers/StorageProvider.ts
import { ServiceProvider, createStorageManager, LocalStorageDriver } from '@guren/core'
import { R2Driver, getWorkersEnv } from '@guren/plugin-cloudflare'
import { isWorkersRuntime } from '../../config/database.js'

interface Env {
  MEDIA: unknown
}

export default class StorageProvider extends ServiceProvider {
  register(): void {
    const storage = createStorageManager({ default: 'media' })
    storage.registerDisk('media', () =>
      isWorkersRuntime()
        ? new R2Driver({
            binding: () => getWorkersEnv<Env>().MEDIA,
            publicUrl: 'https://media.example.com',
          })
        : new LocalStorageDriver({ root: './storage/app/public', url: '/storage' }),
    )
    this.container.instance('storage', storage)
  }
}
```

`binding` は値ではなくリゾルバです。バインディングは最初のリクエストと共に届くので、D1 バインディングと同じく遅延して読む必要があります。あとは[ストレージガイド](./storage.md)の `storage.disk('media').put(...)` / `get(...)` / `files(...)` がそのまま動きます。`bun run dev` はディスクに、`wrangler dev` と本番は R2 に書き込みます。

R2 と S3 の違いから、次の3点が異なります:

- **`url()` には `publicUrl` が必須です。** ダッシュボードでバケットにカスタムドメインを割り当て（r2.dev サブドメインはレート制限付きで開発向けです）、それを `publicUrl` に渡してください。R2 には導出できる公開 URL が無いため、未設定だと `url()` は例外を投げます。
- **`temporaryUrl()` には S3 資格情報が必要です。** バインディングは URL に署名できません。`presign: { accountId, bucket, accessKeyId, secretAccessKey }`（R2 API トークン）を渡すか、非公開ファイルはアプリの認証付きルート越しに配信してください。`presign` が無い場合、`temporaryUrl()` はその案内付きで例外を投げます。
- **可視性はオブジェクト単位ではなくバケット単位です。** バケットは公開（カスタムドメイン / r2.dev）か非公開かのどちらかで、オブジェクトごとの ACL はありません。ドライバはバケットの `visibility`（`publicUrl` があれば既定 `'public'`）を報告し、`put({ visibility })` や `setVisibility()` で逆の値を求められた場合は、できるふりをせず例外を投げます。

`putFile()` も例外を投げます。Workers には読み取れるローカルファイルがありません。自分でバイト列を読み（`await file.arrayBuffer()`）、`put()` を呼んでください。一度きりの一括投入なら、手元から `bunx wrangler r2 object put my-app-media/<key> --file <path>` の方が簡単です。

Bun プロセス（スクリプトや Workers 以外のデプロイ）から同じバケットに到達するには、代わりに S3 互換エンドポイントと S3 ドライバを使います。`endpoint: 'https://<ACCOUNT_ID>.r2.cloudflarestorage.com'`、`region: 'auto'`、R2 API トークンの組み合わせで、[ストレージガイド](./storage.md#s3互換サービス)を参照してください。

### Workers でのアタッチメント

[アタッチメントレイヤー](./attachments.md)は Workers でも動きます。分担が1つだけあります: Workers には画像デコーダがないため、画像処理はリクエストパスではなくキューワーカーで行います。

- **同期ゲートは Worker 内でそのまま走ります。** バイト数超過(413)、`maxPixels` を超えるヘッダ寸法(422)、HEIC シグネチャ(415)、`image: 'require'` コレクションへの非画像(422)は、いずれもリクエスト内で拒否されます。純粋な JavaScript で、デコーダは不要です。
- **`queued: true` でアタッチします。** Worker はオリジナルを保存し、宣言済みバリアントを `pending` として記録し、Redis ベースのキュー(`RedisQueueDriver`。キューガイドが Workers に求めるストアと同じ)へ `GenerateVariantsJob` をディスパッチします。ジョブが完了するまで、バリアント URL はオリジナルへフォールバックします。
- **ワーカーは Bun で動かします。** 別プロセスの Bun(`Bun.Image` あり)がキューを処理します: 先送りしたフルデコード、オプトイン済みコレクションの HEIC 変換、バリアント生成を行います。`configureAttachments()` がジョブを登録するため、アプリの config を起動するワーカーなら追加配線なしで処理できます。
- **private アタッチメントは署名配信ルートによりバインディングだけで動きます。** `configureAttachments()` でディスクを private と宣言しルートを有効化してください: `disks: { media: 'private' }, delivery: {}`（未宣言のディスクは **public** 扱いで、`publicUrl` 付きのバケットもデフォルトで public です）。加えてルート登録関数で `registerAttachmentRoutes(router)` をマウントすると、private アタッチメントはパス相対の署名付き URL になり、ルートが `get().body` を Worker 経由でストリーム配信します。`presign` 資格情報は不要です。`presign` を設定した場合はドライバが `capabilities.presignedGet` を宣言し、同じルートが短寿命の presigned URL への 302 リダイレクトに昇格します。R2 固有の注意: R2 の S3 API は `response-content-*` ヘッダオーバーライドを無視するため、リダイレクトはオブジェクトの保存済みメタデータで配信されます。presign 対応の R2 ディスクで `Content-Disposition: attachment` を強制したいアプリは `serve: 'proxy'` を使ってください。public のアタッチメントは従来どおりバケットのカスタムドメインから配信され、Worker の CPU を使いません。

同期ゲートが捕まえられない唯一のクラス、つまりヘッダで嘘をつくバイト列は、受理後にワーカーが検出します: `image: 'require'` コレクションではジョブがアタッチメントをパージし、それ以外では不透明ファイルとして残ります。

## シークレット

`APP_KEY` は必須です。セッションと CSRF の署名に使われ、これが無いとワーカーは起動時に例外を投げます。リクエストを 1 件も処理しないまま落ちます。

```bash
bun -e "console.log('base64:'+Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'))" | bunx wrangler secret put APP_KEY
```

アプリが読む他の値（OAuth の認証情報、API キーなど）も同じ方法で設定します。`wrangler secret put` で設定した値は実行時に `process.env.*` から参照できます。`wrangler.jsonc` の `vars` に書いてよいのは、秘密でない値だけです。

## 無料プランの制限

アプリの設計に影響する制限が 2 つあります。

| 制限 | 値 | 意味 |
|---|---|---|
| ワーカーサイズ | 3 MB（gzip 後） | 生成コンテンツが大きい場合は予算との兼ね合いを検討する |
| リクエストあたり CPU | 10 ミリ秒 | 重い処理はビルド時か保存時に寄せる |

この CPU 制限により、パスワードハッシュは事実上不可能です。意図的に遅くしてある処理を 10 ミリ秒に収めることはできません。無料プランでは、パスワードではなく OAuth による認証を選んでください。フローは[認証ガイド](./authentication.md)を参照してください。

同じ制約は「リクエスト時の仕事を減らす」設計を後押しします。Markdown の変換は読み取り時ではなく保存時に行い、静的なコンテンツはビルド時にレンダリングしておきます。処理内容がどうしても必要とする場合は、有料プランで CPU 制限が緩和されます。

## 可観測性

Workers は既定ではログを保持しません。本番で問題が起きたときの追跡が非常に困難になります。

```jsonc
{
  "observability": {
    "enabled": true
  }
}
```

再現しながらリアルタイムで見たい場合は `bunx wrangler tail` と併用してください。

## ローカル開発

`wrangler dev` はローカルの D1 を相手に実際のランタイムを動かします。Bun の開発サーバーでは検出できないランタイム差異を拾えるため、デプロイ前に一度通しておく価値があります。

```bash
bunx wrangler d1 migrations apply my-app --local
bunx wrangler dev
```

ローカル用のシークレットは `.dev.vars` に置きます（`.gitignore` への追加も忘れずに）。

```
APP_KEY=base64:...
```

日々の開発では通常の `bun run dev` の方が速く回せます。`wrangler dev` は、デプロイ直前や、本番でだけ挙動が違うときに使ってください。

## 既存アプリの更新

`wrangler.jsonc` は初回のみ生成され、その後は上書きされません。そのため、プラグイン更新前に作られたアプリは元の設定を保ち続けます。古い設定を検出すると、ビルドが不足している項目を具体的に出力するので、それを追記して再ビルドしてください。

## デプロイ後

- Cloudflare のダッシュボードでワーカーに独自ドメインを割り当て、OAuth のコールバック URL も併せて更新します。
- 監視とインシデント対応については[本番運用ランブック](./operations.md)を参照してください。
