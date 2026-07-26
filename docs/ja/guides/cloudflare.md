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

function isWorkersRuntime(): boolean {
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
