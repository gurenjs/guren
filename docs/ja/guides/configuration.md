# 設定

Guren アプリの設定は `config/` に置きます。ここに置くファイルは 2 種類です。

- `config/env.ts` は、アプリが読む環境変数をすべて、型と必須かどうかを付けて宣言します。検証はアプリの起動時に 1 回だけ行われます。
- `config/<service>.ts`（`database`、`cache`、`mail`、`session` など）は、検証済みの値からサービスの設定を組み立てます。どれも *config 定義* を default export します。

どちらもただのデータです。import しただけでは接続も登録も起きず、それを行うのは `createApp()` です。

```ts
// src/app.ts
import { createApp } from '@guren/core'
import cache from '../config/cache.js'
import database from '../config/database.js'
import env from '../config/env.js'
import http from '../config/http.js'
import { registerWebRoutes } from '../routes/web.js'

const app = createApp({
  env,
  config: [database, http, cache],
  routes: registerWebRoutes,
})

export default app
```

`create-guren-app` はこの形で生成します。`guren add cache`、`guren add mail`、`guren add queue`、`guren add storage`、`guren add session`、`guren add oauth` は、`config/env.ts` があれば、それぞれの定義を `config` 配列に追加します（[サービスプロバイダを使うアプリ](#サービスプロバイダを使うアプリ) を参照）。

## 環境変数を宣言する

`config/env.ts` は `defineEnv()` のスキーマを default export します。

```ts
// config/env.ts
import { defineEnv, Env, type InferEnv } from '@guren/core'

const env = defineEnv({
  APP_KEY: Env.string().secret().requiredInProduction()
    .describe('Signs cookies and encrypts session payloads.'),
  APP_URL: Env.url().requiredInProduction(),
  PORT: Env.port().default(3333),
  DATABASE_URL: Env.string().optional(),
  CACHE_STORE: Env.string().default('memory'),
  LOG_LEVEL: Env.enum(['debug', 'info', 'warn', 'error']).default('info'),
})

export default env

declare module '@guren/core' {
  interface AppEnv extends InferEnv<typeof env> {}
}
```

`declare module` のブロックで、検証済みの値に型が付きます。定義の中、コントローラの `this.make('env')`、データベースの接続リゾルバのどこで読んでも同じ型です。

### 型

| ビルダー | 受け付ける値 | 値の型 |
|---|---|---|
| `Env.string()` | 任意 | `string` |
| `Env.url()` | `new URL()` が解釈できる文字列 | `string` |
| `Env.number()` | 有限の数値 | `number` |
| `Env.port()` | 1 から 65535 の整数 | `number` |
| `Env.boolean()` | `true`、`false`、`1`、`0`（大文字小文字は問わない） | `boolean` |
| `Env.enum([...])` | 列挙した文字列のいずれか | その union 型 |
| `Env.custom(schema)` | 同期の Standard Schema（Zod、Valibot）が受け付ける値 | スキーマの出力型 |

### 必須かどうか

修飾子を付けない変数は必須です。

| 修飾子 | 変数が未設定のとき |
|---|---|
| なし | 起動に失敗する |
| `.optional()` | 値は `undefined` |
| `.default(value)` | 値は `value` |
| `.requiredInProduction()` | `NODE_ENV` が `production` なら起動に失敗し、それ以外では `undefined` |

**空の値は未設定として扱われます。** `.env` の `REDIS_URL=` は、その行が無いのと同じです。デフォルトがあればそれが使われ、必須の変数なら起動に失敗します。`.env.example` は空の値を載せることが多く、ホスティングの管理画面で値を消した変数も空になります。空文字列そのものに意味がある場合は `.allowEmpty()` を付けてください。表示名をあえて空にしたメール送信者名がその例です。

`.secret()` を付けると、値がエラーメッセージに出なくなり、`guren env:example` はそのキーを空で書きます。`.describe(text)` の文は `.env.example` でキーの上のコメントになります。

### 検証に失敗したとき

起動は止まり、問題がまとめて表示されます。

```text
[guren] Invalid environment (2 problems):
  APP_KEY  required, not set
  PORT     "80a" is not a port
```

### 宣言できない変数

`NODE_ENV` と `GUREN_*` の変数は `process.env` から直接読むもので、`defineEnv()` に含めると例外になります。デプロイ用のビルドは `process.env.NODE_ENV` という式そのものをバンドル時に置き換えるので、検証済みの値を経由するとこの置き換えが効きません。`GUREN_MCP` や `GUREN_DOCS` などの `GUREN_*` はフレームワーク側のゲートで、アプリのスキーマに左右されてはいけません。

## config 定義

定義は検証済みの env を受け取り、サービスの設定を返します。

```ts
// config/cache.ts
import { defineCacheConfig } from '@guren/core'
import { createRedisClient } from '@guren/core/redis'

export default defineCacheConfig((env) => ({
  default: env.CACHE_STORE,
  stores: {
    memory: { driver: 'memory' },
    // A function, so the client is built only when CACHE_STORE selects this store.
    redis: { driver: 'redis', client: () => createRedisClient({ url: env.REDIS_URL }) },
  },
}))
```

| ヘルパー | バインドするキー | 設定内容 |
|---|---|---|
| `defineDatabaseConfig(database, { seedOnBoot })` | `database` | 起動時に ORM を接続し、`seedOnBoot` が true でマイグレーションがあればシードも実行する |
| `defineHttpConfig` | （HTTP カーネル） | `hostAuthorization` |
| `defineSessionConfig` | `session` | `SessionConfig` |
| `defineCacheConfig` | `cache` | `CacheConfig` |
| `defineMailConfig` | `mail` | `MailConfig` |
| `defineQueueConfig` | `queue` | `QueueConfig` |
| `defineStorageConfig` | `storage` | `StorageConfig` |
| `defineOAuthConfig` | `oauth` | `providers` と、任意の `stateStore` |

`createApp()` は、アプリのプロバイダより前に `ConfigServiceProvider` を登録します。このプロバイダは `register()` で env を検証して各定義のマネージャをバインドし、`boot()` では他のどのプロバイダよりも先に定義の起動処理（データベース接続）を実行します。そのため、アプリのプロバイダは自分の `register()` の中で `cache` や `mail` を解決できます。`config` 配列の順番にも意味はありません。

**1 つのキーを設定できるのは 1 か所だけです。** 定義とプロバイダの両方が `cache` をバインドすると、どちらかが黙って勝つのではなく、両方の名前を挙げて起動に失敗します。サービスを定義に移したら、そのプロバイダは削除してください。

名前のチェックは定義の中で行います。マネージャはどんなストア名でも受け付け、実際に使われた時点で例外を投げます。それが数時間後のキューのジョブということもあるので、cache、queue、mail、storage の scaffold は起動時に確認しています。

```ts
// config/queue.ts
import { defineQueueConfig, MemoryDriver, SyncDriver } from '@guren/core'

const drivers = {
  sync: () => new SyncDriver(),
  memory: () => new MemoryDriver(),
}

export default defineQueueConfig((env) => {
  if (!Object.hasOwn(drivers, env.QUEUE_CONNECTION)) {
    throw new Error(
      `QUEUE_CONNECTION="${env.QUEUE_CONNECTION}" is not a declared driver. Declare it in config/queue.ts or use one of: ${Object.keys(drivers).join(', ')}.`,
    )
  }

  return { default: env.QUEUE_CONNECTION, drivers }
})
```

条件付きの設定は、コールバックの中に普通のコードとして書きます。

```ts
// config/oauth.ts
import { defineOAuthConfig, type OAuthProviderConfig, createGitHubOAuthProviderConfig } from '@guren/core'

export default defineOAuthConfig((env) => {
  const providers: Record<string, OAuthProviderConfig> = {}

  if (env.OAUTH_GITHUB_CLIENT_ID && env.OAUTH_GITHUB_CLIENT_SECRET && env.OAUTH_GITHUB_REDIRECT_URI) {
    providers.github = createGitHubOAuthProviderConfig({
      clientId: env.OAUTH_GITHUB_CLIENT_ID,
      clientSecret: env.OAUTH_GITHUB_CLIENT_SECRET,
      redirectUri: env.OAUTH_GITHUB_REDIRECT_URI,
    })
  }

  return { providers }
})
```

## データベース接続

`config/database.ts` の名前付き export はそのまま残します。`guren db:migrate` と `guren db:seed` が、アプリを起動せずにこれらを import するためです。接続リゾルバは、アプリの起動時には検証済みの env を受け取り、CLI から呼ばれたときは自分でスキーマを解析します。

```ts
// config/database.ts
import { createPostgresDatabase, defineDatabaseConfig } from '@guren/core'
import env from './env.js'

const database = createPostgresDatabase({
  migrationsFolder: new URL('../db/migrations', import.meta.url),
  seedersFolder: new URL('../db/seeders', import.meta.url),
  connectionString: (context) => (context?.env ?? env.parse(undefined, { mode: 'report' }).values).DATABASE_URL
    ?? 'postgres://guren:guren@localhost:54322/guren',
})

export const { getDatabase, migrateDatabase, closeDatabase, configureOrm, seedDatabase } = database

export default defineDatabaseConfig(database, { seedOnBoot: process.env.NODE_ENV !== 'production' })
```

`mode: 'report'` は例外を投げず、検証できた値を返します。そのため本番で `guren db:migrate` を実行しても、データベースに接続するためだけに `APP_KEY` を求められることはありません。

## `.env.example` をそろえる

変数の一覧は `config/env.ts` が持ち、`.env.example` にも同じキーが並ぶようにします。

```bash
bunx guren env:example
```

このコマンドは、宣言済みで `.env.example` に無いキーを末尾に追加します。値にはデフォルト（シークレットは空）が入り、説明はコメントになります。すでにある行は書いたとおりに残ります。

```bash
bunx guren check --env
```

このコマンドは、2 つのファイルのキーがどちら向きにでも食い違っていれば失敗するので、CI のゲートに使えます。オプションなしの `guren check` も同じ比較を行い、あわせて `createApp({ config })` に並んでいない `config/<name>.ts` も報告します。

## コードから環境変数を読む

`process.env` ではなく、コンテナから検証済みの値を読みます。

```ts
import { Controller } from '@guren/core'

export default class AdminController extends Controller {
  async index() {
    const { ADMIN_EMAIL } = this.make('env')
    // ...
  }
}
```

scaffold したアプリでは、lint ルール `guren/no-unvalidated-env-read` が `app/`、`config/`、`routes/`、`src/`、`modules/` の中の `process.env.X` を報告します。`X` が `NODE_ENV` や `GUREN_*` なら対象外です。`bin/` と `drizzle.config.ts` はアプリより先に動くので対象にしていません。意図して直接読む箇所は、その行でルールを無効にし、理由を書きます。

```ts
// oxlint-disable-next-line guren/no-unvalidated-env-read -- CI switch, not app config
const secureCookies = process.env.NODE_ENV === 'production' && !process.env.CI
```

## Cloudflare Workers

Workers では、wrangler の `vars` とシークレットはエントリポイントの `env` 引数で渡され、`process.env` に入るとは限りません。`@guren/plugin-cloudflare` はアプリの起動前にこの引数をバインドし、スキーマはまずそこからキーを探し、無ければ `process.env` を読みます。同じ `config/env.ts` が、手を加えずにローカルでも Workers でも動きます。

## テスト

`TestApp.fromApp(app)` は実際の `src/app.ts` を定義ごと起動するので、機能テストは本番と同じ設定で動きます。

`process.env` を触らずに変数を 1 つだけ差し替えたいときは、スキーマと上書きする値を `TestApp.create()` に渡します。`envSource` は `process.env` より先に読まれ、`''` を渡すとその変数は未設定になります。

```ts
import { TestApp } from '@guren/testing'
import env from '../config/env.js'

const app = await TestApp.create({
  env,
  envSource: { CACHE_STORE: 'memory', APP_URL: '' },
  providers: [ReportProvider],
})
```

上書きした値が不正なら、`create()` は `EnvValidationError` で reject します。

## サービスプロバイダを使うアプリ

config 定義より前に作られたアプリは、サービスをプロバイダで設定しています（`CacheProvider`、`MailProvider`、`config/session.ts` を読む `SessionProvider` など）。これらはそのまま動き、移行は必須ではありません。移すときの手順は次のとおりです。

1. `config/env.ts` を追加し、プロバイダが読んでいる変数を宣言する。
2. 対応する `define*Config` ヘルパーで `config/<service>.ts` を書き、`process.env` の代わりに `env` を読む。
3. 同じ変更の中で、それを `createApp({ config })` に加え、プロバイダを `providers` から削除する。
4. `bunx guren env:example` と `bunx guren check` を実行する。

`config/env.ts` があり、そのキーをバインドするプロバイダが無ければ、次に `guren add <service>` で追加するサービスは定義の形で生成されます。
